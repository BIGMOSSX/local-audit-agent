import {
  AuditHistoryResultSchema,
  type AuditRun,
  AuditRunSchema,
  FINDINGS_PAGE_MAX,
  type Finding,
  FindingListResultSchema,
  type IpcErrorCode,
  IpcErrorCodeSchema,
  type LocalModelService,
  MAX_STORED_FINDINGS,
  ModelsListResultSchema,
  type Project,
  ProjectListResultSchema,
  ProjectSchema,
} from "@audit/audit-core";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ShellErrorCode = "sidecar_unavailable" | "sidecar_protocol" | "sidecar_io";
export type ClientErrorCode = IpcErrorCode | ShellErrorCode;

const SHELL_CODES: readonly string[] = ["sidecar_unavailable", "sidecar_protocol", "sidecar_io"];

function isClientErrorCode(value: unknown): value is ClientErrorCode {
  return (
    IpcErrorCodeSchema.safeParse(value).success ||
    (typeof value === "string" && SHELL_CODES.includes(value))
  );
}

export class IpcCallError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = "IpcCallError";
    this.code = code;
  }
}

export type Transport = (method: string, params?: unknown) => Promise<unknown>;

export interface ProjectClient {
  list(): Promise<Project[]>;
  open(path: string): Promise<Project>;
}

export interface ModelClient {
  list(): Promise<LocalModelService[]>;
}

export interface AuditClient {
  run(projectId: string): Promise<AuditRun>;
  cancel(runId: string): Promise<AuditRun>;
  history(projectId: string, limit: number): Promise<AuditRun[]>;
  /** Every stored finding of a run (at most MAX_STORED_FINDINGS), fetched page by page. */
  findings(runId: string): Promise<Finding[]>;
}

export function toCallError(raw: unknown): IpcCallError {
  if (raw instanceof IpcCallError) return raw;
  if (typeof raw === "object" && raw !== null) {
    const { code, message } = raw as { code?: unknown; message?: unknown };
    if (typeof message === "string") {
      return new IpcCallError(isClientErrorCode(code) ? code : "internal", message);
    }
    if (raw instanceof Error) return new IpcCallError("internal", raw.message);
  }
  return new IpcCallError("internal", typeof raw === "string" ? raw : "Unknown error");
}

const protocolError = () =>
  new IpcCallError("sidecar_protocol", "The local service sent an unexpected reply.");

export function createProjectClient(transport: Transport): ProjectClient {
  return {
    async list() {
      const parsed = ProjectListResultSchema.safeParse(await transport("project.list", {}));
      if (!parsed.success) throw protocolError();
      return parsed.data.projects;
    },
    async open(path) {
      const parsed = ProjectSchema.safeParse(await transport("project.open", { path }));
      if (!parsed.success) throw protocolError();
      return parsed.data;
    },
  };
}

export function createModelClient(transport: Transport): ModelClient {
  return {
    async list() {
      const parsed = ModelsListResultSchema.safeParse(await transport("models.list", {}));
      if (!parsed.success) throw protocolError();
      return parsed.data.services;
    },
  };
}

export function createAuditClient(transport: Transport): AuditClient {
  const parseRun = (raw: unknown): AuditRun => {
    const parsed = AuditRunSchema.safeParse(raw);
    if (!parsed.success) throw protocolError();
    return parsed.data;
  };
  return {
    async run(projectId) {
      return parseRun(await transport("audit.run", { projectId }));
    },
    async cancel(runId) {
      return parseRun(await transport("audit.cancel", { runId }));
    },
    async history(projectId, limit) {
      const raw = await transport("audit.history", { projectId, limit });
      const parsed = AuditHistoryResultSchema.safeParse(raw);
      if (!parsed.success) throw protocolError();
      return parsed.data.runs;
    },
    async findings(runId) {
      const out: Finding[] = [];
      const maxPages = Math.ceil(MAX_STORED_FINDINGS / FINDINGS_PAGE_MAX);
      for (let page = 0; page < maxPages; page++) {
        const raw = await transport("finding.list", {
          runId,
          offset: page * FINDINGS_PAGE_MAX,
          limit: FINDINGS_PAGE_MAX,
        });
        const parsed = FindingListResultSchema.safeParse(raw);
        if (!parsed.success) throw protocolError();
        out.push(...parsed.data.findings);
        if (parsed.data.findings.length === 0 || out.length >= parsed.data.total) break;
      }
      return out;
    },
  };
}

export const tauriTransport: Transport = async (method, params) => {
  try {
    return await invoke("ipc_call", { method, params: params ?? null });
  } catch (raw) {
    throw toCallError(raw);
  }
};

export async function tauriPickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}
