import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Append only. Index + 1 is the schema version stored in PRAGMA user_version.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     ecosystems TEXT NOT NULL,
     package_manager TEXT,
     is_monorepo INTEGER NOT NULL,
     is_git_repo INTEGER NOT NULL,
     added_at INTEGER NOT NULL,
     last_opened_at INTEGER NOT NULL
   ) STRICT`,
  // v2: audit runs and their findings (spec §19). Findings are stored as validated JSON and
  // re-validated on read; ON DELETE CASCADE keeps both tables consistent with `projects`.
  `CREATE TABLE audit_runs (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     status TEXT NOT NULL CHECK (status IN ('running','completed','cancelled','failed')),
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     completeness TEXT CHECK (completeness IN ('complete','partial')),
     not_done TEXT NOT NULL,
     engines TEXT NOT NULL,
     finding_count INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX audit_runs_by_project ON audit_runs (project_id, started_at DESC);
   CREATE TABLE findings (
     run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (run_id, id)
   ) STRICT`,
  // v3: the stored gate summary and the project's content stamp at run start (staleness, §19).
  // Both stay NULL on rows from v2; the summary is derived from their findings on first read.
  `ALTER TABLE audit_runs ADD COLUMN summary TEXT;
   ALTER TABLE audit_runs ADD COLUMN code_stamp TEXT`,
];

function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function migrate(db: DatabaseSync): void {
  if (schemaVersion(db) === MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = schemaVersion(db); // re-read under the write lock: another process may have migrated
    if (current > MIGRATIONS.length) {
      throw new Error(
        `database schema v${current} is newer than this build (v${MIGRATIONS.length})`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const SQLITE_BUSY = 5;
const DEFAULT_BUSY_BUDGET_MS = 5000;

// errcode may be an extended result code (SQLITE_BUSY_RECOVERY = 261, _SNAPSHOT = 517, ...): the primary
// code is the low byte. SQLITE_LOCKED (6, "database table is locked") is a different, in-process
// condition that waiting does not cure, so it is deliberately not retried.
/** Exported for its unit test. */
export const isBusy = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const { errcode, message } = err as { errcode?: unknown; message?: unknown };
  if (typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY) return true;
  return typeof message === "string" && /database is locked/i.test(message);
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn`, retrying while SQLite reports SQLITE_BUSY, for at most `budgetMs`.
 *
 * `PRAGMA busy_timeout` is not enough for the first `PRAGMA journal_mode = WAL` on a fresh file:
 * the statement reads the header under a shared lock and then upgrades it, and when another process
 * already holds the write lock SQLite returns SQLITE_BUSY at once (waiting could deadlock) instead
 * of calling the busy handler. Two daemons starting on one new data directory therefore raced here
 * and one died with "database is locked". The error is transient, so retry it with jittered backoff.
 */
function retryWhileBusy(fn: () => void, budgetMs: number): void {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(50, 5 + attempt * 5) + Math.floor(Math.random() * 10));
    }
  }
}

export function openDb(file: string, opts: { busyBudgetMs?: number } = {}): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Pre-create the file 0600: SQLite gives its -wal/-shm files the main file's mode.
  if (process.platform !== "win32") closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  try {
    if (process.platform !== "win32") chmodSync(file, 0o600); // also tightens a pre-existing file
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON"); // pruning a run relies on the findings cascade
    const budget = opts.busyBudgetMs ?? DEFAULT_BUSY_BUDGET_MS;
    retryWhileBusy(() => db.exec("PRAGMA journal_mode = WAL"), budget);
    db.exec("PRAGMA synchronous = NORMAL");
    // The first migration also races with another starting daemon; BEGIN IMMEDIATE does honour
    // busy_timeout, but the retry makes the whole open robust against the same SQLITE_BUSY.
    retryWhileBusy(() => migrate(db), budget);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
