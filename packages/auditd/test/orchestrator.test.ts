import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Finding, MAX_STORED_FINDINGS } from "@audit/audit-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db";
import type { EngineRunOptions, ServiceResult } from "../src/engine-service";
import { IpcError } from "../src/errors";
import { createOrchestrator, type OrchestratorDeps } from "../src/orchestrator";
import { ProjectsRepo } from "../src/projects-repo";
import { RunsRepo } from "../src/runs-repo";
import { cleanupTmp, makeTmp } from "./helpers";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const finding = (n: number): Finding => ({
  id: hex(n),
  engine: "fake",
  ruleId: "fake.rule",
  title: `finding ${n}`,
  severity: "low",
  confidence: "medium",
  category: "quality",
  source: "heuristic",
  message: "m",
  evidence: [],
});
const result = (over: Partial<ServiceResult> = {}): ServiceResult => ({
  findings: [finding(1)],
  notDone: [],
  completeness: "complete",
  impact: {} as ServiceResult["impact"],
  engines: [{ id: "fake", applicable: true, tasks: [{ id: "fake.scan", status: "ok" }] }],
  ...over,
});

interface Call {
  path: string;
  opts: EngineRunOptions;
  resolve(r: ServiceResult): void;
  reject(e: unknown): void;
}
let calls: Call[];
const service = {
  run(path: string, opts: EngineRunOptions): Promise<ServiceResult> {
    return new Promise((resolve, reject) => {
      calls.push({ path, opts, resolve, reject });
      // a real service settles when aborted; the fake only does so when asked to
    });
  },
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let db: DatabaseSync;
let projects: ProjectsRepo;
let runs: RunsRepo;
let logs: string[];
let a: string;
let b: string;
let seq: number;

let stampValue: string;
let stampFails: boolean;
let stampCalls: string[];
const stamp = async (path: string): Promise<string> => {
  stampCalls.push(path);
  if (stampFails) throw new Error("cannot list");
  return stampValue;
};

// Existing tests describe a connected model; the no-model default is covered in its own describe.
const make = (over: Partial<OrchestratorDeps> = {}) =>
  createOrchestrator({
    projects,
    runs,
    service,
    log: (l) => logs.push(l),
    modelConnected: true,
    stamp,
    ...over,
  });

beforeEach(() => {
  db = openDb(join(makeTmp(), "audit.db"));
  seq = 0;
  projects = new ProjectsRepo(db, { now: () => 1, newId: () => `p-${++seq}` });
  runs = new RunsRepo(db, { now: () => 100 + seq, newId: () => `r-${++seq}` });
  const open = (path: string) =>
    projects.upsert({
      path,
      name: path,
      ecosystems: [],
      packageManager: null,
      isMonorepo: false,
      isGitRepo: false,
    }).id;
  a = open("/work/a");
  b = open("/work/b");
  calls = [];
  logs = [];
  stampValue = "stamp-1";
  stampFails = false;
  stampCalls = [];
});
afterEach(() => {
  db.close();
  cleanupTmp();
});

describe("orchestrator.start", () => {
  it("returns a running run immediately and calls the service with the project path", async () => {
    const o = make();
    const run = o.start(a);
    expect(run).toMatchObject({ projectId: a, status: "running", stage: "reading" });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/work/a");
  });

  it("never lets anything switch on running project code", async () => {
    const o = make();
    o.start(a);
    await tick();
    expect(calls[0]?.opts.userCode).toEqual({ allowed: false });
    expect(calls[0]?.opts.changedFiles).toEqual([]);
  });

  it("returns the same run when the same project is started again", async () => {
    const o = make();
    const first = o.start(a);
    const second = o.start(a);
    expect(second.id).toBe(first.id);
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("refuses a second project while one is running (busy) and starts nothing", async () => {
    const o = make();
    o.start(a);
    expect(() => o.start(b)).toThrowError(IpcError);
    try {
      o.start(b);
    } catch (e) {
      expect((e as IpcError).code).toBe("busy");
    }
    expect(runs.list(b, 50)).toEqual([]);
  });

  it("rejects an unknown project as not_found", () => {
    try {
      make().start("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as IpcError).code).toBe("not_found");
    }
  });

  it("allows the next run once the first has settled", async () => {
    const o = make();
    o.start(a);
    await tick();
    calls[0]?.resolve(result());
    await tick();
    expect(() => o.start(b)).not.toThrow();
  });
});

describe("orchestrator settle", () => {
  it("stores a completed run with its findings", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(result({ findings: [finding(1), finding(2)] }));
    await tick();
    expect(o.get(run.id)).toMatchObject({
      status: "completed",
      completeness: "complete",
      findingCount: 2,
    });
    expect(o.findings(run.id, 0, 50)).toMatchObject({ total: 2, offset: 0 });
    expect(o.findings(run.id, 0, 50).findings).toHaveLength(2);
    expect(o.findings(run.id, 1, 50).findings).toEqual([finding(2)]);
    expect(o.finding(run.id, hex(2))).toEqual(finding(2));
  });

  it("keeps notDone and marks the run partial", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(
      result({
        notDone: [{ what: "运行项目测试", reason: "无法在隔离环境中执行" }],
        completeness: "partial",
      }),
    );
    await tick();
    expect(o.get(run.id)).toMatchObject({ status: "completed", completeness: "partial" });
    expect(o.get(run.id)?.notDone).toHaveLength(1);
  });

  it("caps stored findings and says so", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    const many = Array.from({ length: MAX_STORED_FINDINGS + 5 }, (_, i) => finding(i + 1));
    calls[0]?.resolve(result({ findings: many }));
    await tick();
    const stored = o.get(run.id);
    expect(stored?.findingCount).toBe(MAX_STORED_FINDINGS);
    expect(stored?.completeness).toBe("partial");
    expect(stored?.notDone.some((n) => n.reason.includes(String(MAX_STORED_FINDINGS + 5)))).toBe(
      true,
    );
  });

  it("stores failed/partial with a generic reason when the service rejects, and logs without the raw secret", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.reject(new Error("boom token=abcd1234efgh5678ijkl"));
    await tick();
    const stored = o.get(run.id);
    expect(stored).toMatchObject({ status: "failed", completeness: "partial" });
    expect(JSON.stringify(stored)).not.toContain("boom");
    expect(logs.join("\n")).not.toContain("abcd1234efgh5678ijkl");
    expect(() => o.start(b)).not.toThrow();
  });

  it("falls back to failed when the result cannot be stored", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(result({ engines: [{ id: "", applicable: true, tasks: [] }] }));
    await tick();
    expect(o.get(run.id)).toMatchObject({ status: "failed", completeness: "partial" });
  });
});

