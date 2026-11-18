import { z } from "zod";

export const IpcErrorCodeSchema = z.enum([
  "unauthorized",
  "bad_request",
  "method_not_allowed",
  "method_not_implemented",
  "invalid_params",
  "not_found",
  "invalid_path",
  "busy",
  "internal",
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;
