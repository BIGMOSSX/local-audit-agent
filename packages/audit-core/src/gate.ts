import { z } from "zod";
import type { AuditRunStatus, EngineSummaryData } from "./audit";
import type { Finding } from "./finding";
import type { Completeness, NotDone } from "./plan";

// `none` is a fourth state on purpose: a run in which nothing ran must not be yellow or green.
export const GateSchema = z.enum(["blocked", "review", "ready", "none"]);
export type Gate = z.infer<typeof GateSchema>;

export type Bucket = "must" | "should" | "later";

const Count = z.number().int().nonnegative();
export const RunSummarySchema = z.strictObject({
  gate: GateSchema,
  counts: z.strictObject({ must: Count, should: Count, later: Count }),
  checked: Count,
  skipped: Count,
  failed: Count,
  /** Findings that must be resolved before the gate can improve: every `must` and every high/critical `should`. */
  needed: Count,
  /** What the gate would be once `needed` findings are fixed (never better than what the run actually covered). */
  afterFix: GateSchema,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

type Rated = Pick<Finding, "severity" | "confidence" | "category" | "source">;

/** §10/§35 buckets. Model reasoning alone never blocks (§55), so `ai-reasoning` is capped at `should`. */
export function bucketOf(f: Rated): Bucket {
  const blocker =
    (f.severity === "critical" && f.confidence !== "low") ||
    (f.category === "secret" &&
      f.confidence === "high" &&
      (f.severity === "critical" || f.severity === "high"));
  if (blocker && f.source !== "ai-reasoning") return "must";
  if (f.severity === "low" || f.severity === "info") return "later";
  return "should";
}

const BUCKET_RANK: Record<Bucket, number> = { must: 0, should: 1, later: 2 };
const SEVERITY_RANK: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Stable sort: must before should before later, then by severity. Used before any cut so a blocker is never cut. */
export function sortByImportance<T extends Rated>(findings: readonly T[]): T[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        BUCKET_RANK[bucketOf(a.f)] - BUCKET_RANK[bucketOf(b.f)] ||
        SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] ||
        a.i - b.i,
    )
    .map((x) => x.f);
}

export interface SummarizeInput {
  status: Exclude<AuditRunStatus, "running">;
  completeness: Completeness;
  notDone: readonly NotDone[];
  engines: readonly EngineSummaryData[];
  findings: readonly Rated[];
}

export function summarize(input: SummarizeInput): RunSummary {
  const counts = { must: 0, should: 0, later: 0 };
  let needed = 0;
  for (const f of input.findings) {
    const bucket = bucketOf(f);
    counts[bucket] += 1;
    if (
      bucket === "must" ||
      (bucket === "should" && (f.severity === "high" || f.severity === "critical"))
    ) {
      needed += 1;
    }
  }
  let checked = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of input.engines) {
    for (const t of e.tasks) {
      if (t.status === "ok") checked += 1;
      else if (t.status === "skipped") skipped += 1;
      else failed += 1;
    }
  }
  const covered =
    input.status === "completed" &&
    input.completeness === "complete" &&
    input.notDone.length === 0 &&
    skipped === 0 &&
    failed === 0;
  let gate: Gate;
  if (counts.must > 0) gate = "blocked";
  else if (checked === 0 && input.findings.length === 0) gate = "none";
  else if (!covered || needed > 0) gate = "review";
  else gate = "ready";
  let afterFix: Gate;
  if (gate === "none") afterFix = "none";
  else afterFix = covered && checked > 0 ? "ready" : "review";
  return { gate, counts, checked, skipped, failed, needed, afterFix };
}
