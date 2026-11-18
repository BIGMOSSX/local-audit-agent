import {
  type AuditRun,
  type Bucket,
  bucketOf,
  type Finding,
  FindingCategorySchema,
  type Gate,
  sortByImportance,
} from "@audit/audit-core";
import { safeLocation } from "./fixPrompt";
import { t } from "./i18n";

/** Same wording as the result page, so a time reads the same in both editions. */
export const formatWhen = (ms: number): string =>
  new Date(ms).toLocaleString("zh-CN", { hour12: false });

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * `LA-YYYYMMDD-XXXXXXXX`: the run's finish date (local) and the first 8 letters/digits of its id.
 * Deterministic from the run itself, so the same report always carries the same number.
 */
export function reportNumber(run: AuditRun): string | null {
  if (run.finishedAt === null) return null;
  const d = new Date(run.finishedAt);
  const date = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
  const tail = run.id
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 8)
    .padEnd(8, "0");
  return `LA-${date}-${tail}`;
}

/** The finish time of the run, not the time the report is printed. */
export function reportDate(run: AuditRun): string | null {
  return run.finishedAt === null ? null : formatWhen(run.finishedAt);
}

/**
 * 安心报告 only for a completed, complete run whose gate is ready and whose project has not changed
 * since; every other state is 检查报告 (the word 安心 never sits on an out-of-date conclusion).
 */
export function reportTitle(run: AuditRun): string {
  const ready =
    run.summary?.gate === "ready" &&
    run.status === "completed" &&
    run.completeness === "complete" &&
    run.stale !== true;
  return t(ready ? "boss.title.ready" : "boss.title.check");
}

export const fingerprintOf = (run: AuditRun): string | null => run.fingerprint;

type FindingCategory = Finding["category"];

export interface HeadlineRow {
  n: number;
  bucket: Bucket;
  /** null when the category is not one of the known ones; the sheet then shows a generic sentence. */
  category: FindingCategory | null;
  /** `file` or `file:line` only when it passes the fix prompt's path validation. */
  location: string | null;
}

/** Up to `limit` rows, most important first. Nothing from a finding is kept except validated tokens. */
export function headlines(
  findings: readonly Finding[],
  limit = 10,
): { rows: HeadlineRow[]; omitted: number } {
  const ordered = sortByImportance(findings);
  const rows = ordered.slice(0, limit).map((f, i): HeadlineRow => {
    const category = FindingCategorySchema.safeParse(f.category);
    return {
      n: i + 1,
      bucket: bucketOf(f),
      category: category.success ? category.data : null,
      location: safeLocation(f),
    };
  });
  return { rows, omitted: Math.max(0, ordered.length - rows.length) };
}

export interface RankRow {
  run: AuditRun | null;
}

/** 0 = needs the most attention. A run still going has no conclusion yet, so it ranks below any. */
function rankOf(run: AuditRun | null): number {
  if (run === null) return 5;
  if (run.status === "running") return 4;
  const order: Record<Gate, number> = { blocked: 0, review: 1, none: 2, ready: 3 };
  return order[run.summary?.gate ?? "none"];
}

const whenOf = (run: AuditRun | null): number => run?.finishedAt ?? run?.startedAt ?? 0;

/** blocked > review > none > ready > running > never checked; ties newest first; otherwise stable. */
export function rankProjects<T extends RankRow>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        rankOf(a.row.run) - rankOf(b.row.run) || whenOf(b.row.run) - whenOf(a.row.run) || a.i - b.i,
    )
    .map((x) => x.row);
}

/** Projects whose latest conclusion is blocked, review or none. A project nobody could check is not fine. */
export function attentionCount(rows: readonly RankRow[]): number {
  return rows.filter(({ run }) => run !== null && run.status !== "running" && rankOf(run) <= 2)
    .length;
}
