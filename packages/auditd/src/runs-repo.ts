import type { DatabaseSync } from "node:sqlite";
import {
  type AuditRun,
  AuditRunSchema,
  type Completeness,
  type EngineSummaryData,
  type Finding,
  FindingSchema,
  MAX_RUNS_PER_PROJECT,
  type NotDone,
  type RunSummary,
  RunSummarySchema,
  summarize,
} from "@audit/audit-core";

export interface RunsRepoDeps {
  now: () => number;
  newId: () => string;
}

export interface RunOutcome {
  status: "completed" | "cancelled" | "failed";
  completeness: Completeness;
  notDone: NotDone[];
  engines: EngineSummaryData[];
  findings: Finding[];
  /** Fingerprint of the project's files when the run began; null when it could not be taken. */
  codeStamp?: string | null;
}

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  completeness: string | null;
  not_done: string;
  engines: string;
  finding_count: number;
  summary: string | null;
  code_stamp: string | null;
}

// What a run that never produced a result reads back as: nothing ran, so it is neither blocked nor ready.
const NO_RESULT_SUMMARY = JSON.stringify(
  summarize({ status: "failed", completeness: "partial", notDone: [], engines: [], findings: [] }),
);

const ORPHAN_NOT_DONE: NotDone = {
  what: "审计",
  reason: "本机服务在检查过程中退出，这次检查没有完成",
};

// The stamp is a hex sha256; anything else (a legacy or foreign value) is "unknown", never a guess.
function fingerprintOf(stamp: string | null | undefined): string | null {
  return typeof stamp === "string" && /^[0-9a-f]{64}$/.test(stamp) ? stamp.slice(0, 8) : null;
}

// Live stage and progress belong to the orchestrator, not the database. A running row has stage null
// here; the schema allows that. Parsing throws on a corrupt row; the IPC server turns that into a generic `internal` reply.
function toRun(raw: unknown, summary: RunSummary | null): AuditRun {
  const r = raw as RunRow;
  return AuditRunSchema.parse({
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    stage: null,
    progress: null,
    completeness: r.completeness,
    notDone: JSON.parse(r.not_done),
    engines: JSON.parse(r.engines),
    findingCount: r.finding_count,
    summary,
    stale: null,
    fingerprint: r.status === "running" ? null : fingerprintOf(r.code_stamp),
  });
}

export class RunsRepo {
  private readonly db: DatabaseSync;
  private readonly deps: RunsRepoDeps;

  constructor(db: DatabaseSync, deps: RunsRepoDeps) {
    this.db = db;
    this.deps = deps;
  }

  start(projectId: string): AuditRun {
    const row = this.db
      .prepare(
        `INSERT INTO audit_runs (id, project_id, status, started_at, not_done, engines, finding_count)
         VALUES (?, ?, 'running', ?, '[]', '[]', 0) RETURNING *`,
      )
      .get(this.deps.newId(), projectId, this.deps.now());
    return toRun(row, null);
  }