describe("orchestrator honesty and failure handling", () => {
  it("never calls a run complete when no check actually ran", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(result({ engines: [], findings: [], completeness: "complete" }));
    await tick();
    const stored = o.get(run.id);
    expect(stored).toMatchObject({ status: "completed", completeness: "partial" });
    expect(stored?.notDone.length).toBeGreaterThan(0);
  });

  it("never calls a run complete when every task was skipped", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(
      result({
        engines: [
          { id: "fake", applicable: true, tasks: [{ id: "fake.scan", status: "skipped" }] },
        ],
        completeness: "complete",
      }),
    );
    await tick();
    expect(o.get(run.id)?.completeness).toBe("partial");
  });

  it("ends failed (not stuck running) even when storing the result fails mid-transaction", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    db.exec("DROP TABLE findings");
    calls[0]?.resolve(result());
    await tick();
    expect(o.get(run.id)?.status).toBe("failed");
    expect(() => o.start(b)).not.toThrow();
  });

  it("when finish keeps failing it still force-fails the row, so no phantom running run remains", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    vi.spyOn(runs, "finish").mockImplementation(() => {
      throw new Error("disk full");
    });
    calls[0]?.resolve(result());
    await tick();
    vi.restoreAllMocks();
    expect(runs.get(run.id)?.status).toBe("failed");
    expect((await o.history(a, 50)).filter((r) => r.status === "running")).toEqual([]);
  });

  it("logs when a result is discarded because the run was already finished elsewhere", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    runs.failOrphans(); // what a second daemon on the same data dir would do
    calls[0]?.resolve(result());
    await tick();
    expect(runs.get(run.id)?.status).toBe("failed");
    expect(logs.join("\n")).toMatch(/discard/i);
  });
});

describe("orchestrator progress", () => {
  it("shows the stage and the real done/total while running", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.opts.onEvent?.({ stage: "checking" });
    expect(o.get(run.id)).toMatchObject({ stage: "checking", progress: null });
    calls[0]?.opts.onEvent?.({ engine: "fake", done: 1, total: 3 });
    expect((await o.history(a, 50))[0]).toMatchObject({
      status: "running",
      stage: "checking",
      progress: { engine: "fake", done: 1, total: 3 },
    });
    calls[0]?.opts.onEvent?.({ stage: "concluding" });
    expect(o.get(run.id)).toMatchObject({ stage: "concluding", progress: null });
  });

  it("ignores a progress event that is not a real fraction", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.opts.onEvent?.({ engine: "fake", done: 9, total: 3 });
    calls[0]?.opts.onEvent?.({ engine: "Bad Engine!", done: 1, total: 3 });
    expect(o.get(run.id)?.progress).toBeNull();
  });
});

