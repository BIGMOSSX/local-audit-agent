import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Finding } from "@audit/audit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { ProjectsRepo } from "../src/projects-repo";
import { type RunOutcome, RunsRepo } from "../src/runs-repo";
import { cleanupTmp, makeTmp } from "./helpers";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const finding = (n: number, over: Partial<Finding> = {}): Finding => ({
  id: hex(n),
  engine: "fake",
  ruleId: "fake.rule",
  title: `finding ${n}`,
  severity: "low",
  confidence: "medium",
  category: "quality",
  source: "heuristic",
  file: "src/a.ts",
  message: "m",
  evidence: [],
  ...over,
});
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: "completed",
  completeness: "complete",
  notDone: [],
  engines: [{ id: "fake", applicable: true, tasks: [{ id: "fake.scan", status: "ok" }] }],
  findings: [finding(1), finding(2)],
  ...over,
});

let db: DatabaseSync;
let time: number;
let seq: number;
let runs: RunsRepo;
let projectId: string;

beforeEach(() => {
  db = openDb(join(makeTmp(), "audit.db"));
  time = 1_000;
  seq = 0;
  const projects = new ProjectsRepo(db, { now: () => time, newId: () => `p-${++seq}` });
  projectId = projects.upsert({
    path: "/work/alpha",
    name: "alpha",
    ecosystems: [],
    packageManager: null,
    isMonorepo: false,
    isGitRepo: false,
  }).id;
  runs = new RunsRepo(db, { now: () => time, newId: () => `r-${++seq}` });
});
afterEach(() => {
  db.close();
  cleanupTmp();
});

