export const IPC_METHODS = [
  "project.open",
  "project.list",
  "project.status",
  "audit.plan",
  "audit.run",
  "audit.cancel",
  "audit.history",
  "finding.list",
  "finding.detail",
  "finding.suppress",
  "agent.chat",
  "agent.cancel",
  "tools.list",
  "tools.install",
  "tools.remove",
  "models.list",
  "models.configure",
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

export function isIpcMethod(value: unknown): value is IpcMethod {
  return typeof value === "string" && (IPC_METHODS as readonly string[]).includes(value);
}
