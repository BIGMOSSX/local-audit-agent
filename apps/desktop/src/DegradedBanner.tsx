import type { AuditRun } from "@audit/audit-core";
import { degradationOf } from "./degradation";
import { t } from "./i18n";

/** §35: what is missing, what it changes, how to make up for it. Nothing for a run that needs none. */
export function DegradedBanner({ run }: { run: AuditRun }) {
  const degraded = degradationOf(run);
  if (!degraded) return null;
  return (
    <section
      aria-label={t("degraded.title")}
      className="flex flex-col gap-2 rounded-lg border border-warning p-4 text-sm"
    >
      <h2 className="font-medium">{t("degraded.title")}</h2>
      <p>
        <span className="font-medium">{t("degraded.label.missing")}：</span>
        {t(`degraded.missing.${degraded.kind}`, {
          skipped: degraded.skipped,
          failed: degraded.failed,
        })}
      </p>
      <p>
        <span className="font-medium">{t("degraded.label.effect")}：</span>
        {t(
          `degraded.effect.${degraded.gate === "none" || degraded.gate === "blocked" ? degraded.gate : "review"}`,
        )}
      </p>
      <p>
        <span className="font-medium">{t("degraded.label.remedy")}：</span>
        {t(`degraded.remedy.${degraded.kind}`)}
      </p>
    </section>
  );
}