describe("RunsRepo", () => {
  it("starts a run as running with no verdict", () => {
    const run = runs.start(projectId);
    expect(run).toMatchObject({
      projectId,
      status: "running",
      startedAt: 1_000,
      finishedAt: null,
      completeness: null,
      findingCount: 0,
    });
    expect(runs.get(run.id)).toEqual(run);
  });

  it("finish stores the verdict and the findings, in order, once per (run, id)", () => {
    const run = runs.start(projectId);
    time = 2_000;
    const done = runs.finish(run.id, outcome({ findings: [finding(2), finding(1), finding(2)] }));
    expect(done).toMatchObject({ status: "completed", finishedAt: 2_000, findingCount: 2 });
    expect(runs.findings(run.id, 0, 50).map((f) => f.id)).toEqual([hex(2), hex(1)]);
    expect(runs.finding(run.id, hex(1))).toEqual(finding(1));
    expect(runs.finding(run.id, hex(9))).toBeNull();
  });

  it("pages findings by offset and limit, and counts them all", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome({ findings: [1, 2, 3, 4, 5].map((n) => finding(n)) }));
    expect(runs.findings(run.id, 1, 2).map((f) => f.id)).toEqual([hex(2), hex(3)]);
    expect(runs.findings(run.id, 4, 50).map((f) => f.id)).toEqual([hex(5)]);
    expect(runs.findings(run.id, 9, 50)).toEqual([]);
    expect(runs.findingTotal(run.id)).toBe(5);
  });

  it("failRun marks only a running run failed, without needing a readable row", () => {
    const run = runs.start(projectId);
    db.exec("UPDATE audit_runs SET not_done = '{corrupt'");
    expect(runs.failRun(run.id)).toBe(true);
    expect(runs.failRun(run.id)).toBe(false);
    const done = runs.start(projectId);
    runs.finish(done.id, outcome());
    expect(runs.failRun(done.id)).toBe(false);
  });

  it("a failure in the middle of finish rolls everything back and leaves the run running", () => {
    const run = runs.start(projectId);
    db.exec("DROP TABLE findings");
    expect(() => runs.finish(run.id, outcome())).toThrow();
    expect(runs.get(run.id)?.status).toBe("running");
  });

  it("finish is a no-op on a run that already finished", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome({ status: "cancelled", completeness: "partial" }));
    expect(runs.finish(run.id, outcome())).toBeNull();
    expect(runs.get(run.id)?.status).toBe("cancelled");
  });

  it("finish rejects a verdict the schema would not allow (cancelled but complete)", () => {
    const run = runs.start(projectId);
    expect(() => runs.finish(run.id, outcome({ status: "cancelled" }))).toThrow();
    expect(runs.get(run.id)?.status).toBe("running");
  });

  it("lists newest first and honours the limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      time += 10;
      const r = runs.start(projectId);
      runs.finish(r.id, outcome({ findings: [] }));
      ids.push(r.id);
    }
    expect(runs.list(projectId, 50).map((r) => r.id)).toEqual([...ids].reverse());
    expect(runs.list(projectId, 2)).toHaveLength(2);
    expect(runs.list("nope", 50)).toEqual([]);
  });

  it("keeps the newest 50 finished runs per project and drops older ones with their findings", () => {
    const first = runs.start(projectId);
    runs.finish(first.id, outcome());
    for (let i = 0; i < 50; i++) {
      time += 1;
      runs.finish(runs.start(projectId).id, outcome({ findings: [] }));
    }
    expect(runs.list(projectId, 50)).toHaveLength(50);
    expect(runs.get(first.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?").get(first.id)).toEqual(
      {
        n: 0,
      },
    );
  });

  it("never prunes a run that is still running", () => {
    const live = runs.start(projectId);
    for (let i = 0; i < 52; i++) {
      time += 1;
      runs.finish(runs.start(projectId).id, outcome({ findings: [] }));
    }
    expect(runs.get(live.id)?.status).toBe("running");
  });

  it("failOrphans turns running rows into failed/partial with an honest reason and leaves finished rows", () => {
    const finished = runs.start(projectId);
    runs.finish(finished.id, outcome());
    const orphan = runs.start(projectId);
    time = 5_000;
    expect(runs.failOrphans()).toBe(1);
    expect(runs.get(orphan.id)).toMatchObject({
      status: "failed",
      completeness: "partial",
      finishedAt: 5_000,
    });
    expect(runs.get(orphan.id)?.notDone.length).toBe(1);
    expect(runs.get(finished.id)?.status).toBe("completed");
    expect(runs.failOrphans()).toBe(0);
  });

  it("throws on a corrupt stored row instead of returning half of it", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome());
    db.exec("UPDATE audit_runs SET not_done = '{not json'");
    expect(() => runs.get(run.id)).toThrow();
  });

  it("throws on a stored finding that no longer passes FindingSchema", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome());
    db.exec(`UPDATE findings SET data = '{"id":"x"}'`);
    expect(() => runs.findings(run.id, 0, 50)).toThrow();
    expect(() => runs.finding(run.id, hex(1))).toThrow();
  });

  it("removes a run's rows when its project goes away", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome());
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(runs.get(run.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  it("stores the summary and the code stamp, and they survive a fresh repo on the same file", () => {
    const run = runs.start(projectId);
    runs.finish(
      run.id,
      outcome({
        findings: [finding(1, { severity: "critical", confidence: "high" })],
        codeStamp: "stamp-1",
      }),
    );
    const again = new RunsRepo(db, { now: () => time, newId: () => "x" });
    expect(again.get(run.id)?.summary).toMatchObject({
      gate: "blocked",
      needed: 1,
      counts: { must: 1, should: 0, later: 0 },
      checked: 1,
    });
    expect(again.stampOf(run.id)).toBe("stamp-1");
    expect(again.stampOf("nope")).toBeNull();
    expect(again.get(run.id)?.stale).toBeNull();
  });

  it("exposes the first 8 hex of the stored stamp as fingerprint on get, list and finish", () => {
    const stamp = `${"0123abcd"}${"e".repeat(56)}`;
    const run = runs.start(projectId);
    expect(run.fingerprint).toBeNull();
    expect(runs.get(run.id)?.fingerprint).toBeNull();
    const finished = runs.finish(run.id, outcome({ codeStamp: stamp }));
    expect(finished?.fingerprint).toBe("0123abcd");
    expect(runs.get(run.id)?.fingerprint).toBe("0123abcd");
    expect(runs.list(projectId, 5)[0]?.fingerprint).toBe("0123abcd");
    const again = new RunsRepo(db, { now: () => time, newId: () => "x" });
    expect(again.get(run.id)?.fingerprint).toBe("0123abcd");
  });

  it("has no fingerprint without a usable stamp: none stored, failed, orphaned or not 64 hex", () => {
    const none = runs.start(projectId);
    runs.finish(none.id, outcome());
    expect(runs.get(none.id)?.fingerprint).toBeNull();

    const failed = runs.start(projectId);
    runs.failRun(failed.id);
    expect(runs.get(failed.id)?.fingerprint).toBeNull();

    const orphan = runs.start(projectId);
    runs.failOrphans();
    expect(runs.get(orphan.id)?.fingerprint).toBeNull();

    for (const bad of [
      "stamp-1",
      "ABCDEF01".repeat(8),
      "0123abcd".repeat(7),
      "0123abcd".repeat(9),
    ]) {
      const r = runs.start(projectId);
      runs.finish(r.id, outcome({ codeStamp: bad }));
      expect(runs.get(r.id)?.fingerprint).toBeNull();
    }
  });

  it("a running run has no summary and no stamp", () => {
    const run = runs.start(projectId);
    expect(runs.get(run.id)).toMatchObject({ summary: null, stale: null });
    expect(runs.stampOf(run.id)).toBeNull();
  });

  it("summary counts equal the stored findings when the outcome holds duplicate ids", () => {
    const run = runs.start(projectId);
    const done = runs.finish(
      run.id,
      outcome({ findings: [finding(2), finding(1), finding(2), finding(1)] }),
    );
    const counts = done?.summary?.counts;
    expect((counts?.must ?? 0) + (counts?.should ?? 0) + (counts?.later ?? 0)).toBe(2);
    expect(done?.findingCount).toBe(2);
  });

  it("failRun and failOrphans rows read back with a valid 'none' summary", () => {
    const failed = runs.start(projectId);
    runs.failRun(failed.id);
    const orphan = runs.start(projectId);
    runs.failOrphans();
    for (const id of [failed.id, orphan.id]) {
      expect(runs.get(id)?.summary).toMatchObject({ gate: "none", afterFix: "none" });
    }
  });

  it("throws on a corrupt stored summary", () => {
    const run = runs.start(projectId);
    runs.finish(run.id, outcome());
    db.exec("UPDATE audit_runs SET summary = '{not json'");
    expect(() => runs.get(run.id)).toThrow();
  });

  it("derives a missing summary from the stored findings once, then writes it back", () => {
    const run = runs.start(projectId);
    runs.finish(
      run.id,
      outcome({ findings: [finding(1, { severity: "critical", confidence: "high" })] }),
    );
    db.exec("UPDATE audit_runs SET summary = NULL");
    expect(runs.get(run.id)?.summary?.gate).toBe("blocked");
    const stored = db.prepare("SELECT summary FROM audit_runs WHERE id = ?").get(run.id) as {
      summary: string | null;
    };
    expect(stored.summary).not.toBeNull();
    // A second read must not need the findings table any more.
    db.exec(`UPDATE findings SET data = '{"id":"x"}'`);
    expect(runs.get(run.id)?.summary?.gate).toBe("blocked");
  });

  it("never writes a derived summary back onto a running row", () => {
    const run = runs.start(projectId);
    runs.get(run.id);
    const stored = db.prepare("SELECT summary FROM audit_runs WHERE id = ?").get(run.id) as {
      summary: string | null;
    };
    expect(stored.summary).toBeNull();
  });
});

