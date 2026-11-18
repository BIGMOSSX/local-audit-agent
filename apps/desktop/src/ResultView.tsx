import type { AuditRun, Finding, RunSummary } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { useState } from "react";
import { DegradedBanner } from "./DegradedBanner";
import { FindingCard } from "./FindingCard";
import { GateBadge, shownGate } from "./GateBadge";
import { plainWhat } from "./gates";
import { errorText, t } from "./i18n";
import type { Failure } from "./useProjectSession";

export interface ResultViewProps {
  run: AuditRun;
  /** null while the list is loading or after it failed. */
  findings: Finding[] | null;
  findingsFailure: Failure | null;
  starting: boolean;
  onRecheck: () => void;
  onRetryFindings: () => void;
}

const PAGE = 50;

const NO_SUMMARY: RunSummary = {
  gate: "none",
  counts: { must: 0, should: 0, later: 0 },
  checked: 0,
  skipped: 0,
  failed: 0,
  needed: 0,
  afterFix: "none",
};

export const formatTime = (ms: number): string =>
  new Date(ms).toLocaleString("zh-CN", { hour12: false });

export function ResultView(props: ResultViewProps) {
  const { run, findings, findingsFailure, starting, onRecheck, onRetryFindings } = props;
  const summary = run.summary ?? NO_SUMMARY;
  const [shown, setShown] = useState(PAGE);
  const modelMissing = run.notDone.some((n) => n.reason.includes("AI 模型"));
  const headline = shownGate(summary.gate, run.status === "cancelled");

  return (
    <div className="flex flex-col gap-6">
      <DegradedBanner run={run} />
      <section className="flex flex-col gap-3" aria-label={t(`gate.${headline}`)}>
        <div>
          <GateBadge gate={summary.gate} cancelled={run.status === "cancelled"} />
        </div>
        <p className="text-lg font-medium">{t(`verdict.${headline}`)}</p>
        {summary.needed > 0 && summary.afterFix === "ready" && (
          <p>{t("result.needReady", { n: summary.needed })}</p>
        )}
        {summary.needed > 0 && summary.afterFix === "review" && (
          <p>{t("result.needReview", { n: summary.needed })}</p>
        )}
        {summary.needed === 0 &&
          (summary.gate === "review" || summary.gate === "blocked") &&
          summary.afterFix === "review" && <p>{t("result.afterFixReview")}</p>}
      </section>

      <section className="flex flex-col gap-1 text-sm">
        <p>
          {t("result.checked", {
            checked: summary.checked,
            skipped: summary.skipped,
            failed: summary.failed,
          })}
        </p>
        {run.finishedAt !== null && (
          <p className="opacity-70">{t("result.time", { time: formatTime(run.finishedAt) })}</p>
        )}
        {run.stale === true && (
          <p role="status" className="mt-2 rounded-lg border border-warning p-3">
            {t("result.stale")}
          </p>
        )}
      </section>

      {run.notDone.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">{t("result.notDone")}</h2>
          <ul className="flex flex-col gap-2">
            {run.notDone.map((item, i) => (
              <li key={i} className="break-words rounded-lg border border-divider p-3 text-sm">
                {t("result.notDoneItem", { what: plainWhat(item.what), reason: item.reason })}
              </li>
            ))}
          </ul>
          {modelMissing && <p className="mt-3 text-sm">{t("result.modelHint")}</p>}
        </section>
      )}

      {summary.gate !== "none" && (
        <section aria-label={t("result.columns")} className="grid grid-cols-3 gap-3 text-center">
          {(["must", "should", "later"] as const).map((bucket) => (
            <div key={bucket} className="rounded-lg border border-divider p-3">
              <h3 className="text-sm">{t(`col.${bucket}`)}</h3>
              <p className="text-2xl font-semibold">{summary.counts[bucket]}</p>
            </div>
          ))}
        </section>
      )}

      {run.findingCount > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">{t("result.findings")}</h2>
          {findingsFailure ? (
            <div role="alert" className="rounded-lg border border-danger p-4">
              <p>{t("result.findingsFailed")}</p>
              <p className="mt-1 text-sm opacity-70">{errorText(findingsFailure.code)}</p>
              <div className="mt-3">
                <Button variant="secondary" onPress={onRetryFindings}>
                  {t("audit.retry")}
                </Button>
              </div>
            </div>
          ) : findings === null ? (
            <p>{t("result.loadingFindings")}</p>
          ) : (
            <>
              {findings.slice(0, shown).map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
              {findings.length > PAGE && (
                <p className="text-sm opacity-70">
                  {t("result.shown", {
                    shown: Math.min(shown, findings.length),
                    total: findings.length,
                  })}
                </p>
              )}
              {shown < findings.length && (
                <div>
                  <Button variant="secondary" onPress={() => setShown((n) => n + PAGE)}>
                    {t("result.more")}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <div>
        <Button variant="primary" isDisabled={starting} onPress={onRecheck}>
          {starting ? t("audit.starting") : t("audit.recheck")}
        </Button>
      </div>

      <details className="advanced rounded-lg border border-divider p-4 text-sm">
        <summary className="cursor-pointer font-medium">{t("advanced.title")}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="break-all opacity-70">{t("advanced.runId", { id: run.id })}</p>
          {run.engines.length === 0 ? (
            <p>{t("advanced.noEngines")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {run.engines.map((engine) => (
                <li key={engine.id}>
                  <div className="break-all font-medium">
                    {engine.id}
                    {"　"}
                    {engine.applicable ? t("advanced.applicable") : t("advanced.notApplicable")}
                  </div>
                  <ul className="pl-4">
                    {engine.tasks.map((task) => (
                      <li key={task.id} className="break-all">
                        {task.id}：{t(`task.${task.status}`)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {run.notDone.length > 0 && (
            <div>
              <div className="font-medium">{t("advanced.notDoneRaw")}</div>
              <ul className="pl-4">
                {run.notDone.map((item, i) => (
                  <li key={i} className="break-words">
                    {item.what}：{item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
