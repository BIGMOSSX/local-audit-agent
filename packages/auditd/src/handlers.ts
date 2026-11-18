import {
  AuditCancelParamsSchema,
  AuditHistoryParamsSchema,
  AuditRunParamsSchema,
  type DetectedProject,
  FINDINGS_PAGE_MAX,
  FindingDetailParamsSchema,
  FindingListParamsSchema,
  type LocalModelService,
  MAX_RUNS_PER_PROJECT,
  ModelsListParamsSchema,
  ProjectListParamsSchema,
  ProjectOpenParamsSchema,
  ProjectStatusParamsSchema,
} from "@audit/audit-core";
import type { ZodType } from "zod";
import { detectProject } from "./detect";
import { IpcError } from "./errors";
import { probeLoopbackModels } from "./model-probe";
import type { Orchestrator } from "./orchestrator";
import type { ProjectsRepo } from "./projects-repo";
import type { Handlers } from "./server";

export interface HandlerDeps {
  repo: ProjectsRepo;
  detect?: (path: string) => Promise<DetectedProject>;
  probeModels?: () => Promise<LocalModelService[]>;
  /** Without it the audit methods stay unimplemented. */
  orchestrator?: Orchestrator;
}

// Only the first issue, capped: a client-chosen key name must not bloat the reply.
const MAX_PARAM_MESSAGE = 200;

function parseParams<T>(schema: ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.join(".") || "params";
  const message = `Invalid parameters: ${where}: ${issue?.message ?? "invalid"}`;
  throw new IpcError("invalid_params", message.slice(0, MAX_PARAM_MESSAGE));
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const { repo } = deps;
  const detect = deps.detect ?? detectProject;
  const probeModels = deps.probeModels ?? (() => probeLoopbackModels());

  const { orchestrator } = deps;
  const auditHandlers: Handlers = orchestrator
    ? {
        // Returns at once with the running run; the work continues in the background.
        "audit.run": async (params) => {
          const { projectId } = parseParams(AuditRunParamsSchema, params);
          return orchestrator.start(projectId);
        },
        "audit.cancel": async (params) => {
          const { runId } = parseParams(AuditCancelParamsSchema, params);
          return orchestrator.cancel(runId);
        },
        "audit.history": async (params) => {
          const { projectId, limit } = parseParams(AuditHistoryParamsSchema, params);
          return { runs: await orchestrator.history(projectId, limit ?? MAX_RUNS_PER_PROJECT) };
        },
        "finding.list": async (params) => {
          const { runId, offset, limit } = parseParams(FindingListParamsSchema, params);
          return orchestrator.findings(runId, offset ?? 0, limit ?? FINDINGS_PAGE_MAX);
        },
        "finding.detail": async (params) => {
          const { runId, id } = parseParams(FindingDetailParamsSchema, params);
          return orchestrator.finding(runId, id);
        },
      }
    : {};

  return {
    ...auditHandlers,
    // Repository errors (corrupt row, SQLite) are deliberately not caught here: server.ts logs them
    // with the stack and replies a generic `internal` error, so no raw text reaches a client.
    "project.open": async (params) => {
      const { path } = parseParams(ProjectOpenParamsSchema, params);
      return repo.upsert(await detect(path));
    },

    "project.list": async (params) => {
      parseParams(ProjectListParamsSchema, params);
      return { projects: repo.list() };
    },

    "project.status": async (params) => {
      const { id } = parseParams(ProjectStatusParamsSchema, params);
      const known = repo.get(id);
      if (!known) throw new IpcError("not_found", "No such project.");
      try {
        const fresh = repo.refresh(id, await detect(known.path));
        if (!fresh) throw new IpcError("not_found", "No such project.");
        return { ...fresh, pathExists: true };
      } catch (err) {
        if (err instanceof IpcError && err.code === "invalid_path")
          return { ...known, pathExists: false };
        throw err;
      }
    },

    // Read-only and not persisted (spec §35.2 item 6): a loopback probe, never project content.
    "models.list": async (params) => {
      parseParams(ModelsListParamsSchema, params);
      return { services: await probeModels() };
    },
  };
}
