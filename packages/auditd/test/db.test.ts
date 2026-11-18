import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isBusy, openDb } from "../src/db";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);

const version = (db: DatabaseSync) =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

/** Starts a process holding a write lock on `file`; resolves once it says it is locked. */
async function holdLock(file: string, ms: number): Promise<ChildProcess> {
  const holder = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/hold-db-lock.mjs", import.meta.url)), file, String(ms)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const onExit = (): void => reject(new Error("lock holder exited early"));
      const onData = (d: Buffer): void => {
        if (!String(d).includes("locked")) return;
        holder.off("exit", onExit);
        holder.stdout?.off("data", onData);
        resolve();
      };
      holder.once("error", reject);
      holder.once("exit", onExit);
      holder.stdout?.on("data", onData);
    });
  } catch (err) {
    await stopHolder(holder);
    throw err;
  }
  return holder;
}

/**
 * Kills the holder and waits until it has really exited. `kill()` only requests termination (on
 * Windows it is asynchronous), and the holder's open database file blocks deleting the temp
 * directory until the process is gone.
 */
async function stopHolder(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  holder.kill();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
}

describe("openDb", () => {
  it("creates missing parent directories and migrates a fresh file", () => {
    const db = openDb(join(makeTmp(), "a", "b", "audit.db"));
    expect(version(db)).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toBeTruthy();
    db.close();
  });

  it.skipIf(process.platform === "win32")(
    "keeps the data dir owner-only (0700) and the database and its WAL files 0600",
    () => {
      const dir = join(makeTmp(), "data");
      const file = join(dir, "audit.db");
      const db = openDb(file);
      db.exec("INSERT INTO projects VALUES ('i','/p','p','[]',NULL,0,0,1,1)");
      const mode = (f: string) => statSync(f).mode & 0o777;
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      for (const extra of [`${file}-wal`, `${file}-shm`]) {
        expect(existsSync(extra)).toBe(true);
        expect(mode(extra)).toBe(0o600);
      }
      db.close();
    },
  );

  it.skipIf(process.platform === "win32")("tightens an existing database file to 0600", () => {
    const file = join(makeTmp(), "audit.db");
    openDb(file).close();
    chmodSync(file, 0o644);
    openDb(file).close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("upgrades a v1 database to v2 and keeps its projects", () => {
    const file = join(makeTmp(), "audit.db");
    const raw = new DatabaseSync(file);
    raw.exec(
      `CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         ecosystems TEXT NOT NULL, package_manager TEXT, is_monorepo INTEGER NOT NULL,
         is_git_repo INTEGER NOT NULL, added_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL) STRICT`,
    );
    raw.exec("INSERT INTO projects VALUES ('i','/p','p','[]',NULL,0,0,1,1)");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const db = openDb(file);
    expect(version(db)).toBe(3);
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "i" }]);
    for (const table of ["audit_runs", "findings"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)).toBeTruthy();
    }
    db.close();
  });

  it("turns foreign keys on explicitly (prune relies on the cascade)", () => {
    const db = openDb(join(makeTmp(), "audit.db"));
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    db.close();
  });

  it("is idempotent: reopening the same file changes nothing", () => {
    const file = join(makeTmp(), "audit.db");
    openDb(file).close();
    const db = openDb(file);
    expect(version(db)).toBe(3);
    db.close();
  });

  it("uses WAL and a busy timeout so two processes can share the file", () => {
    const db = openDb(join(makeTmp(), "audit.db"));
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    db.close();
  });

  it("waits out another process's write lock while switching to WAL (SQLite does not call the busy handler there)", async () => {
    const file = join(makeTmp(), "audit.db");
    const holder = await holdLock(file, 600);
    try {
      const started = Date.now();
      const db = openDb(file); // synchronous: blocks until the holder commits
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      ).toBe("wal");
      expect(version(db)).toBe(3);
      db.close();
    } finally {
      await stopHolder(holder);
    }
  });

  it("gives up with the lock error when the other process never lets go", async () => {
    const file = join(makeTmp(), "audit.db");
    const holder = await holdLock(file, 30_000);
    try {
      expect(() => openDb(file, { busyBudgetMs: 300 })).toThrow(/locked/);
    } finally {
      await stopHolder(holder);
    }
  });

  it("refuses a database written by a newer build instead of corrupting it", () => {
    const file = join(makeTmp(), "audit.db");
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => openDb(file)).toThrow(/newer/);
  });

  it("enforces one row per path", () => {
    const db = openDb(join(makeTmp(), "audit.db"));
    const insert = (id: string) =>
      db
        .prepare(
          "INSERT INTO projects (id,path,name,ecosystems,package_manager,is_monorepo,is_git_repo,added_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(id, "/p", "p", "[]", null, 0, 0, 1, 1);
    insert("a");
    expect(() => insert("b")).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("isBusy", () => {
  it("recognises the primary BUSY code and its extended variants, by the low byte", () => {
    for (const errcode of [5, 261, 517, 773]) expect(isBusy({ errcode })).toBe(true);
  });
  it("does not treat SQLITE_LOCKED or other codes as busy, and falls back to the message", () => {
    for (const errcode of [6, 262, 1, 19, 0]) expect(isBusy({ errcode, message: "x" })).toBe(false);
    expect(isBusy({ message: "database is locked" })).toBe(true);
    expect(isBusy({ errcode: "5", message: "no" })).toBe(false);
    expect(isBusy(null)).toBe(false);
    expect(isBusy("database is locked")).toBe(false);
  });
});