describe("migration v3 on an existing v2 database", () => {
  it("adds the columns and derives the summary of a pre-v3 finished run from its findings", () => {
    const file = join(makeTmp(), "legacy.db");
    const first = openDb(file);
    const projects = new ProjectsRepo(first, { now: () => 1, newId: () => "lp" });
    const pid = projects.upsert({
      path: "/work/legacy",
      name: "legacy",
      ecosystems: [],
      packageManager: null,
      isMonorepo: false,
      isGitRepo: false,
    }).id;
    const r = new RunsRepo(first, { now: () => 5, newId: () => "lr" });
    r.start(pid);
    r.finish(
      "lr",
      outcome({ findings: [finding(1, { severity: "critical", confidence: "high" })] }),
    );
    first.exec("ALTER TABLE audit_runs DROP COLUMN summary");
    first.exec("ALTER TABLE audit_runs DROP COLUMN code_stamp");
    first.exec("PRAGMA user_version = 2");
    first.close();

    const second = openDb(file);
    try {
      const cols = second.prepare("PRAGMA table_info(audit_runs)").all() as { name: string }[];
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["summary", "code_stamp"]));
      const again = new RunsRepo(second, { now: () => 6, newId: () => "x" });
      expect(again.get("lr")?.summary).toMatchObject({ gate: "blocked", needed: 1 });
      expect(again.stampOf("lr")).toBeNull();
    } finally {
      second.close();
    }
  });
});
