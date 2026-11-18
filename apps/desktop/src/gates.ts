import type { AuditRun } from "@audit/audit-core";

export type GateId = "understand" | "run" | "scan" | "conclude";
export const GATE_IDS: readonly GateId[] = ["understand", "run", "scan", "conclude"];

/**
 * `skipped` is a gate this version cannot do at all (see SKIPPED_GATES); it is never current and
 * never passed. While a run is going the others are only passed / current / waiting, never "done".
 */
export type GateState = "passed" | "current" | "waiting" | "skipped";

/** Why a gate is not done: it needs an AI model, or it would run the project's own code. */
export type SkipReason = "model" | "run";

/**
 * The one place that says which gates this version cannot do. Flip an entry when its path exists:
 * 读懂项目 once a model can be connected; 试运行测试 never without per-project consent and a
 * verified per-OS isolation (§16, the daemon pins `userCode.allowed` to false).
 */
export const SKIPPED_GATES: Partial<Record<GateId, SkipReason>> = {
  understand: "model",
  run: "run",
};

export interface GateRow {
  id: GateId;
  state: GateState;
  /** Set only when `state` is `skipped`. */
  skipReason: SkipReason | null;
  /** A real done/total of the engine currently executing, or null. */
  progress: { done: number; total: number } | null;
  /** True for the current gate when no number exists: the UI must not invent one. */
  indeterminate: boolean;
}

// Where each daemon stage lands before skipped gates are stepped over. Every engine's progress is
// reported by the "checking" stage, and counts toward 找安全漏洞: neither engine runs project code,
// and understanding the project is a model task.
const STAGE_GATE: Record<"reading" | "checking" | "concluding", GateId> = {
  reading: "understand",
  checking: "scan",
  concluding: "conclude",
};

const ENGINE_PREFIX = /^[a-z][a-z0-9-]*:\s*/;

/** Engine-level not-done items read `<engine-id>: …`; the id is internal and only belongs in 高级. */
export function plainWhat(what: string): string {
  return what.replace(ENGINE_PREFIX, "");
}

/**
 * Not-done names the daemon, the orchestrator and audit-core write themselves (after `plainWhat`).
 * Anything else may be text an engine supplied, and the archived report shows fixed phrases only.
 * Extend this list when a new fixed phrase is added in packages/auditd or packages/audit-core.
 */
export const FIXED_NOT_DONE: readonly (string | RegExp)[] = [
  "审计",
  "检查",
  "超大文件",
  "项目隔离副本",
  "审计准备",
  "发现项过多",
  "读懂项目、生成测试、安全深度分析",
  "需要联网的检查",
  "运行项目测试",
  "全部检查",
  "检测",
  "影响范围",
  "引擎未能运行",
  "detect",
  "plan",
  "发现项编号重复，已忽略较晚的一条",
  /^\d{1,6} 条无效结果已丢弃$/,
  /^\d{1,6} 条结果的引擎标识不符，已丢弃$/,
];

export function isFixedNotDone(what: string): boolean {
  const plain = plainWhat(what);
  return FIXED_NOT_DONE.some((f) => (typeof f === "string" ? f === plain : f.test(plain)));
}

export function gatesOf(run: AuditRun): GateRow[] {
  const stage = run.stage ?? "reading";
  let current = GATE_IDS.indexOf(STAGE_GATE[stage]);
  while (
    SKIPPED_GATES[GATE_IDS[current] as GateId] !== undefined &&
    current < GATE_IDS.length - 1
  ) {
    current += 1;
  }
  const progress =
    stage === "checking" && run.progress
      ? { done: run.progress.done, total: run.progress.total }
      : null;
  return GATE_IDS.map((id, i): GateRow => {
    const skipReason = SKIPPED_GATES[id] ?? null;
    if (skipReason !== null) {
      return { id, state: "skipped", skipReason, progress: null, indeterminate: false };
    }
    return {
      id,
      state: i < current ? "passed" : i === current ? "current" : "waiting",
      skipReason: null,
      progress: i === current ? progress : null,
      indeterminate: i === current && progress === null,
    };
  });
}
