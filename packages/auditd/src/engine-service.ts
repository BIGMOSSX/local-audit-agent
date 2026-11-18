import {
  type AuditEngine,
  type AuditStage,
  type Completeness,
  type DetectedProject,
  emptyImpact,
  type Finding,
  type ImpactContext,
  ImpactContextSchema,
  mapFindingText,
  type NotDone,
  type ProjectContext,
  RepoPathSchema,
  runEngine,
  sanitizeEngineText,
  type ToolHost,
} from "@audit/audit-core";
import { redactSecrets } from "@audit/shared";
import {
  createSandbox as defaultCreateSandbox,
  listProjectFiles,
  type Sandbox,
  SandboxError,
} from "./sandbox/workspace";

export interface EngineHost {
  host: ToolHost | null;
  /** Must kill the engine process and, where it can, wait (bounded) until it is gone. Idempotent. */
  close(): void | Promise<void>;
  /** Redacted, capped stderr tail; read only after `close()` has settled. */
  diagnostics?(): string;
}
export interface EngineServiceDeps {
  engines: AuditEngine[];
  /** Returns a ToolHost for an engine inside the given sandbox; `host: null` when it has none. */
  hostFor(engineId: string, sandbox: Sandbox, signal: AbortSignal): Promise<EngineHost>;
  detect(path: string): Promise<DetectedProject>;
  createSandbox?: typeof defaultCreateSandbox;
  /** §84 tool.log sink. Receives only redacted, sanitized, capped text. */
  log?(line: string): void;
}
/** Stage changes, and per-engine task progress (its total is known only once that engine has planned). */
export type ServiceEvent = { stage: AuditStage } | { engine: string; done: number; total: number };
export interface EngineRunOptions {
  changedFiles: string[];
  userCode: { allowed: boolean };
  signal?: AbortSignal;
  /** Failures in the sink are ignored. */
  onEvent?(event: ServiceEvent): void;
}
/** Per-task outcome. Ids and status only: no engine-supplied text travels in here. */
export interface TaskSummary {
  id: string;
  status: "ok" | "skipped" | "failed";
}
/** What happened to one engine in a run; `tasks` is empty when it did not apply or did not get to run. */
export interface EngineSummary {
  id: string;
  applicable: boolean;
  tasks: TaskSummary[];
}
export interface ServiceResult {
  findings: Finding[];
  notDone: NotDone[];
  completeness: Completeness;
  impact: ImpactContext;
  engines: EngineSummary[];
}

const LOG_CAP = 4000;

// Strip hidden characters first so they cannot split a secret past the redactor, redact, then cap.
const clean = (text: string, max: number): string =>
  sanitizeEngineText(redactSecrets(sanitizeEngineText(text, 100_000)), max);
/** Keeps the END of the text (the newest stderr lines); redaction runs on the whole text before the cut. */
const cleanTail = (text: string, max: number): string => {
  const whole = redactSecrets(sanitizeEngineText(text, 100_000));
  const points = Array.from(whole);
  return sanitizeEngineText(
    points.length <= max ? whole : `…${points.slice(points.length - max + 1).join("")}`,
    max,
  );
};
/** Never throws: String() throws for null-prototype and hostile thrown values. */
const messageOf = (err: unknown): string => {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
};
const safe = (err: unknown): string => clean(messageOf(err), 300) || "unknown error";
// Generous cap: runEngine cuts at 300 later, so a secret straddling that cut is already masked whole.
const PRE_CAP = 2000;
const cleanError = (err: unknown): Error =>
  new Error(clean(messageOf(err), PRE_CAP) || "unknown error");
