import type { AuditRun, Project } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { useCallback, useMemo } from "react";
import { BossReview } from "./BossReview";
import { attentionLine, conclusionOf, coverageLine, greetingOf, notDoneItems } from "./bossCopy";
import { CopyButton } from "./CopyButton";
import { GateBadge } from "./GateBadge";
import { buildHandoff } from "./handoff";
import { errorText, t } from "./i18n";
import type { AuditClient } from "./ipc";
import { attentionCount, formatWhen, rankProjects } from "./reportMeta";
import { useLatestRuns } from "./useLatestRuns";
import type { Failure } from "./useProjectSession";
import { useRunFindings } from "./useRunFindings";

export interface BossOverviewProps {
  audit: AuditClient;
  /** null while the project list itself is loading. */
  projects: Project[] | null;
  failure: Failure | null;
  alreadyListed: boolean;
  tooMany: boolean;
  busy: boolean;
  dragging: boolean;
  dropUnavailable: boolean;
  onPick: () => void;
  onCheck: (project: Project) => void;
  /** Injectable clock for the greeting. */
  now?: () => Date;
}

interface Ranked {
  project: Project;
  run: AuditRun | null;
}

function runBadge(run: AuditRun) {
  return <GateBadge gate={run.summary?.gate ?? "none"} cancelled={run.status === "cancelled"} />;
}

function WhenLine({ run }: { run: AuditRun }) {
  if (run.status === "running") return <span>{t("boss.overview.running")}</span>;
  return (
    <span>
      {t("boss.overview.checkedAt", { time: formatWhen(run.finishedAt ?? run.startedAt) })}
      {run.stale === true && (
        <span className="ml-2 rounded-full border border-warning px-2 text-xs">
          {t("boss.overview.stale")}
        </span>
      )}
    </span>
  );
}

function Handoff({ audit, run }: { audit: AuditClient; run: AuditRun }) {
  // A run without stored findings has nothing to wait for; otherwise the list must be here before
  // the press, so the clipboard write stays inside the user's gesture.
  const wanted = run.findingCount > 0;
  const loaded = useRunFindings(audit, wanted ? run.id : null);
  const findings = wanted ? loaded.findings : [];
  const getText = useCallback(() => buildHandoff(run, findings ?? []), [run, findings]);

  if (loaded.failure && wanted) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p role="status">{t("boss.handoff.unavailable")}</p>
        <Button variant="secondary" className="boss-secondary" onPress={loaded.retry}>
          {t("audit.retry")}
        </Button>
      </div>
    );
  }
  return (
    <CopyButton
      getText={getText}
      label={findings === null ? t("boss.handoff.preparing") : t("boss.handoff.button")}
      copiedLabel={t("boss.handoff.copied")}
      failedLabel={t("boss.handoff.copyFailed")}
      variant="secondary"
      isDisabled={findings === null}
      buttonClassName="boss-secondary"
    />
  );
}

