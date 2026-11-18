import { z } from "zod";
import { RepoPathSchema } from "./finding";

export const AuditTaskSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  engine: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  title: z.string().min(1).max(200),
  scope: z.array(RepoPathSchema).max(5000),
  // false = the task runs project code (tests, scripts) and needs §16 consent.
  readOnly: z.boolean(),
  // true = needs outbound network; §16 prompt hook (R12). Skipped by runEngine until consent exists.
  networkRequired: z.boolean(),
});
export type AuditTask = z.infer<typeof AuditTaskSchema>;

export const AuditPlanSchema = z
  .strictObject({
    projectPath: z.string().min(1),
    tasks: z.array(AuditTaskSchema).max(200),
  })
  .refine((p) => new Set(p.tasks.map((t) => t.id)).size === p.tasks.length, {
    message: "task ids must be unique",
    path: ["tasks"],
  });
export type AuditPlan = z.infer<typeof AuditPlanSchema>;

export const CompletenessSchema = z.enum(["complete", "partial"]);
export type Completeness = z.infer<typeof CompletenessSchema>;

export const NotDoneSchema = z.strictObject({
  what: z.string().min(1).max(300),
  reason: z.string().min(1).max(500),
});
export type NotDone = z.infer<typeof NotDoneSchema>;
