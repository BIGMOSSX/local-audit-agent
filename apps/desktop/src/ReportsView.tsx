import type { Project } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { useState } from "react";
import { AuditView } from "./AuditView";
import { GateBadge } from "./GateBadge";
import { errorText, t } from "./i18n";
import type { AuditClient } from "./ipc";
import { formatTime } from "./ResultView";
import { type LatestRunRow, useLatestRuns } from "./useLatestRuns";

export interface ReportsViewProps {
  audit: AuditClient;
  /** null while the project list itself is loading. */
  projects: Project[] | null;
}

export function ReportsView({ audit, projects }: ReportsViewProps) {
  const [opened, setOpened] = useState<LatestRunRow | null>(null);
  // Coming back from an opened run must re-read: that run may have been re-checked meanwhile.
  const { rows, failure } = useLatestRuns(audit, projects, { enabled: opened === null });

  if (opened) {
    return (
      <AuditView
        audit={audit}
        project={opened.project}
        runId={opened.run.id}
        onBack={() => setOpened(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("nav.reports")}</h1>
      {failure && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{errorText(failure.code)}</p>
          <p className="mt-1 text-sm opacity-70">
            {t("error.detail", { message: failure.detail })}
          </p>
        </div>
      )}
      {rows === null ? (
        <p>{t("reports.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="opacity-70">{t("reports.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.run.id}
              className="boss-card flex flex-wrap items-center gap-3 rounded-lg border border-divider p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="break-words font-medium">{row.project.name}</div>
                <div className="text-sm opacity-70">
                  {row.run.finishedAt !== null
                    ? t("result.time", { time: formatTime(row.run.finishedAt) })
                    : t("reports.running")}
                </div>
              </div>
              {row.run.summary ? (
                <GateBadge gate={row.run.summary.gate} cancelled={row.run.status === "cancelled"} />
              ) : (
                <span className="text-sm">{t("reports.running")}</span>
              )}
              {row.run.stale === true && (
                <span className="rounded-full border border-warning px-2 py-0.5 text-xs">
                  {t("reports.stale")}
                </span>
              )}
              <Button
                variant="secondary"
                className="boss-secondary"
                aria-label={t("reports.openLabel", { name: row.project.name })}
                onPress={() => setOpened(row)}
              >
                {t("reports.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
