import {
  AuditProgressSchema,
  type AuditRun,
  type Finding,
  MAX_STORED_FINDINGS,
  type NotDone,
  sortByImportance,
} from "@audit/audit-core";
import { redactSecrets } from "@audit/shared";
import type { EngineRunOptions, ServiceEvent, ServiceResult } from "./engine-service";
import { IpcError } from "./errors";
import { computeProjectStamp } from "./project-stamp";
import type { ProjectsRepo } from "./projects-repo";
import type { RunOutcome, RunsRepo } from "./runs-repo";

export interface RunService {
  run(projectPath: string, opts: EngineRunOptions): Promise<ServiceResult>;
}
export interface OrchestratorDeps {
  projects: ProjectsRepo;
  runs: RunsRepo;
  service: RunService;
  /** Receives redacted, capped text only. */
  log?(line: string): void;
  /** How long cancel (and shutdown) wait for a run to wind down before replying anyway. */
  cancelWaitMs?: number;
  /** Must stay below the shell's 2 s quit grace, or the daemon is killed before the result is stored. */
  shutdownWaitMs?: number;
  /**
   * Whether an AI model is connected. Defaults to false: the daemon has no model path yet, so every
   * run says what it could not do instead of presenting a basic check as the full one.
   */
  modelConnected?: boolean;
  /** Fingerprint of a project's files; history compares it with the one taken when a run began. */
  stamp?(projectPath: string): Promise<string>;
  /** How long a fingerprint taken for history is reused (the UI polls). */
  stampTtlMs?: number;
  now?(): number;
}

const DEFAULT_CANCEL_WAIT_MS = 5000;
const DEFAULT_SHUTDOWN_WAIT_MS = 1500;
const DEFAULT_STAMP_TTL_MS = 3000;

// §16: running a project's own code needs per-project consent AND a per-OS isolation mechanism,
// and the second is not chosen yet. So the orchestrator can never enable it, whatever a request says.
const USER_CODE = Object.freeze({ allowed: false });

const FAILED: NotDone = { what: "审计", reason: "检查过程中出现内部错误，这次检查没有完成" };
const NOTHING_RAN: NotDone = { what: "检查", reason: "没有任何检查实际运行" };
const CANCELLED: NotDone = { what: "审计", reason: "已取消，结果不完整" };
const NO_MODEL: NotDone = { what: "读懂项目、生成测试、安全深度分析", reason: "需要连接 AI 模型" };

interface Active {
  run: AuditRun;
  controller: AbortController;
  settled: Promise<void>;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { projects, runs, service } = deps;
  const cancelMs = deps.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS;
  const shutdownMs = deps.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS;
  const modelConnected = deps.modelConnected ?? false;
  const fingerprint = deps.stamp ?? computeProjectStamp;
  const stampTtlMs = deps.stampTtlMs ?? DEFAULT_STAMP_TTL_MS;
  const now = deps.now ?? Date.now;
  const active = new Map<string, Active>();
  let stopping = false;

  const log = (line: string): void => {
    try {
      deps.log?.(redactSecrets(line).slice(0, 2000));
    } catch {
      /* a broken log sink must not break a run */
    }
  };
  const overlay = (run: AuditRun): AuditRun => active.get(run.id)?.run ?? run;

