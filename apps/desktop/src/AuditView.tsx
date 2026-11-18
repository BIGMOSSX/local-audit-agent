import type { Project } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { BossReportView } from "./BossReportView";
import { useIsBoss } from "./edition";
import { errorText, t } from "./i18n";
import type { AuditClient } from "./ipc";
import { ResultView } from "./ResultView";
import { RunningView } from "./RunningView";
import { useAuditRun } from "./useAuditRun";

export interface AuditViewProps {
  audit: AuditClient;
  project: Project;
  /** Opens that specific stored run instead of the project's newest one. */
  runId?: string;
  onBack: () => void;
}

export function AuditView({ audit, project, runId, onBack }: AuditViewProps) {
  const state = useAuditRun(audit, project.id, runId);
  const { phase, run, failure } = state;
  const boss = useIsBoss();
  const bossReport = boss && run !== null && phase === "finished";

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <Button
          variant="secondary"
          className={boss ? "boss-secondary" : undefined}
          onPress={onBack}
        >
          {bossReport && !runId ? t("boss.report.back") : t("audit.back")}
        </Button>
      </div>

      {failure && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{errorText(failure.code)}</p>
          <p className="mt-1 text-sm opacity-70">
            {t("error.detail", { message: failure.detail })}
          </p>
          <div className="mt-3">
            <Button variant="secondary" onPress={() => void state.refresh()}>
              {t("audit.retry")}
            </Button>
          </div>
        </div>
      )}

      {phase === "loading" && <p>{t("audit.loading")}</p>}

      {(phase === "idle" || phase === "starting") &&
        (runId ? (
          <p>{t("audit.gone")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <h1 className="break-words text-2xl font-semibold">
              {t("audit.title", { name: project.name })}
            </h1>
            <p>{t("audit.intro")}</p>
            <div>
              <Button
                variant="primary"
                isDisabled={phase === "starting"}
                onPress={() => void state.start()}
              >
                {phase === "starting" ? t("audit.starting") : t("audit.start")}
              </Button>
            </div>
          </div>
        ))}

      {run && (phase === "running" || phase === "cancelling") && (
        <RunningView
          name={project.name}
          run={run}
          cancelling={phase === "cancelling"}
          onCancel={() => void state.cancel()}
        />
      )}

      {run && phase === "finished" && boss && (
        <BossReportView
          run={run}
          projectName={project.name}
          findings={state.findings}
          findingsFailure={state.findingsFailure}
          onRecheck={() => void state.start()}
          onRetryFindings={() => void state.retryFindings()}
        />
      )}

      {run && phase === "finished" && !boss && (
        <>
          <h1 className="break-words text-2xl font-semibold">
            {t("audit.title", { name: project.name })}
          </h1>
          <ResultView
            run={run}
            findings={state.findings}
            findingsFailure={state.findingsFailure}
            starting={false}
            onRecheck={() => void state.start()}
            onRetryFindings={() => void state.retryFindings()}
          />
        </>
      )}
    </div>
  );
}
