import type { AuditRun, Finding } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BossReview } from "./BossReview";
import {
  bucketLabel,
  conclusionOf,
  coverageLine,
  impactOf,
  notDoneItems,
  signatureLine,
} from "./bossCopy";
import { CopyButton } from "./CopyButton";
import { DegradedBanner } from "./DegradedBanner";
import { GateBadge } from "./GateBadge";
import { buildHandoff } from "./handoff";
import { t } from "./i18n";
import { fingerprintOf, headlines, reportDate, reportNumber, reportTitle } from "./reportMeta";
import type { Failure } from "./useProjectSession";

const BASIS_LIMIT = 50;

export interface BossReportViewProps {
  run: AuditRun;
  /** Shown as a text node on the sheet; never part of the handoff text. */
  projectName: string;
  /** null until the whole list of this run has been read (see findingsFailure). */
  findings: Finding[] | null;
  findingsFailure: Failure | null;
  onRecheck: () => void;
  onRetryFindings: () => void;
  /** Injectable for tests; defaults to the webview's own. */
  userAgent?: string;
  print?: () => void;
}

const isMac = (ua: string): boolean => /Macintosh|Mac OS X/i.test(ua);

export function BossReportView(props: BossReportViewProps) {
  const { run, projectName, findings, findingsFailure, onRecheck, onRetryFindings } = props;
  const [printFailed, setPrintFailed] = useState(false);
  const restoreTitle = useRef<(() => void) | null>(null);
  const hintId = useId();

  useEffect(() => () => restoreTitle.current?.(), []);

  const ua = props.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const mac = isMac(ua);
  const wanted = run.findingCount > 0;
  const listReady = !wanted || findings !== null;
  const number = reportNumber(run);
  const fingerprint = fingerprintOf(run);
  const date = reportDate(run);
  const conclusion = conclusionOf(run);
  const checked = run.summary?.checked ?? 0;
  const list = findings ?? [];
  const head = headlines(list);
  const notDone = notDoneItems(run);
  const getHandoff = useCallback(() => buildHandoff(run, findings ?? []), [run, findings]);

  const doPrint = () => {
    restoreTitle.current?.();
    setPrintFailed(false);
    const previous = document.title;
    const restore = () => {
      document.title = previous;
      window.removeEventListener("afterprint", restore);
      if (restoreTitle.current === restore) restoreTitle.current = null;
    };
    restoreTitle.current = restore;
    if (number !== null) document.title = number;
    window.addEventListener("afterprint", restore);
    try {
      (props.print ?? (() => window.print()))();
    } catch {
      restore();
      setPrintFailed(true);
    }
  };

  const printDisabled = mac || !listReady || findingsFailure !== null;

  return (
    <div className="flex flex-col gap-6">
      <article
        data-report=""
        aria-label={reportTitle(run)}
        className="boss-card boss-sheet flex flex-col gap-5 p-8"
      >
        <header className="flex flex-col gap-1">
          <p className="boss-label">{t("app.title")}</p>
          <h1 className="boss-serif text-3xl">{reportTitle(run)}</h1>
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          {number !== null && (
            <>
              <dt className="opacity-80">{t("boss.report.number")}</dt>
              <dd>{number}</dd>
            </>
          )}
          {date !== null && (
            <>
              <dt className="opacity-80">{t("boss.report.date")}</dt>
              <dd>{date}</dd>
            </>
          )}
          <dt className="opacity-80">{t("boss.report.project")}</dt>
          <dd className="break-words">{projectName}</dd>
          {fingerprint !== null && (
            <>
              <dt className="opacity-80">{t("boss.report.fingerprint")}</dt>
              <dd className="font-mono">{fingerprint}</dd>
            </>
          )}
        </dl>

        <section className="boss-hairline flex flex-col gap-2 pt-5">
          <h2 className="boss-label">{t("boss.report.conclusion")}</h2>
          <div>
            <GateBadge gate={run.summary?.gate ?? "none"} cancelled={run.status === "cancelled"} />
          </div>
          {conclusion && (
            <>
              <p className="boss-serif text-2xl">{conclusion.sentence}</p>
              <p>{conclusion.consequence}</p>
              {conclusion.incomplete && <p>{conclusion.incomplete}</p>}
              {conclusion.basis && <p className="text-sm opacity-80">{conclusion.basis}</p>}
            </>
          )}
          {run.stale === true && <p className="text-sm">{t("boss.report.stale")}</p>}
        </section>

        <DegradedBanner run={run} />

        {coverageLine(run) !== null && <p className="text-sm">{coverageLine(run)}</p>}

        {(wanted || checked > 0) && (
          <section className="boss-hairline flex flex-col gap-2 pt-5">
            <h2 className="boss-label">{t("boss.report.order")}</h2>
            {!listReady ? (
              <p>{findingsFailure ? t("result.findingsFailed") : t("result.loadingFindings")}</p>
            ) : head.rows.length === 0 ? (
              <p>
                {run.status === "completed"
                  ? t("boss.report.noFindings")
                  : t("boss.report.noFindingsIncomplete")}
              </p>
            ) : (
              <>
                <ol className="flex flex-col gap-2">
                  {head.rows.map((row) => (
                    <li key={row.n} className="flex flex-wrap gap-x-3">
                      <span className="tabular-nums">{row.n}.</span>
                      <span className="font-medium">{bucketLabel(row.bucket)}</span>
                      <span className="min-w-[14rem] flex-1 break-words">
                        {impactOf(row.category)}
                      </span>
                      {row.location && (
                        <span className="break-all text-sm opacity-80">
                          {t("boss.report.location", { location: row.location })}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                {head.omitted > 0 && (
                  <p className="text-sm">{t("boss.report.more", { n: head.omitted })}</p>
                )}
              </>
            )}
          </section>
        )}

        <section className="boss-hairline flex flex-col gap-2 pt-5">
          <h2 className="boss-label">{t("boss.notDone.title")}</h2>
          {notDone.length === 0 ? (
            <p>{t("boss.notDone.none")}</p>
          ) : (
            <ul className="list-disc pl-5">
              {notDone.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>

        <footer className="boss-hairline flex flex-col gap-1 pt-5 text-sm">
          <p>{t("boss.caveat")}</p>
          <p className="opacity-80">{signatureLine()}</p>
        </footer>
      </article>

      <section
        aria-label={t("boss.report.archive")}
        className="boss-card no-print flex flex-col gap-4 p-6"
      >
        <h2 className="boss-label">{t("boss.report.archive")}</h2>
        <div className="flex flex-wrap items-start gap-3">
          <Button
            variant="primary"
            className="boss-primary"
            isDisabled={printDisabled}
            aria-describedby={hintId}
            onPress={doPrint}
          >
            {t("boss.report.print")}
          </Button>
          {findingsFailure && wanted ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <p role="status">{t("boss.handoff.unavailable")}</p>
              <Button variant="secondary" className="boss-secondary" onPress={onRetryFindings}>
                {t("audit.retry")}
              </Button>
            </div>
          ) : (
            <CopyButton
              getText={getHandoff}
              label={listReady ? t("boss.handoff.button") : t("boss.handoff.preparing")}
              copiedLabel={t("boss.handoff.copied")}
              failedLabel={t("boss.handoff.copyFailed")}
              variant="secondary"
              isDisabled={!listReady}
              buttonClassName="boss-secondary"
            />
          )}
          <Button variant="secondary" className="boss-secondary" onPress={onRecheck}>
            {t("audit.recheck")}
          </Button>
        </div>
        <p id={hintId} className="text-sm opacity-80">
          {mac ? t("boss.report.printMac") : t("boss.report.printHint")}
        </p>
        {printFailed && (
          <p role="alert" className="text-sm">
            {t("boss.report.printFailed")}
          </p>
        )}
      </section>

      <BossReview
        summary={
          run.summary && (
            <p>
              {t("result.checked", {
                checked: run.summary.checked,
                skipped: run.summary.skipped,
                failed: run.summary.failed,
              })}
            </p>
          )
        }
      >
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">{t("boss.review.basis")}</h3>
          {list.length === 0 ? (
            <p>{t("boss.review.basisEmpty")}</p>
          ) : (
            <>
              <ul className="list-disc pl-5">
                {list.slice(0, BASIS_LIMIT).map((f) => (
                  <li key={f.id} className="break-words">
                    {f.title}
                  </li>
                ))}
              </ul>
              {list.length > BASIS_LIMIT && (
                <p>{t("boss.handoff.more", { n: list.length - BASIS_LIMIT })}</p>
              )}
            </>
          )}
        </div>
        <p>{t("boss.review.fingerprintNote")}</p>
      </BossReview>
    </div>
  );
}
