import type { IpcErrorCode } from "@audit/audit-core";

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}
