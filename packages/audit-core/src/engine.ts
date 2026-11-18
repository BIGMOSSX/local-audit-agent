import type { Finding } from "./finding";
import type { ImpactContext } from "./impact";
import type { AuditPlan, AuditTask } from "./plan";
import type { DetectedProject } from "./project";

export interface ProjectContext {
  readonly project: DetectedProject;
  /** Absolute path of the real project (read-only for engines that must not touch it). */
  readonly rootDir: string;
  /** Repo-relative POSIX paths of every regular file, already filtered and capped by the daemon. */
  readonly files: readonly string[];
}

export interface Detection {
  readonly applicable: boolean;
  readonly reason: string;
}

/** A sandboxed capability an engine may call. The daemon implements it; engines never spawn. */
export interface ToolHost {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ExecutionContext {
  readonly context: ProjectContext;
  /** Read-only sandbox copy the engine must use instead of `context.rootDir`. */
  readonly projectDir: string;
  readonly scope: readonly string[];
  /** §16 consent for tasks with `readOnly: false`. */
  readonly userCode: { readonly allowed: boolean };
  readonly signal: AbortSignal;
  readonly tools: ToolHost | null;
}

export interface EngineResult {
  readonly taskId: string;
  readonly status: "ok" | "skipped" | "failed";
  /** Untrusted engine data. `normalize` must validate it before use. */
  readonly data: unknown;
  readonly note?: string;
}

export interface AuditEngine {
  readonly id: string;
  detect(ctx: ProjectContext): Promise<Detection>;
  plan(ctx: ProjectContext, impact: ImpactContext): Promise<AuditPlan>;
  execute(task: AuditTask, runtime: ExecutionContext): Promise<EngineResult>;
  normalize(result: EngineResult): Finding[];
}