  // One fingerprint per project, shared while it is being computed and reused for stampTtlMs after.
  // A failure is remembered as null for the same period: "unknown", never a guess.
  const remembered = new Map<
    string,
    { value: Promise<string | null>; at: number; pending: boolean }
  >();
  function currentStamp(projectId: string, projectPath: string): Promise<string | null> {
    const hit = remembered.get(projectId);
    if (hit && (hit.pending || now() - hit.at < stampTtlMs)) return hit.value;
    const entry = { value: Promise.resolve<string | null>(null), at: now(), pending: true };
    entry.value = fingerprint(projectPath).then(
      (s) => s,
      () => null,
    );
    void entry.value.then(() => {
      entry.pending = false;
      entry.at = now();
    });
    remembered.set(projectId, entry);
    return entry.value;
  }
  const settleOrTimeout = (promises: Promise<void>[], waitMs: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      void Promise.all(promises).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  function outcomeOf(
    result: Pick<ServiceResult, "findings" | "notDone" | "completeness" | "engines">,
    cancelled: boolean,
    codeStamp: string | null,
  ): RunOutcome {
    const notDone = [...result.notDone];
    // Unique first: the same finding reported twice must neither trigger the cut nor displace another.
    const unique = [...new Map(result.findings.map((f) => [f.id, f] as const)).values()];
    // Most important first, so the cut can only ever drop the least important ones.
    let findings: Finding[] = sortByImportance(unique);
    if (findings.length > MAX_STORED_FINDINGS) {
      notDone.push({
        what: "发现项过多",
        reason: `共 ${findings.length} 条，仅保存前 ${MAX_STORED_FINDINGS} 条`,
      });
      findings = findings.slice(0, MAX_STORED_FINDINGS);
    }
    if (cancelled && !notDone.some((n) => n.what === CANCELLED.what)) notDone.push(CANCELLED);
    if (!modelConnected && !notDone.some((n) => n.what === NO_MODEL.what)) notDone.push(NO_MODEL);
    // "Complete" needs at least one check that really ran; an empty or all-skipped run says nothing.
    const anyOk = result.engines.some((e) => e.tasks.some((t) => t.status === "ok"));
    if (!cancelled && !anyOk && !notDone.some((n) => n.what === NOTHING_RAN.what)) {
      notDone.push(NOTHING_RAN);
    }
    return {
      status: cancelled ? "cancelled" : "completed",
      completeness: cancelled || notDone.length > 0 ? "partial" : result.completeness,
      notDone,
      engines: result.engines,
      findings,
      codeStamp,
    };
  }
  const failedOutcome = (): RunOutcome => ({
    status: "failed",
    completeness: "partial",
    notDone: [FAILED],
    engines: [],
    findings: [],
  });

  async function execute(entry: Active, projectPath: string): Promise<void> {
    const { controller } = entry;
    const onEvent = (e: ServiceEvent): void => {
      if ("stage" in e) {
        entry.run = { ...entry.run, stage: e.stage, progress: null };
        return;
      }
      const progress = AuditProgressSchema.safeParse(e);
      if (progress.success)
        entry.run = { ...entry.run, stage: "checking", progress: progress.data };
    };
    let outcome: RunOutcome;
    try {
      // Taken before anything is read, so an edit made during the run counts as "changed since".
      const codeStamp = await fingerprint(projectPath).then(
        (s) => s,
        () => null,
      );
      // The walk can take a while on a big project; a cancel or shutdown during it must not start engines.
      const result = controller.signal.aborted
        ? { findings: [], notDone: [], completeness: "partial" as const, engines: [] }
        : await service.run(projectPath, {
            changedFiles: [],
            userCode: USER_CODE,
            signal: controller.signal,
            onEvent,
          });
      outcome = outcomeOf(result, controller.signal.aborted, codeStamp);
    } catch (err) {
      log(`audit run ${entry.run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      outcome = failedOutcome();
    }
    try {
      if (runs.finish(entry.run.id, outcome) === null) {
        log(`audit run ${entry.run.id} was already finished elsewhere; its result is discarded`);
      }
    } catch (err) {
      log(`audit run ${entry.run.id} could not store its result: ${String(err)}`);
      try {
        runs.finish(entry.run.id, failedOutcome());
      } catch (err2) {
        log(`audit run ${entry.run.id} could not be marked failed: ${String(err2)}`);
        try {
          runs.failRun(entry.run.id);
        } catch (err3) {
          log(`audit run ${entry.run.id} could not be force-failed: ${String(err3)}`);
        }
      }
    } finally {
      active.delete(entry.run.id);
      remembered.delete(entry.run.projectId);
    }
  }

  return {
    /** Returns at once; the work continues in the background. */
    start(projectId: string): AuditRun {
      if (stopping) throw new IpcError("busy", "The service is shutting down.");
      const project = projects.get(projectId);
      if (!project) throw new IpcError("not_found", "No such project.");
      for (const entry of active.values()) {
        if (entry.run.projectId === projectId) return entry.run;
      }
      if (active.size > 0) throw new IpcError("busy", "Another audit is already running.");
      remembered.delete(projectId);
      const stored = runs.start(projectId);
      const entry: Active = {
        run: { ...stored, stage: "reading" },
        controller: new AbortController(),
        settled: Promise.resolve(),
      };
      active.set(stored.id, entry);
      // execute() never rejects.
      entry.settled = execute(entry, project.path);
      return entry.run;
    },

    async cancel(runId: string): Promise<AuditRun> {
      const entry = active.get(runId);
      if (!entry) {
        const run = runs.get(runId);
        if (!run) throw new IpcError("not_found", "No such audit run.");
        return run;
      }
      entry.controller.abort();
      await settleOrTimeout([entry.settled], cancelMs);
      return this.get(runId) ?? entry.run;
    },

    get(runId: string): AuditRun | null {
      const run = runs.get(runId);
      return run ? overlay(run) : null;
    },

    async history(projectId: string, limit: number): Promise<AuditRun[]> {
      const project = projects.get(projectId);
      if (!project) throw new IpcError("not_found", "No such project.");
      const list = runs.list(projectId, limit).map(overlay);
      const stamped = new Map<string, string>();
      for (const r of list) {
        if (r.status === "running") continue;
        const stamp = runs.stampOf(r.id);
        if (stamp !== null) stamped.set(r.id, stamp);
      }
      if (stamped.size === 0) return list;
      const current = await currentStamp(project.id, project.path);
      if (current === null) return list;
      return list.map((r) => {
        const taken = stamped.get(r.id);
        return taken === undefined ? r : { ...r, stale: taken !== current };
      });
    },

    findings(
      runId: string,
      offset: number,
      limit: number,
    ): { findings: Finding[]; total: number; offset: number } {
      if (!runs.get(runId)) throw new IpcError("not_found", "No such audit run.");
      return {
        findings: runs.findings(runId, offset, limit),
        total: runs.findingTotal(runId),
        offset,
      };
    },

    finding(runId: string, id: string): Finding {
      if (!runs.get(runId)) throw new IpcError("not_found", "No such audit run.");
      const found = runs.finding(runId, id);
      if (!found) throw new IpcError("not_found", "No such finding.");
      return found;
    },

    async shutdown(): Promise<void> {
      stopping = true;
      const entries = [...active.values()];
      for (const e of entries) e.controller.abort();
      await settleOrTimeout(
        entries.map((e) => e.settled),
        shutdownMs,
      );
    },
  };
}
export type Orchestrator = ReturnType<typeof createOrchestrator>;