async function scrubbed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw cleanError(err);
  }
}
function guardHost(host: ToolHost | null): ToolHost | null {
  return host && { call: (tool, args) => scrubbed(() => host.call(tool, args)) };
}
/** Engine text reaches runEngine (which truncates before anyone can redact) only after redaction. */
function guardEngine(engine: AuditEngine): AuditEngine {
  return {
    id: engine.id,
    detect: (ctx) => scrubbed(() => engine.detect(ctx)),
    plan: (ctx, impact) => scrubbed(() => engine.plan(ctx, impact)),
    async execute(task, rt) {
      const result = await scrubbed(() =>
        engine.execute(task, { ...rt, tools: guardHost(rt.tools) }),
      );
      return typeof result.note === "string"
        ? { ...result, note: clean(result.note, PRE_CAP) }
        : result;
    },
    normalize(result) {
      try {
        const produced: unknown = engine.normalize(result);
        // Not a list: pass it through untouched so runEngine reports it as such.
        if (!isIterableObject(produced)) return produced as Finding[];
        // Materialise here so a lazy iterable's throw is also caught and cleaned.
        return Array.from(produced, cleanCandidate) as Finding[];
      } catch (err) {
        throw cleanError(err);
      }
    },
  };
}
const isIterableObject = (v: unknown): v is Iterable<unknown> =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
/**
 * Redacts every free-text field of an untrusted finding candidate before runEngine truncates it.
 * Which fields are text is audit-core's call (`mapFindingText`), shared with runEngine's sanitizer.
 */
const cleanCandidate = (raw: unknown): unknown =>
  mapFindingText(raw, (text) => clean(text, PRE_CAP));
/** Valid, de-duplicated repo paths only; anything else a caller passes is dropped, not trusted. */
function cleanChangedFiles(files: readonly unknown[]): string[] {
  const kept = new Set<string>();
  for (const f of files) {
    const parsed = RepoPathSchema.safeParse(f);
    if (parsed.success) kept.add(parsed.data);
    if (kept.size >= 5000) break;
  }
  return [...kept];
}
/**
 * The caller's changed files scope the run even when no engine can compute an impact graph; an
 * impact-capable engine replaces this with its own result.
 */
function seedImpact(changedFiles: readonly unknown[]): ImpactContext {
  const seeded = ImpactContextSchema.safeParse({
    ...emptyImpact(),
    changedFiles: cleanChangedFiles(Array.isArray(changedFiles) ? changedFiles : []),
  });
  return seeded.success ? seeded.data : emptyImpact();
}
/** Engine-derived impact text gets the same redaction as findings; paths, numbers and ids are kept. */
function cleanImpact(i: ImpactContext): ImpactContext {
  return {
    ...i,
    businessDomain: i.businessDomain === null ? null : clean(i.businessDomain, 200),
    evidence: i.evidence.map((e) => ({ ...e, text: clean(e.text, 2000) })),
  };
}
const scrub = (n: NotDone): NotDone => ({
  what: clean(n.what, 300) || "unknown",
  reason: clean(n.reason, 500) || "unknown",
});

type ImpactCapable = AuditEngine & {
  impact(ctx: ProjectContext, changed: readonly string[]): Promise<ImpactContext>;
};
const hasImpact = (e: AuditEngine): e is ImpactCapable =>
  typeof (e as Partial<ImpactCapable>).impact === "function";

