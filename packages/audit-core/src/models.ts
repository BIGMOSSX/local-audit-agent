import { z } from "zod";

export const MODEL_ID_MAX = 200;
export const MODELS_PER_SERVICE_MAX = 200;

export const LocalModelServiceSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  models: z.array(z.string().min(1).max(MODEL_ID_MAX)).max(MODELS_PER_SERVICE_MAX),
});
export type LocalModelService = z.infer<typeof LocalModelServiceSchema>;

export const ModelsListParamsSchema = z.strictObject({});
export const ModelsListResultSchema = z.strictObject({
  services: z.array(LocalModelServiceSchema),
});
export type ModelsListResult = z.infer<typeof ModelsListResultSchema>;
