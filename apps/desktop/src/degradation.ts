import type { AuditRun, Gate } from "@audit/audit-core";

export type DegradationKind = "cancelled" | "failed" | "nothing-ran" | "some-skipped" | "partial";

export interface Degradation {
  kind: DegradationKind;
  gate: Gate;
  skipped: number;
  failed: number;
}

/** Decided from structured facts only (status, summary counts, completeness), never from engine text. */
export function degradationOf(run: AuditRun): Degradation | null {
  if (run.status === "running") return null;
  const gate = run.summary?.gate ?? "none";
  const checked = run.summary?.checked ?? 0;
  const skipped = run.summary?.skipped ?? 0;
  const failed = run.summary?.failed ?? 0;
  const base = { gate, skipped, failed };
  if (run.status === "cancelled") return { kind: "cancelled", ...base };
  if (run.status === "failed") return { kind: "failed", ...base };
  if (checked === 0) return { kind: "nothing-ran", ...base };
  if (skipped > 0 || failed > 0) return { kind: "some-skipped", ...base };
  if (run.completeness !== "complete" || run.notDone.length > 0)
    return { kind: "partial", ...base };
  return null;
}
