import type { Project } from "@audit/audit-core";
import { Button } from "@audit/ui";
import { errorText, t } from "./i18n";
import type { Failure } from "./useProjectSession";

export interface HomeViewProps {
  projects: Project[] | null;
  failure: Failure | null;
  alreadyListed: boolean;
  tooMany: boolean;
  busy: boolean;
  dragging: boolean;
  dropUnavailable: boolean;
  onPick: () => void;
  onCheck: (project: Project) => void;
}

export function HomeView(props: HomeViewProps) {
  const {
    projects,
    failure,
    alreadyListed,
    tooMany,
    busy,
    dragging,
    dropUnavailable,
    onPick,
    onCheck,
  } = props;
  const highlight = dragging && !busy;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("nav.projects")}</h1>

      <div
        className={`rounded-2xl border-2 border-dashed p-10 text-center ${
          highlight
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
            : "border-divider"
        }`}
      >
        <Button variant="primary" isDisabled={busy} onPress={onPick}>
          {busy ? t("home.opening") : t("home.pick")}
        </Button>
        <p className="mt-3 text-sm opacity-70">
          {dragging && busy
            ? t("home.dropBusy")
            : highlight
              ? t("home.dropActive")
              : t("home.dropHint")}
        </p>
        <p className="mt-6 text-sm opacity-70">{t("home.privacy")}</p>
        <p className="mt-2 text-sm opacity-70">{t("home.modelStatus")}</p>
      </div>

      {failure && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{errorText(failure.code)}</p>
          <p className="mt-1 text-sm opacity-70">
            {t("error.detail", { message: failure.detail })}
          </p>
        </div>
      )}
      {alreadyListed && <p role="status">{t("home.alreadyListed")}</p>}
      {tooMany && <p role="status">{t("home.tooMany")}</p>}
      {dropUnavailable && <p role="status">{t("home.dropUnavailable")}</p>}

      <section aria-label={t("home.recent")}>
        {projects === null ? (
          <p>{t("home.loading")}</p>
        ) : projects.length === 0 ? (
          <p>{t("home.empty")}</p>
        ) : (
          <>
            <h2 className="mb-3 text-sm font-medium opacity-70">{t("home.recent")}</h2>
            <ul className="flex flex-col gap-3">
              {projects.map((project) => (
                <li
                  key={project.id}
                  className="flex items-center gap-3 rounded-lg border border-divider p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-medium">{project.name}</div>
                    <div className="break-all text-sm opacity-70" title={project.path}>
                      {project.path}
                    </div>
                    <div className="text-sm opacity-70">
                      {project.ecosystems.length > 0
                        ? project.ecosystems.join(" · ")
                        : t("home.noEcosystem")}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    aria-label={t("home.checkLabel", { name: project.name })}
                    onPress={() => onCheck(project)}
                  >
                    {t("home.check")}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