function Featured({
  audit,
  row,
  onCheck,
}: {
  audit: AuditClient;
  row: Ranked & { run: AuditRun };
  onCheck: (project: Project) => void;
}) {
  const { project, run } = row;
  const running = run.status === "running";
  const conclusion = conclusionOf(run);
  return (
    <section aria-labelledby="boss-featured-heading" className="boss-card flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="boss-label break-words">{project.name}</p>
        {!running && (
          <p className="text-sm opacity-80">
            <WhenLine run={run} />
          </p>
        )}
      </div>
      {running ? (
        <h2 id="boss-featured-heading" className="boss-serif text-3xl">
          {t("boss.overview.running")}
        </h2>
      ) : (
        <>
          <div>{runBadge(run)}</div>
          <h2 id="boss-featured-heading" className="boss-serif text-3xl">
            {conclusion?.sentence}
          </h2>
          {conclusion && (
            <div className="flex flex-col gap-1">
              <p>{conclusion.consequence}</p>
              {conclusion.incomplete && <p>{conclusion.incomplete}</p>}
              {conclusion.basis && <p className="text-sm opacity-80">{conclusion.basis}</p>}
            </div>
          )}
          {run.stale === true && <p className="text-sm">{t("boss.overview.staleNote")}</p>}
        </>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="primary" className="boss-primary" onPress={() => onCheck(project)}>
          {running ? t("boss.overview.progress") : t("boss.overview.view")}
        </Button>
        {!running && <Handoff key={run.id} audit={audit} run={run} />}
      </div>
    </section>
  );
}

function OtherRow({
  row,
  unknown,
  onCheck,
}: {
  row: Ranked;
  unknown: boolean;
  onCheck: (project: Project) => void;
}) {
  const { project, run } = row;
  const finished = run !== null && run.status !== "running";
  const conclusion = run !== null && finished ? conclusionOf(run) : null;
  return (
    <li className="boss-card flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{project.name}</div>
        <div className="text-sm opacity-80">
          {run ? (
            <WhenLine run={run} />
          ) : unknown ? (
            t("boss.overview.unknown")
          ) : (
            t("boss.overview.neverChecked")
          )}
        </div>
        {conclusion && <p className="mt-1 text-sm">{conclusion.sentence}</p>}
        {conclusion?.basis && <p className="text-sm opacity-80">{conclusion.basis}</p>}
      </div>
      {run && finished && runBadge(run)}
      {run ? (
        <Button
          variant="secondary"
          className="boss-secondary"
          aria-label={finished ? t("boss.overview.viewLabel", { name: project.name }) : undefined}
          onPress={() => onCheck(project)}
        >
          {finished ? t("boss.overview.view") : t("boss.overview.progress")}
        </Button>
      ) : (
        <Button
          variant="secondary"
          className="boss-secondary"
          aria-label={t("boss.overview.checkLabel", { name: project.name })}
          onPress={() => onCheck(project)}
        >
          {t("boss.overview.check")}
        </Button>
      )}
    </li>
  );
}

export function BossOverview(props: BossOverviewProps) {
  const { audit, projects, failure, alreadyListed, tooMany, busy, dragging, dropUnavailable } =
    props;
  const { onPick, onCheck } = props;
  const latest = useLatestRuns(audit, projects);
  const highlight = dragging && !busy;

  const ranked = useMemo<Ranked[] | null>(() => {
    if (projects === null) return null;
    if (projects.length === 0) return [];
    if (latest.rows === null) return null;
    const byProject = new Map(latest.rows.map((r) => [r.project.id, r.run]));
    return rankProjects(projects.map((p) => ({ project: p, run: byProject.get(p.id) ?? null })));
  }, [projects, latest.rows]);

  const featured = ranked?.find((r): r is Ranked & { run: AuditRun } => r.run !== null) ?? null;
  const others = ranked?.filter((r) => r !== featured) ?? [];
  const shownCount = ranked ? attentionCount(ranked) : 0;
  const checked = ranked ? ranked.filter((r) => r.run && r.run.status !== "running").length : 0;
  const unknownStatus = latest.failed;
  const greeting = greetingOf((props.now ?? (() => new Date()))());

  return (
    <div
      data-dragging={highlight ? "" : undefined}
      className={`flex flex-col gap-6 rounded-2xl ${highlight ? "outline-dashed outline-2 outline-offset-8 outline-[var(--accent)]" : ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="boss-serif text-2xl">{greeting}</h1>
          {ranked !== null && !unknownStatus && (
            <p className="mt-1 opacity-80">{attentionLine({ attention: shownCount, checked })}</p>
          )}
        </div>
        {projects !== null && projects.length > 0 && (
          <Button variant="secondary" className="boss-secondary" isDisabled={busy} onPress={onPick}>
            {busy ? t("home.opening") : t("home.pick")}
          </Button>
        )}
      </header>

      {projects === null || (projects.length > 0 && ranked === null) ? (
        <p>{t("home.loading")}</p>
      ) : projects.length === 0 ? (
        <section aria-labelledby="boss-empty-heading" className="boss-card flex flex-col gap-4 p-6">
          <h2 id="boss-empty-heading" className="boss-serif text-3xl">
            {t("boss.overview.empty.title")}
          </h2>
          <p>{t("boss.overview.empty.hint")}</p>
          <div>
            <Button variant="primary" className="boss-primary" isDisabled={busy} onPress={onPick}>
              {busy ? t("home.opening") : t("home.pick")}
            </Button>
          </div>
        </section>
      ) : featured ? (
        <Featured audit={audit} row={featured} onCheck={onCheck} />
      ) : unknownStatus ? null : (
        <section aria-labelledby="boss-empty-heading" className="boss-card flex flex-col gap-4 p-6">
          <h2 id="boss-empty-heading" className="boss-serif text-3xl">
            {t("boss.overview.empty.title")}
          </h2>
          <p>{t("boss.overview.empty.hint")}</p>
          <div>
            <Button
              variant="primary"
              className="boss-primary"
              onPress={() => projects[0] && onCheck(projects[0])}
            >
              {t("boss.overview.start")}
            </Button>
          </div>
        </section>
      )}

      {latest.failed && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{t("boss.overview.historyError")}</p>
        </div>
      )}
      {failure && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{errorText(failure.code)}</p>
          <p className="mt-1 text-sm opacity-70">
            {t("error.detail", { message: failure.detail })}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-1 text-sm opacity-80">
        <p>
          {dragging && busy
            ? t("home.dropBusy")
            : highlight
              ? t("home.dropActive")
              : t("home.dropHint")}
        </p>
        {alreadyListed && <p role="status">{t("home.alreadyListed")}</p>}
        {tooMany && <p role="status">{t("home.tooMany")}</p>}
        {dropUnavailable && <p role="status">{t("home.dropUnavailable")}</p>}
      </div>

      {others.length > 0 && (
        <section aria-label={featured ? t("boss.overview.others") : t("boss.overview.all")}>
          <h2 className="boss-label mb-3">
            {featured ? t("boss.overview.others") : t("boss.overview.all")}
          </h2>
          <ul className="flex flex-col gap-3">
            {others.map((row) => (
              <OtherRow key={row.project.id} row={row} unknown={unknownStatus} onCheck={onCheck} />
            ))}
          </ul>
        </section>
      )}

      <BossReview
        summary={
          <>
            {featured && <p>{coverageLine(featured.run)}</p>}
            <p>{t("boss.caveat")}</p>
          </>
        }
      >
        {featured && <Scope run={featured.run} />}
      </BossReview>
    </div>
  );
}

function Scope({ run }: { run: AuditRun }) {
  const items = notDoneItems(run);
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">{t("boss.notDone.title")}</h3>
      {items.length === 0 ? (
        <p>{t("boss.notDone.none")}</p>
      ) : (
        <ul className="list-disc pl-5">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
