import { type AuditRun, type Bucket, FindingCategorySchema, type Gate } from "@audit/audit-core";
import { degradationOf } from "./degradation";
import { isFixedNotDone, plainWhat } from "./gates";
import { t } from "./i18n";
import { formatWhen } from "./reportMeta";

export interface Conclusion {
  gate: Gate;
  /** One short sentence; the headline of the card and of the sheet. */
  sentence: string;
  consequence: string;
  /** Shown when the run is incomplete and the sentence above does not already say so. */
  incomplete: string | null;
  basis: string | null;
}

/**
 * Fixed copy chosen from the run's structured facts (gate, counts, status, degradation); no engine
 * text ever reaches it. A blocker stays a blocker even on a cancelled run.
 */
export function conclusionOf(run: AuditRun): Conclusion | null {
  if (run.status === "running") return null;
  const summary = run.summary;
  const gate: Gate = summary?.gate ?? "none";
  const checked = summary?.checked ?? 0;
  const basis =
    run.findingCount > 0
      ? t("boss.basis.findings", { n: run.findingCount })
      : checked > 0
        ? t("boss.basis.checked", { checked })
        : null;
  const incompleteLine = t("boss.conclusion.incomplete");
  const degraded = degradationOf(run) !== null;

  if (gate === "blocked") {
    return {
      gate,
      sentence: t("boss.conclusion.blocked"),
      consequence: t("boss.conclusion.blocked.effect", { must: summary?.counts.must ?? 0 }),
      incomplete: degraded ? incompleteLine : null,
      basis,
    };
  }
  if (run.status === "cancelled") {
    return {
      gate,
      sentence: t("boss.conclusion.cancelled"),
      consequence: t("boss.conclusion.cancelled.effect"),
      incomplete: null,
      basis,
    };
  }
  if (run.status === "failed") {
    return {
      gate,
      sentence: t("boss.conclusion.failed"),
      consequence: t("boss.conclusion.failed.effect"),
      incomplete: null,
      basis,
    };
  }
  if (gate === "none") {
    return {
      gate,
      sentence: t("boss.conclusion.none"),
      consequence: t("boss.conclusion.none.effect"),
      incomplete: null,
      basis,
    };
  }
  if (gate === "ready") {
    return {
      gate,
      sentence: t("boss.conclusion.ready"),
      consequence: t("boss.conclusion.ready.effect"),
      incomplete: null,
      basis,
    };
  }
  // review: with nothing listed, the only reason is that coverage is incomplete, and it says so itself.
  const byCoverage = run.findingCount === 0;
  return {
    gate,
    sentence: t("boss.conclusion.review"),
    consequence: t(
      byCoverage ? "boss.conclusion.review.coverage" : "boss.conclusion.review.effect",
    ),
    incomplete: !byCoverage && degraded ? incompleteLine : null,
    basis,
  };
}

/** By the local hour: 5–11 morning, 12–17 afternoon, otherwise evening. No name: the app has none. */
export function greetingOf(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return t("boss.greeting.morning");
  if (h >= 12 && h < 18) return t("boss.greeting.afternoon");
  return t("boss.greeting.evening");
}

/** `attention` counts blocked/review/none; `checked` counts projects that have a concluded run. */
export function attentionLine({
  attention,
  checked,
}: {
  attention: number;
  checked: number;
}): string {
  if (attention > 0) return t("boss.attention.some", { n: attention });
  return checked > 0 ? t("boss.attention.none") : t("boss.attention.unchecked");
}

/** A business-consequence sentence for a category; a generic one for anything not recognised. */
export function impactOf(category: unknown): string {
  const known = FindingCategorySchema.safeParse(category);
  return known.success ? t(`boss.impact.${known.data}`) : t("boss.impact.unknown");
}

export function bucketLabel(bucket: Bucket): string {
  return t(`boss.bucket.${bucket}`);
}

/** Null while the run has no summary. The time is that of the files the check read (taken at start). */
export function coverageLine(run: AuditRun): string | null {
  if (run.summary === null) return null;
  return t("boss.coverage", {
    checked: run.summary.checked,
    skipped: run.summary.skipped,
    failed: run.summary.failed,
    time: formatWhen(run.startedAt),
  });
}

/** What was not done, by name only (never the reason), engine prefix removed, repeats merged. */
export function notDoneItems(run: AuditRun): string[] {
  const fixed = run.notDone.filter((n) => isFixedNotDone(n.what));
  const other = run.notDone.length - fixed.length;
  const items = [...new Set(fixed.map((n) => plainWhat(n.what)))];
  if (other > 0) items.push(t("boss.notDone.other", { n: other }));
  return items;
}

export function notDoneLine(run: AuditRun): string | null {
  return run.notDone.length === 0 ? null : t("boss.notDone.count", { n: run.notDone.length });
}

export function signatureLine(): string {
  return t("boss.signature", { app: t("app.title") });
}
