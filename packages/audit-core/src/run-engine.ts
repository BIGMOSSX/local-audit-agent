import type { AuditEngine, ExecutionContext, ProjectContext, ToolHost } from "./engine";
import { type Finding, FindingSchema, type FindingTextField, mapFindingText } from "./finding";
import type { ImpactContext } from "./impact";
import { type AuditPlan, AuditPlanSchema, type Completeness, type NotDone } from "./plan";
import { sanitizeEngineText } from "./text";

export interface RunEngineInput {
  readonly context: ProjectContext;
  readonly impact: ImpactContext;
  readonly projectDir: string;
  readonly userCode: { readonly allowed: boolean };
  readonly signal: AbortSignal;
  readonly tools: ToolHost | null;
  /** (0, n) once the plan is known, then once per settled task. Failures in it are ignored. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface EngineRun {
  readonly engine: string;
  readonly findings: Finding[];
  readonly notDone: NotDone[];
  readonly completeness: Completeness;
  readonly tasks: { id: string; status: "ok" | "skipped" | "failed" }[];
}

export const NOT_DONE_NO_NETWORK: NotDone = {
  what: "需要联网的检查",
  reason: "未获联网授权，未执行",
};

export const NOT_DONE_NO_ISOLATION: NotDone = {
  what: "运行项目测试",
  reason: "无法在隔离环境中执行（未获用户授权或隔离机制不可用）",
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Sanitizes the free-text fields of an untrusted candidate BEFORE schema validation, so padding with
 * invisible characters is cleaned rather than rejected. Anything not shaped as expected is left
 * untouched for FindingSchema to reject.
 */
const TEXT_CAPS: Record<FindingTextField, number> = {
  title: 200,
  message: 2000,
  remediation: 2000,
  "evidence.text": 2000,
  verifyAfterFix: 500,
};
function sanitizeCandidate(raw: unknown): unknown {
  const mapped = mapFindingText(raw, (text, field) => sanitizeEngineText(text, TEXT_CAPS[field]));
  if (!isPlainObject(mapped)) return mapped;
  const out: Record<string, unknown> = mapped;
  if (out.title === "") out.title = "(untitled)";
  if (out.message === "") out.message = "(no message)";
  if (Array.isArray(out.verifyAfterFix)) {
    const kept = out.verifyAfterFix.filter((v: unknown) => v !== "");
    if (kept.length === 0) delete out.verifyAfterFix;
    else out.verifyAfterFix = kept;
  }
  return out;
}

/** Never throws: String() itself throws for null-prototype objects and hostile toString/getters. */
function describeError(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "未知错误";
  }
}

function isIterableObject(v: unknown): v is Iterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

/**
 * The single path from engine output to a Finding. Never throws; every returned Finding has passed
 * FindingSchema both before and after text sanitizing. Adapters must honor `input.signal` themselves:
 * there is no timeout race here, only a check between tasks.
 */
export async function runEngine(engine: AuditEngine, input: RunEngineInput): Promise<EngineRun> {
  const findings = new Map<string, Finding>();
  const notDone: NotDone[] = [];
  const tasks: EngineRun["tasks"] = [];
  const done = (): EngineRun => ({
    engine: engine.id,
    findings: [...findings.values()],
    notDone,
    completeness: notDone.length === 0 ? "complete" : "partial",
    tasks,
  });
  // Every not-done entry goes through here so NotDoneSchema (what <= 300, reason <= 500) always holds.
  const note = (what: string, reason: string) =>
    notDone.push({
      what: sanitizeEngineText(what, 300) || "unknown",
      reason: sanitizeEngineText(reason, 300) || "unknown",
    });
  const fail = (what: string, err: unknown) => note(what, describeError(err));

  if (input.signal.aborted) {
    note(`${engine.id}: 全部检查`, "审计在开始前已取消");
    return done();
  }

  try {
    const detection = await engine.detect(input.context);
    if (!detection.applicable) return done();
  } catch (err) {
    fail(`${engine.id}: detect`, err);
    return done();
  }

  let plan: AuditPlan;
  try {
    plan = AuditPlanSchema.parse(await engine.plan(input.context, input.impact));
  } catch (err) {
    fail(`${engine.id}: plan`, err);
    return done();
  }

  const total = plan.tasks.length;
  let settled = 0;
  const progress = (): void => {
    try {
      input.onProgress?.(settled, total);
    } catch {
      /* a broken progress sink must not break the run */
    }
  };
  if (total > 0) progress();

  let invalid = 0;
  let foreign = 0;
  let conflicting = 0;
  for (const task of plan.tasks) {
    if (input.signal.aborted) {
      tasks.push({ id: task.id, status: "skipped" });
      note(`${engine.id}: ${task.id}`, "已取消");
      settled += 1;
      progress();
      continue;
    }
    if (task.networkRequired) {
      tasks.push({ id: task.id, status: "skipped" });
      if (!notDone.some((n) => n.what === NOT_DONE_NO_NETWORK.what)) {
        notDone.push(NOT_DONE_NO_NETWORK);
      }
      settled += 1;
      progress();
      continue;
    }
    if (!task.readOnly && !input.userCode.allowed) {
      tasks.push({ id: task.id, status: "skipped" });
      if (!notDone.some((n) => n.what === NOT_DONE_NO_ISOLATION.what)) {
        notDone.push(NOT_DONE_NO_ISOLATION);
      }
      settled += 1;
      progress();
      continue;
    }
    const runtime: ExecutionContext = {
      context: input.context,
      projectDir: input.projectDir,
      scope: task.scope,
      userCode: input.userCode,
      signal: input.signal,
      tools: input.tools,
    };
    // Exactly one `tasks` entry per id: it is pushed once, after everything that can throw has run.
    let status: "ok" | "skipped" | "failed" = "failed";
    try {
      const result = await engine.execute(task, runtime);
      if (result.status !== "ok") {
        status = result.status === "skipped" ? "skipped" : "failed";
        note(`${engine.id}: ${task.title}`, result.note ?? result.status);
      } else {
        const produced = engine.normalize(result);
        if (!isIterableObject(produced)) throw new Error("normalize did not return a list");
        const candidates = Array.from(produced);
        for (const candidate of candidates) {
          try {
            const parsed = FindingSchema.safeParse(sanitizeCandidate(candidate));
            if (!parsed.success) {
              invalid += 1;
            } else if (parsed.data.engine !== engine.id) {
              foreign += 1;
            } else {
              const earlier = findings.get(parsed.data.id);
              if (!earlier) findings.set(parsed.data.id, parsed.data);
              // First wins. An identical repeat is harmless; different content under one id is not.
              else if (JSON.stringify(earlier) !== JSON.stringify(parsed.data)) conflicting += 1;
            }
          } catch {
            invalid += 1;
          }
        }
        status = "ok";
      }
    } catch (err) {
      status = "failed";
      fail(`${engine.id}: ${task.title}`, err);
    }
    tasks.push({ id: task.id, status });
    settled += 1;
    progress();
  }
  if (invalid > 0) {
    note(`${engine.id}: ${invalid} 条无效结果已丢弃`, "结果未通过格式校验");
  }
  if (foreign > 0) {
    note(`${engine.id}: ${foreign} 条结果的引擎标识不符，已丢弃`, "结果不属于当前检查引擎");
  }
  if (conflicting > 0) {
    note(
      `${engine.id}: 发现项编号重复，已忽略较晚的一条`,
      `${conflicting} 条结果与同编号的先前结果内容不一致`,
    );
  }
  return done();
}
