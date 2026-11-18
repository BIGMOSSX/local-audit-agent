import type { AuditRun } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { gatesOf } from "./gates";
import { t } from "./i18n";

export interface RunningViewProps {
  name: string;
  run: AuditRun;
  cancelling: boolean;
  onCancel: () => void;
}

export function RunningView({ name, run, cancelling, onCancel }: RunningViewProps) {
  const rows = gatesOf(run);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="break-words text-2xl font-semibold">{t("run.title", { name })}</h1>
      <p className="text-sm opacity-70">{t("run.note")}</p>
      <ol aria-label={t("run.stepsLabel")} className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.id}
            aria-current={row.state === "current" ? "step" : undefined}
            className={`rounded-lg border p-4 ${
              row.state === "current" ? "border-2 border-[var(--accent)]" : "border-divider"
            } ${row.state === "waiting" || row.state === "skipped" ? "opacity-60" : ""}`}
          >
            <div className="font-medium">{t(`step.${row.id}`)}</div>
            <div className="text-sm">{t(`step.${row.state}`)}</div>
            {row.skipReason !== null && (
              <div className="text-sm opacity-70">{t(`step.skipReason.${row.skipReason}`)}</div>
            )}
            {row.state === "current" && row.progress && (
              <div className="text-sm">
                {t("run.progress", { done: row.progress.done, total: row.progress.total })}
              </div>
            )}
            {row.state === "current" && row.indeterminate && (
              <div className="text-sm opacity-70">{t("run.indeterminate")}</div>
            )}
          </li>
        ))}
      </ol>
      <div>
        <Button variant="secondary" isDisabled={cancelling} onPress={onCancel}>
          {cancelling ? t("run.cancelling") : t("run.cancel")}
        </Button>
      </div>
    </div>
  );
}
