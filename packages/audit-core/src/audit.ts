import { z } from "zod";
import { FindingSchema } from "./finding";
import { RunSummarySchema } from "./gate";
import { CompletenessSchema, NotDoneSchema } from "./plan";

export const MAX_STORED_FINDINGS = 2000;
export const MAX_RUNS_PER_PROJECT = 50;
export const FINDINGS_PAGE_MAX = 50;

export const AuditRunStatusSchema = z.enum(["running", "completed", "cancelled", "failed"]);
export type AuditRunStatus = z.infer<typeof AuditRunStatusSchema>;

// Coarse on purpose: the UI maps these to its own stages; there is no percentage to fake.
export const AuditStageSchema = z.enum(["reading", "checking", "concluding"]);
export type AuditStage = z.infer<typeof AuditStageSchema>;

// Only the engine that has finished planning has a real denominator.
export const AuditProgressSchema = z
  .strictObject({
    engine: z.string().regex(/^[a-z][a-z0-9-]*$/),
    done: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .refine((p) => p.done <= p.total, { message: "done must be <= total" });
export type AuditProgress = z.infer<typeof AuditProgressSchema>;

export const TaskStatusSchema = z.enum(["ok", "skipped", "failed"]);
export const EngineSummarySchema = z.strictObject({
  id: z.string().min(1).max(100),
  applicable: z.boolean(),
  tasks: z.array(z.strictObject({ id: z.string().min(1).max(200), status: TaskStatusSchema })),
});
export type EngineSummaryData = z.infer<typeof EngineSummarySchema>;

export const AuditRunSchema = z
  .strictObject({
    id: z.string().min(1),
    projectId: z.string().min(1),
    status: AuditRunStatusSchema,
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    stage: AuditStageSchema.nullable(),
    progress: AuditProgressSchema.nullable(),
    completeness: CompletenessSchema.nullable(),
    notDone: z.array(NotDoneSchema),
    engines: z.array(EngineSummarySchema),
    findingCount: z.number().int().nonnegative(),
    // Computed once by `summarize` when the run finishes; null only while running.
    summary: RunSummarySchema.nullable(),
    // Only the newest finished run of a project is compared with the project as it is now; null = unknown.
    stale: z.boolean().nullable(),
    // First 8 hex of the project stamp taken when the run began (metadata, not content); null while
    // running and for runs that have no stamp.
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .nullable(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (r.status === "running") {
      if (r.finishedAt !== null) issue("finishedAt", "a running run has not finished");
      if (r.completeness !== null) issue("completeness", "a running run has no verdict yet");
      if (r.summary !== null) issue("summary", "a running run has no summary yet");
      if (r.stale !== null) issue("stale", "a running run cannot be stale");
      if (r.fingerprint !== null) issue("fingerprint", "a running run has no fingerprint yet");
      return;
    }
    if (r.finishedAt === null) issue("finishedAt", "a finished run needs finishedAt");
    if (r.stage !== null || r.progress !== null) issue("stage", "a finished run has no live stage");
    if (r.completeness === null) issue("completeness", "a finished run needs completeness");
    // A cancelled or failed run, or one with anything not done, must never read as complete.
    if (r.completeness === "complete" && (r.status !== "completed" || r.notDone.length > 0)) {
      issue("completeness", "only a completed run with nothing skipped can be complete");
    }
    if (r.summary === null) issue("summary", "a finished run needs a summary");
    else if (
      r.summary.gate === "ready" &&
      (r.status !== "completed" || r.completeness !== "complete" || r.notDone.length > 0)
    ) {
      issue("summary", "a run that is not complete can never be ready");
    }
  });
export type AuditRun = z.infer<typeof AuditRunSchema>;

const Id = z.string().min(1).max(200);
export const AuditRunParamsSchema = z.strictObject({ projectId: Id });
export const AuditCancelParamsSchema = z.strictObject({ runId: Id });
export const AuditHistoryParamsSchema = z.strictObject({
  projectId: Id,
  limit: z.number().int().min(1).max(MAX_RUNS_PER_PROJECT).optional(),
});
export const AuditHistoryResultSchema = z.strictObject({ runs: z.array(AuditRunSchema) });
export const FindingListParamsSchema = z.strictObject({
  runId: Id,
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(FINDINGS_PAGE_MAX).optional(),
});
export const FindingListResultSchema = z.strictObject({
  findings: z.array(FindingSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export const FindingDetailParamsSchema = z.strictObject({ runId: Id, id: Id });