export function createEngineService(deps: EngineServiceDeps) {
  const makeSandbox = deps.createSandbox ?? defaultCreateSandbox;
  const log = (line: string): void => {
    try {
      deps.log?.(clean(line, LOG_CAP));
    } catch {
      /* a broken log sink must not break the run */
    }
  };

  return {
    /** Never throws: every failure becomes a `notDone` entry and a `partial` result. */
    async run(projectPath: string, opts: EngineRunOptions): Promise<ServiceResult> {
      const signal = opts.signal ?? new AbortController().signal;
      const findings = new Map<string, Finding>();
      const notDone: NotDone[] = [];
      const addNotDone = (n: NotDone): void => {
        const c = scrub(n);
        if (!notDone.some((x) => x.what === c.what && x.reason === c.reason)) notDone.push(c);
      };
      const engines: EngineSummary[] = [];
      const emit = (event: ServiceEvent): void => {
        try {
          opts.onEvent?.(event);
        } catch {
          /* a broken progress sink must not break the run */
        }
      };
      let impact = seedImpact(opts.changedFiles);
      let sandbox: Sandbox | null = null;

      try {
        if (signal.aborted) {
          addNotDone({ what: "审计", reason: "审计在开始前已取消" });
          return { findings: [], notDone, completeness: "partial", impact, engines };
        }
        emit({ stage: "reading" });
        const project = await deps.detect(projectPath);
        const files = await listProjectFiles(project.path);
        const context: ProjectContext = { project, rootDir: project.path, files };

        // detect FIRST: a non-applicable engine must not cost a host start or a sandbox copy.
        const ordered = [...deps.engines].sort(
          (a, b) => Number(hasImpact(b)) - Number(hasImpact(a)),
        );
        const applicable: { engine: AuditEngine; summary: EngineSummary }[] = [];
        for (const engine of ordered) {
          const summary: EngineSummary = {
            id: clean(engine.id, 100),
            applicable: false,
            tasks: [],
          };
          engines.push(summary);
          try {
            const detection = await engine.detect(context);
            if (detection.applicable) {
              summary.applicable = true;
              applicable.push({ engine, summary });
            } else {
              // A run that checked nothing must never read as complete.
              const why = typeof detection.reason === "string" ? clean(detection.reason, 200) : "";
              addNotDone({
                what: `${engine.id}: 全部检查`,
                reason: `不适用于此项目${why ? `（${why}）` : ""}`,
              });
            }
          } catch (err) {
            addNotDone({ what: `${engine.id}: 检测`, reason: safe(err) });
          }
        }

        if (applicable.length > 0) {
          sandbox = await makeSandbox(project.path);
          if (sandbox.skippedLarge > 0) {
            // Never copied, so no engine saw them: say so instead of reporting a complete run.
            addNotDone({
              what: "超大文件",
              reason: `${sandbox.skippedLarge} 个超过 10 MiB 的文件未检查`,
            });
          }
          emit({ stage: "checking" });
          for (const { engine, summary } of applicable) {
            if (signal.aborted) {
              addNotDone({ what: `${engine.id}: 全部检查`, reason: "审计已取消，未执行" });
              continue;
            }
            let eh: EngineHost | null = null;
            let onAbort: (() => void) | null = null;
            try {
              if (hasImpact(engine) && opts.changedFiles.length > 0) {
                const computed = ImpactContextSchema.safeParse(
                  await engine.impact(context, opts.changedFiles),
                );
                if (computed.success) impact = cleanImpact(computed.data);
                else addNotDone({ what: `${engine.id}: 影响范围`, reason: "结果未通过格式校验" });
              }
              const started = await deps.hostFor(engine.id, sandbox, signal);
              eh = started;
              // ToolHost.call has no signal: closing the host is what stops a hung engine call.
              const stop = (): void => {
                try {
                  void Promise.resolve(started.close()).catch(() => undefined);
                } catch {
                  /* best effort */
                }
              };
              onAbort = stop;
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
              const run = await runEngine(guardEngine(engine), {
                context,
                impact,
                projectDir: sandbox.projectDir,
                userCode: opts.userCode,
                signal,
                tools: started.host,
                onProgress: (done, total) => emit({ engine: summary.id, done, total }),
              });
              summary.tasks = run.tasks.map((t) => ({ id: clean(t.id, 200), status: t.status }));
              for (const f of run.findings) if (!findings.has(f.id)) findings.set(f.id, f);
              for (const n of run.notDone) addNotDone(n);
            } catch (err) {
              addNotDone({ what: `${engine.id}: 引擎未能运行`, reason: safe(err) });
            } finally {
              if (onAbort) signal.removeEventListener("abort", onAbort);
              if (eh) {
                // close first: stderr is only complete once the process has exited.
                try {
                  await eh.close();
                } catch {
                  /* best effort */
                }
                try {
                  const tail = eh.diagnostics?.();
                  if (tail) log(`${engine.id} stderr: ${cleanTail(tail, LOG_CAP - 100)}`);
                } catch {
                  /* best effort */
                }
              }
            }
          }
          if (signal.aborted) addNotDone({ what: "审计", reason: "已取消，结果不完整" });
        }
      } catch (err) {
        if (err instanceof SandboxError) {
          addNotDone({
            what: "项目隔离副本",
            reason:
              err.code === "too_large"
                ? "项目过大，无法在隔离环境中分析"
                : "项目在复制过程中发生了变化，已放弃本次分析",
          });
        } else {
          addNotDone({ what: "审计准备", reason: safe(err) });
        }
      } finally {
        await sandbox?.cleanup().catch(() => undefined);
      }
      emit({ stage: "concluding" });
      return {
        findings: [...findings.values()],
        notDone,
        completeness: notDone.length === 0 ? "complete" : "partial",
        impact,
        engines,
      };
    },
  };
}