describe("orchestrator.cancel", () => {
  it("aborts the service signal and stores cancelled/partial", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    const call = calls[0] as Call;
    call.opts.signal?.addEventListener("abort", () => call.resolve(result({ findings: [] })));
    const cancelled = await o.cancel(run.id);
    expect(call.opts.signal?.aborted).toBe(true);
    expect(cancelled).toMatchObject({ status: "cancelled", completeness: "partial" });
    expect(cancelled.notDone.length).toBeGreaterThan(0);
  });

  it("returns while the run is still winding down if it does not stop in time", async () => {
    const o = make({ cancelWaitMs: 20 });
    const run = o.start(a);
    await tick();
    const after = await o.cancel(run.id);
    expect(after.status).toBe("running");
    calls[0]?.resolve(result());
    await tick();
    expect(o.get(run.id)?.status).toBe("cancelled");
  });

  it("cancelled while the project is still being fingerprinted: the service is never called", async () => {
    let release: (s: string) => void = () => {};
    const o = make({
      cancelWaitMs: 50,
      stamp: () => new Promise<string>((r) => (release = r)),
    });
    const run = o.start(a);
    await tick();
    const pending = o.cancel(run.id);
    release("stamp-1");
    const cancelled = await pending;
    expect(calls).toHaveLength(0);
    expect(cancelled).toMatchObject({ status: "cancelled", completeness: "partial" });
    expect(cancelled.notDone).toContainEqual({ what: "审计", reason: "已取消，结果不完整" });
    expect(cancelled.engines).toEqual([]);
    expect(cancelled.summary).toMatchObject({ gate: "none", checked: 0 });
    expect(runs.stampOf(run.id)).toBe("stamp-1");
  });

  it("shutdown while the project is still being fingerprinted: the service is never called", async () => {
    let release: (s: string) => void = () => {};
    const o = make({ stamp: () => new Promise<string>((r) => (release = r)) });
    const run = o.start(a);
    await tick();
    const done = o.shutdown();
    release("stamp-1");
    await done;
    expect(calls).toHaveLength(0);
    expect(runs.get(run.id)?.status).toBe("cancelled");
  });

  it("is harmless on a finished run and not_found on an unknown one", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    calls[0]?.resolve(result());
    await tick();
    expect((await o.cancel(run.id)).status).toBe("completed");
    await expect(o.cancel("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("orchestrator reads", () => {
  it("history is not_found for an unknown project, and lists newest first", async () => {
    const o = make();
    await expect(o.history("nope", 50)).rejects.toBeInstanceOf(IpcError);
    const first = o.start(a);
    await tick();
    calls[0]?.resolve(result());
    await tick();
    const second = o.start(a);
    expect((await o.history(a, 50)).map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("findings of an unknown run are not_found; of a running run are empty", async () => {
    const o = make();
    expect(() => o.findings("nope", 0, 50)).toThrowError(IpcError);
    expect(() => o.finding("nope", hex(1))).toThrowError(IpcError);
    const run = o.start(a);
    expect(o.findings(run.id, 0, 50)).toEqual({ findings: [], total: 0, offset: 0 });
    expect(() => o.finding(run.id, hex(1))).toThrowError(IpcError);
  });
});

describe("orchestrator.shutdown", () => {
  it("aborts active runs and waits for them, then refuses new ones", async () => {
    const o = make();
    const run = o.start(a);
    await tick();
    const call = calls[0] as Call;
    call.opts.signal?.addEventListener("abort", () => call.resolve(result({ findings: [] })));
    await o.shutdown();
    expect(call.opts.signal?.aborted).toBe(true);
    expect(runs.get(run.id)?.status).toBe("cancelled");
    expect(() => o.start(b)).toThrowError(IpcError);
  });

  it("waits less than the shell's 2 s quit grace by default, so the result is stored before the kill", () => {
    const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
    expect(src).toMatch(/DEFAULT_SHUTDOWN_WAIT_MS = 1500/);
  });

  it("does not hang on a service that never settles", async () => {
    const o = make({ shutdownWaitMs: 20 });
    o.start(a);
    await tick();
    await o.shutdown();
  });
});

const NO_MODEL_ITEM = { what: "读懂项目、生成测试、安全深度分析", reason: "需要连接 AI 模型" };
const critical = (n: number): Finding => ({
  ...finding(n),
  severity: "critical",
  confidence: "high",
});

async function settle(o: ReturnType<typeof make>, r: ServiceResult, project = a) {
  const run = o.start(project);
  await tick();
  calls[calls.length - 1]?.resolve(r);
  await tick();
  return run;
}

describe("orchestrator without a connected model", () => {
  it("is the default: a run says what it could not do and is never complete or ready", async () => {
    const o = make({ modelConnected: undefined });
    const run = await settle(o, result());
    const stored = o.get(run.id);
    expect(stored).toMatchObject({ status: "completed", completeness: "partial" });
    expect(stored?.notDone).toContainEqual(NO_MODEL_ITEM);
    expect(stored?.summary).toMatchObject({ gate: "review", afterFix: "review", checked: 1 });
  });

  it("with a model and nothing else missing, the same result is complete and ready", async () => {
    const o = make({ modelConnected: true });
    const run = await settle(o, result());
    expect(o.get(run.id)).toMatchObject({ completeness: "complete", notDone: [] });
    expect(o.get(run.id)?.summary).toMatchObject({ gate: "ready", afterFix: "ready" });
  });

  it("lists the model item only once even if the service already reported it", async () => {
    const o = make({ modelConnected: false });
    const run = await settle(o, result({ notDone: [NO_MODEL_ITEM], completeness: "partial" }));
    expect(o.get(run.id)?.notDone.filter((n) => n.what === NO_MODEL_ITEM.what)).toHaveLength(1);
  });

  it("is also listed on a cancelled run", async () => {
    const o = make({ modelConnected: false });
    const run = o.start(a);
    await tick();
    const call = calls[0] as Call;
    call.opts.signal?.addEventListener("abort", () => call.resolve(result({ findings: [] })));
    const cancelled = await o.cancel(run.id);
    expect(cancelled.notDone).toContainEqual(NO_MODEL_ITEM);
  });
});

describe("orchestrator summary and cut", () => {
  it("stores a summary computed from what is stored: blocked when a blocker exists", async () => {
    const o = make();
    const run = await settle(o, result({ findings: [critical(1), finding(2)] }));
    expect(o.get(run.id)?.summary).toMatchObject({
      gate: "blocked",
      counts: { must: 1, should: 0, later: 1 },
    });
  });

  it("sorts by importance before cutting, so a blocker found last is never cut", async () => {
    const o = make();
    const many = Array.from({ length: MAX_STORED_FINDINGS + 5 }, (_, i) => finding(i + 1));
    many.push(critical(MAX_STORED_FINDINGS + 10));
    const run = await settle(o, result({ findings: many }));
    const stored = o.get(run.id);
    expect(stored?.findingCount).toBe(MAX_STORED_FINDINGS);
    expect(stored?.summary?.gate).toBe("blocked");
    expect(o.findings(run.id, 0, 1).findings[0]?.id).toBe(hex(MAX_STORED_FINDINGS + 10));
  });

  it("dedupes by id before cutting, so duplicates cannot cause a cut or a false notice", async () => {
    const o = make();
    const unique = Array.from({ length: MAX_STORED_FINDINGS }, (_, i) => finding(i + 1));
    const run = await settle(o, result({ findings: [...unique, ...unique.slice(0, 10)] }));
    const stored = o.get(run.id);
    expect(stored).toMatchObject({ findingCount: MAX_STORED_FINDINGS, completeness: "complete" });
    expect(stored?.notDone).toEqual([]);
  });

  it("states the unique count in the cut notice", async () => {
    const o = make();
    const many = Array.from({ length: MAX_STORED_FINDINGS + 5 }, (_, i) => finding(i + 1));
    const run = await settle(o, result({ findings: [...many, ...many.slice(0, 3)] }));
    const cut = o.get(run.id)?.notDone.find((n) => n.what === "发现项过多");
    expect(cut?.reason).toBe(
      `共 ${MAX_STORED_FINDINGS + 5} 条，仅保存前 ${MAX_STORED_FINDINGS} 条`,
    );
  });
});

describe("orchestrator staleness", () => {
  it("takes the project stamp before the service starts reading", async () => {
    const o = make();
    o.start(a);
    await tick();
    expect(stampCalls).toEqual(["/work/a"]);
    expect(calls).toHaveLength(1);
  });

  it("is null while running, false while nothing changed, true once the project changed", async () => {
    const o = make({ stampTtlMs: 0 });
    const run = o.start(a);
    await tick();
    expect((await o.history(a, 50))[0]).toMatchObject({ id: run.id, stale: null, summary: null });
    calls[0]?.resolve(result());
    await tick();
    expect((await o.history(a, 50))[0]?.stale).toBe(false);
    stampValue = "stamp-2";
    expect((await o.history(a, 50))[0]?.stale).toBe(true);
  });

  it("keeps the fingerprint of the run's own stamp in history, even after the project changed", async () => {
    const o = make({ stampTtlMs: 0 });
    stampValue = "9f3a0c7e".repeat(8);
    const run = o.start(a);
    await tick();
    expect((await o.history(a, 50))[0]?.fingerprint).toBeNull(); // running
    calls[0]?.resolve(result());
    await tick();
    expect((await o.history(a, 50))[0]).toMatchObject({
      id: run.id,
      fingerprint: "9f3a0c7e",
      stale: false,
    });
    stampValue = "1b2c3d4e".repeat(8);
    expect((await o.history(a, 50))[0]).toMatchObject({ fingerprint: "9f3a0c7e", stale: true });
  });

  it("counts an edit made while the run was in progress as stale", async () => {
    const o = make({ stampTtlMs: 0 });
    o.start(a);
    await tick();
    stampValue = "edited-during-run";
    calls[0]?.resolve(result());
    await tick();
    expect((await o.history(a, 50))[0]?.stale).toBe(true);
  });

  it("is null, not guessed, when the project cannot be fingerprinted", async () => {
    const o = make({ stampTtlMs: 0 });
    stampFails = true;
    const run = await settle(o, result());
    expect(o.get(run.id)).toMatchObject({ status: "completed", completeness: "complete" });
    expect((await o.history(a, 50))[0]?.stale).toBeNull();
    stampFails = false;
    expect((await o.history(a, 50))[0]?.stale).toBeNull(); // this run never had a stamp
  });

  it("is null for a failed run", async () => {
    const o = make({ stampTtlMs: 0 });
    const run = o.start(a);
    await tick();
    calls[0]?.reject(new Error("boom"));
    await tick();
    expect((await o.history(a, 50))[0]).toMatchObject({
      id: run.id,
      status: "failed",
      stale: null,
    });
  });

  it("reuses one stamp within the ttl, shares an in-flight one, and recomputes after it", async () => {
    let now = 1000;
    const o = make({ stampTtlMs: 3000, now: () => now });
    await settle(o, result());
    stampCalls.length = 0;
    await Promise.all([o.history(a, 50), o.history(a, 50), o.history(a, 50)]);
    expect(stampCalls).toHaveLength(1);
    await o.history(a, 50);
    expect(stampCalls).toHaveLength(1);
    now += 3001;
    await o.history(a, 50);
    expect(stampCalls).toHaveLength(2);
  });

  it("forgets a remembered stamp when a run starts or finishes", async () => {
    const now = 1000;
    const o = make({ stampTtlMs: 3000, now: () => now });
    await settle(o, result());
    await o.history(a, 50);
    stampCalls.length = 0;
    stampValue = "stamp-2";
    expect((await o.history(a, 50))[0]?.stale).toBe(false); // still inside the ttl: remembered
    await settle(o, result());
    stampCalls.length = 0;
    stampValue = "stamp-3";
    const [latest] = await o.history(a, 50);
    expect(stampCalls).toHaveLength(1); // the finish dropped the memo
    expect(latest?.stale).toBe(true);
  });

  it("compares every stamped finished run: an older run that differs from now is outdated", async () => {
    const o = make();
    stampValue = "old";
    const first = await settle(o, result());
    stampFails = true;
    const unstamped = await settle(o, result());
    stampFails = false;
    stampValue = "new";
    const newer = await settle(o, result());
    const running = o.start(a);
    await tick();
    const byId = new Map((await o.history(a, 50)).map((r) => [r.id, r.stale] as const));
    expect(byId.get(running.id)).toBeNull();
    expect(byId.get(newer.id)).toBe(false);
    expect(byId.get(unstamped.id)).toBeNull();
    expect(byId.get(first.id)).toBe(true);
  });

  it("does not fingerprint the project when no run in the list has a stamp to compare", async () => {
    const o = make();
    await o.history(a, 50);
    expect(stampCalls).toEqual([]);
  });
});
