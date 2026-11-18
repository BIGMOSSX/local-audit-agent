import {
  type AuditEngine,
  type AuditTask,
  type EngineResult,
  type Finding,
  RepoPathSchema,
} from "@audit/audit-core";
import { extractAqeCoverage, findingsFromCoverage } from "./aqe";
import { findUntestedFiles } from "./coverage-gap";
import { fingerprint } from "./fingerprint";
import { detectTestFrameworks } from "./frameworks";
import { cleanFileList } from "./paths";

/** The only tool the host may be asked to call (R9). */
export const AQE_ALLOWED_TOOLS = ["coverage_analyze_sublinear"] as const;
const MAX_GAP_FINDINGS = 25;
const MAX_SCOPE = 5000;
const ENGINE = "quality";

const task = (kind: string, title: string, scope: string[], readOnly: boolean): AuditTask => ({
  id: `quality.${kind}`,
  engine: ENGINE,
  kind: `quality.${kind}`,
  title,
  scope,
  readOnly,
  networkRequired: false,
});

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CANCELLED = "已取消";

/** Runs `start`, but settles as aborted as soon as `signal` aborts; the late outcome is ignored. */
function raceAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve({ aborted: true });
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    new Promise<T>((r) => r(start())).then(
      (value) => {
        done();
        resolve({ aborted: false, value });
      },
      (err) => {
        done();
        reject(err);
      },
    );
  });
}