  /** Null when the run is unknown or has already finished (so a late settle cannot overwrite it). */
  finish(runId: string, outcome: RunOutcome): AuditRun | null {
    const current = this.get(runId);
    if (current?.status !== "running") return null;
    // The first occurrence of an id wins, exactly as the INSERT OR IGNORE below; counts and summary
    // are taken from what is stored, so the headline can never disagree with the list.
    const unique = [...new Map(outcome.findings.map((f) => [f.id, f] as const)).values()];
    const summary = summarize({
      status: outcome.status,
      completeness: outcome.completeness,
      notDone: outcome.notDone,
      engines: outcome.engines,
      findings: unique,
    });
    const next = AuditRunSchema.parse({
      ...current,
      status: outcome.status,
      finishedAt: this.deps.now(),
      completeness: outcome.completeness,
      notDone: outcome.notDone,
      engines: outcome.engines,
      findingCount: unique.length,
      summary,
      fingerprint: fingerprintOf(outcome.codeStamp),
    });
    this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE audit_runs SET status = ?, finished_at = ?, completeness = ?, not_done = ?,
             engines = ?, finding_count = ?, summary = ?, code_stamp = ? WHERE id = ? AND status = 'running'`,
        )
        .run(
          next.status,
          next.finishedAt,
          next.completeness,
          JSON.stringify(next.notDone),
          JSON.stringify(next.engines),
          next.findingCount,
          JSON.stringify(summary),
          outcome.codeStamp ?? null,
          runId,
        );
      if (Number(changed.changes) === 0) throw new Error("run finished concurrently");
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO findings (run_id, id, seq, data) VALUES (?, ?, ?, ?)",
      );
      unique.forEach((f, i) => {
        insert.run(runId, f.id, i, JSON.stringify(FindingSchema.parse(f)));
      });
      this.prune(next.projectId);
    });
    return next;
  }

  get(runId: string): AuditRun | null {
    const row = this.db.prepare("SELECT * FROM audit_runs WHERE id = ?").get(runId);
    return row ? this.hydrate(row) : null;
  }

  /** The project fingerprint taken when the run began; null for a running, older or unstamped run. */
  stampOf(runId: string): string | null {
    const row = this.db.prepare("SELECT code_stamp FROM audit_runs WHERE id = ?").get(runId) as
      | { code_stamp: string | null }
      | undefined;
    return row?.code_stamp ?? null;
  }

  list(projectId: string, limit: number): AuditRun[] {
    return this.db
      .prepare(
        "SELECT * FROM audit_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
      )
      .all(projectId, limit)
      .map((row) => this.hydrate(row));
  }

  findings(runId: string, offset: number, limit: number): Finding[] {
    return this.db
      .prepare("SELECT data FROM findings WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?")
      .all(runId, limit, offset)
      .map((r) => FindingSchema.parse(JSON.parse((r as { data: string }).data)));
  }

  findingTotal(runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?")
      .get(runId) as {
      n: number;
    };
    return Number(row.n);
  }

  finding(runId: string, id: string): Finding | null {
    const row = this.db
      .prepare("SELECT data FROM findings WHERE run_id = ? AND id = ?")
      .get(runId, id) as { data: string } | undefined;
    return row ? FindingSchema.parse(JSON.parse(row.data)) : null;
  }

  /** Last resort when `finish` cannot store a result: touches no JSON column, so a corrupt row cannot block it. */
  failRun(runId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE audit_runs SET status = 'failed', finished_at = ?, completeness = 'partial', not_done = ?,
           summary = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(this.deps.now(), JSON.stringify([ORPHAN_NOT_DONE]), NO_RESULT_SUMMARY, runId);
    return Number(result.changes) > 0;
  }

  /** Startup only: a `running` row then belongs to a daemon that no longer exists. */
  failOrphans(): number {
    const result = this.db
      .prepare(
        `UPDATE audit_runs SET status = 'failed', finished_at = ?, completeness = 'partial', not_done = ?,
           summary = ?
         WHERE status = 'running'`,
      )
      .run(this.deps.now(), JSON.stringify([ORPHAN_NOT_DONE]), NO_RESULT_SUMMARY);
    return Number(result.changes);
  }

  /** A finished row without a stored summary (written before v3) gets one derived from its findings, once. */
  private hydrate(raw: unknown): AuditRun {
    const row = raw as RunRow;
    if (row.summary !== null) return toRun(raw, RunSummarySchema.parse(JSON.parse(row.summary)));
    if (row.status === "running") return toRun(raw, null);
    const stored = this.db
      .prepare("SELECT data FROM findings WHERE run_id = ?")
      .all(row.id)
      .map((r) => FindingSchema.parse(JSON.parse((r as { data: string }).data)));
    const summary = summarize({
      status: row.status as "completed" | "cancelled" | "failed",
      completeness: row.completeness as Completeness,
      notDone: JSON.parse(row.not_done),
      engines: JSON.parse(row.engines),
      findings: stored,
    });
    this.db
      .prepare(
        "UPDATE audit_runs SET summary = ? WHERE id = ? AND summary IS NULL AND status != 'running'",
      )
      .run(JSON.stringify(summary), row.id);
    return toRun(raw, summary);
  }

  private prune(projectId: string): void {
    this.db
      .prepare(
        `DELETE FROM audit_runs WHERE project_id = ? AND status != 'running' AND id NOT IN (
           SELECT id FROM audit_runs WHERE project_id = ? AND status != 'running'
           ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(projectId, projectId, MAX_RUNS_PER_PROJECT);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
