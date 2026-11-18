import {
  type AuditEngine,
  type AuditTask,
  type EngineResult,
  type Finding,
  type ImpactContext,
  ImpactContextSchema,
  type ProjectContext,
  RepoPathSchema,
} from "@audit/audit-core";
import { fingerprint } from "./fingerprint";
import { type ImportGraph, ImportGraphSchema } from "./graph";
import { analyzeImpact, computeImpact, MAX_IMPACT_LIST } from "./impact";

const ENGINE = "code-intelligence";
const TASK_KIND = "code-intelligence.impact-review";
const MAX_SCOPE = 5000;
const CANCELLED = "已取消";

export interface CodeIntelligenceOptions {
  wideAffectedThreshold?: number;
  highComplexity?: number;
}
export interface CodeIntelligenceEngine extends AuditEngine {
  impact(ctx: ProjectContext, changedFiles: readonly string[]): Promise<ImpactContext>;
}

const threshold = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) && v >= 1 ? v : fallback;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createCodeIntelligenceEngine(
  injected: ImportGraph | null = null,
  options: CodeIntelligenceOptions = {},
): CodeIntelligenceEngine {
  const graph =
    injected !== null && ImportGraphSchema.safeParse(injected).success ? injected : null;
  const wide = threshold(options.wideAffectedThreshold, 20);
  const highComplexity = threshold(options.highComplexity, 30);
  return {
    id: ENGINE,
    async detect() {
      return graph === null
        ? { applicable: false, reason: "no dependency graph available" }
        : { applicable: true, reason: "dependency graph available" };
    },
    async impact(_ctx, changedFiles) {
      return computeImpact(graph ?? { nodes: [], edges: [] }, changedFiles);
    },
    async plan(ctx, impact) {
      const changed = Array.isArray(impact?.changedFiles) ? impact.changedFiles : [];
      const scope = [
        ...new Set(
          changed.filter((f) => typeof f === "string" && RepoPathSchema.safeParse(f).success),
        ),
      ].slice(0, MAX_SCOPE);
      const task: AuditTask = {
        id: TASK_KIND,
        engine: ENGINE,
        kind: TASK_KIND,
        title: "Review change impact",
        scope,
        readOnly: true,
        networkRequired: false,
      };
      return { projectPath: ctx.rootDir, tasks: scope.length === 0 ? [] : [task] };
    },
    async execute(task, runtime): Promise<EngineResult> {
      const skipped = (note: string): EngineResult => ({
        taskId: task.id,
        status: "skipped",
        data: null,
        note,
      });
      if (runtime.signal.aborted) return skipped(CANCELLED);
      if (task.kind !== TASK_KIND) return skipped("未知的检查类型，已跳过");
      if (graph === null) return skipped("没有可用的依赖关系图");
      try {
        return { taskId: task.id, status: "ok", data: analyzeImpact(graph, task.scope) };
      } catch {
        return { taskId: task.id, status: "failed", data: null, note: "检查过程中出现意外错误" };
      }
    },
    normalize(result): Finding[] {
      if (result.status !== "ok" || result.taskId !== TASK_KIND) return [];
      // Engine data is untrusted: only a fully valid ImpactContext may reach a Finding.
      if (!isPlain(result.data)) return [];
      const parsed = ImpactContextSchema.safeParse(result.data.impact);
      if (!parsed.success) return [];
      const impact = parsed.data;
      const reported = result.data.affectedTotal;
      const exact =
        typeof reported === "number" &&
        Number.isSafeInteger(reported) &&
        reported >= impact.affectedFiles.length;
      const affectedTotal = exact ? reported : impact.affectedFiles.length;
      const affectedCapped = !exact && affectedTotal >= MAX_IMPACT_LIST;
      const count = (n: number, capped: boolean) => (capped ? `at least ${n}` : String(n));
      const [only] = impact.changedFiles;
      const out: Finding[] = [];
      if (affectedTotal >= wide) {
        const affectedLabel = count(affectedTotal, affectedCapped);
        const changedLabel = count(
          impact.changedFiles.length,
          impact.changedFiles.length >= MAX_IMPACT_LIST,
        );
        out.push({
          id: fingerprint([ENGINE, "wide-impact", ...impact.changedFiles]),
          engine: ENGINE,
          ruleId: "code-intelligence.wide-impact",
          title: `Change touches ${affectedLabel} dependent files`,
          severity: "info",
          confidence: "medium",
          category: "architecture",
          source: "static-analysis",
          message: `${changedLabel} changed file(s) are imported directly by ${affectedLabel} other files.`,
          evidence: impact.affectedFiles.slice(0, 20).map((file) => ({
            kind: "graph" as const,
            file,
            text:
              impact.changedFiles.length === 1 && only !== undefined
                ? `imports ${only}`
                : "imports a changed file",
          })),
        });
      }
      for (const { file, score } of impact.complexity) {
        if (score < highComplexity) continue;
        out.push({
          id: fingerprint([ENGINE, "high-complexity", file]),
          engine: ENGINE,
          ruleId: "code-intelligence.high-complexity",
          title: `High complexity in changed file ${file}`,
          severity: "info",
          confidence: "medium",
          category: "maintainability",
          source: "static-analysis",
          file,
          message: `${file} has a complexity score of ${score}.`,
          evidence: [{ kind: "metric", file, text: `complexity=${score}` }],
        });
      }
      return out;
    },
  };
}
