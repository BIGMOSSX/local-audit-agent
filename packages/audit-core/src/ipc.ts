import { z } from "zod";
import { IpcErrorCodeSchema } from "./errors";

const IpcIdSchema = z.union([z.string(), z.number().int()]);

export const IpcRequestSchema = z.strictObject({
  id: IpcIdSchema,
  token: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export const IpcResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: IpcIdSchema, ok: z.literal(true), result: z.unknown().optional() }),
  z.strictObject({
    id: IpcIdSchema.nullable(),
    ok: z.literal(false),
    error: z.strictObject({ code: IpcErrorCodeSchema, message: z.string() }),
  }),
]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