export function createQualityEngine(): AuditEngine {
  return {
    id: ENGINE,
    async detect(ctx) {
      const applicable =
        Array.isArray(ctx?.project?.ecosystems) && ctx.project.ecosystems.length > 0;
      return {
        applicable,
        reason: applicable ? "recognised ecosystem" : "no recognised ecosystem",
      };
    },
    async plan(ctx, impact) {
      // Scope entries must be clean repo paths (AuditTaskSchema); drop the rest instead of failing the plan.
      const changed = Array.isArray(impact?.changedFiles) ? impact.changedFiles : [];
      const scope = cleanFileList(changed).slice(0, MAX_SCOPE);
      return {
        projectPath: ctx.rootDir,
        tasks: [
          task("detect-frameworks", "Detect test framework", [], true),
          task("coverage-gap", "Find files without a test", scope, true),
          task("measured-coverage", "Read measured test coverage", [], true),
          task("run-tests", "Run existing tests", [], false),
        ],
      };
    },
    async execute(t, runtime): Promise<EngineResult> {
      const skipped = (note: string): EngineResult => ({
        taskId: t.id,
        status: "skipped",
        data: null,
        note,
      });
      try {
        if (runtime.signal.aborted) return skipped(CANCELLED);
        // Only runtime.projectDir (the sandbox copy) is ever read; context.rootDir is never opened.
        if (t.kind === "quality.measured-coverage") {
          if (runtime.tools === null) return skipped("engine not available");
          const tools = runtime.tools;
          const answer = await raceAbort(
            () =>
              tools.call(AQE_ALLOWED_TOOLS[0], { target: runtime.projectDir, detectGaps: true }),
            runtime.signal,
          );
          if (answer.aborted || runtime.signal.aborted) return skipped(CANCELLED);
          const raw = answer.value;
          const extracted = extractAqeCoverage(raw, runtime.projectDir);
          if (extracted.kind === "not-measured") {
            return skipped(
              "未找到测试覆盖率报告；运行一次带覆盖率的测试并生成 coverage/lcov.info 后再检查。",
            );
          }
          if (extracted.kind === "unmapped") {
            return {
              taskId: t.id,
              status: "failed",
              data: null,
              note: "覆盖率报告中的文件路径无法与项目对应，未能得出结论。",
            };
          }
          if (extracted.kind === "unreadable") {
            return { taskId: t.id, status: "failed", data: null, note: "覆盖率结果无法识别" };
          }
          return { taskId: t.id, status: "ok", data: { measuredCoverage: extracted.rows } };
        }
        const files = cleanFileList(runtime.context.files);
        if (t.kind === "quality.detect-frameworks") {
          const frameworks = detectTestFrameworks(runtime.projectDir, files, runtime.signal);
          if (runtime.signal.aborted) return skipped(CANCELLED);
          return { taskId: t.id, status: "ok", data: { frameworks } };
        }
        if (t.kind === "quality.coverage-gap") {
          const untested = findUntestedFiles(files);
          const inScope = new Set(t.scope);
          const scoped = inScope.size > 0 ? untested.filter((f) => inScope.has(f)) : untested;
          const frameworks = detectTestFrameworks(runtime.projectDir, files, runtime.signal);
          if (runtime.signal.aborted) return skipped(CANCELLED);
          return {
            taskId: t.id,
            status: "ok",
            data: { untested: scoped, frameworks: frameworks.map((f) => f.name) },
          };
        }
        if (t.kind === "quality.run-tests") {
          // §16 isolation mechanism does not exist yet, so never execute project code (R6).
          return skipped("无法在隔离环境中执行项目测试（§16 隔离机制尚未就绪）");
        }
        return skipped("未知的检查类型，已跳过");
      } catch {
        // An unexpected exception is a failed task, not a skipped one; the note is fixed text.
        return { taskId: t.id, status: "failed", data: null, note: "检查过程中出现意外错误" };
      }
    },
    normalize(result): Finding[] {
      if (result.status !== "ok" || !isPlain(result.data)) return [];
      if (result.taskId === "quality.measured-coverage") {
        const rows: unknown = result.data.measuredCoverage;
        return Array.isArray(rows) ? findingsFromCoverage(rows) : [];
      }
      if (result.taskId !== "quality.coverage-gap") return [];
      const data = result.data;
      // Engine data is untrusted: re-validate every path before it can reach a Finding.
      const untested = Array.isArray(data.untested)
        ? [
            ...new Set(
              data.untested.filter(
                (x): x is string => typeof x === "string" && RepoPathSchema.safeParse(x).success,
              ),
            ),
          ].sort()
        : [];
      const frameworks = Array.isArray(data.frameworks) ? data.frameworks : [];
      const findings: Finding[] = [];
      if (frameworks.length === 0) {
        findings.push({
          id: fingerprint([ENGINE, "no-test-framework"]),
          engine: ENGINE,
          ruleId: "quality.no-test-framework",
          title: "No test framework detected",
          severity: "medium",
          confidence: "medium",
          category: "testing",
          source: "heuristic",
          message:
            "No known test framework was found in the project files, so changes cannot be checked by automated tests.",
          evidence: [],
          remediation: "Add a test framework and at least one test for the main behaviour.",
        });
      }
      for (const file of untested.slice(0, MAX_GAP_FINDINGS)) {
        findings.push({
          id: fingerprint([ENGINE, "missing-test", file]),
          engine: ENGINE,
          ruleId: "quality.missing-test",
          title: `No test found for ${file}`,
          severity: "low",
          confidence: "low",
          category: "testing",
          source: "heuristic",
          file,
          message: `No test file with a matching name was found for ${file}. Coverage was estimated from file names only.`,
          evidence: [],
          remediation: "Add a test that exercises this file.",
        });
      }
      if (untested.length > MAX_GAP_FINDINGS) {
        const left = untested.length - MAX_GAP_FINDINGS;
        findings.push({
          id: fingerprint([ENGINE, "missing-test-truncated"]),
          engine: ENGINE,
          ruleId: "quality.missing-test-truncated",
          title: "More files without a test",
          severity: "info",
          confidence: "low",
          category: "testing",
          source: "heuristic",
          message: `${left} more files without a matching test are not listed individually; only the first ${MAX_GAP_FINDINGS} (in path order) are shown.`,
          evidence: [],
        });
      }
      return findings;
    },
  };
}
