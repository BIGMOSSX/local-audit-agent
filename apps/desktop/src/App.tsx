import type { Project } from "@audit/audit-core";
import { useEffect, useState } from "react";
import { AuditView } from "./AuditView";
import { BossOverview } from "./BossOverview";
import type { DropSource } from "./dragdrop";
import { type EditionEntitlement, EditionProvider, useIsBoss } from "./edition";
import { HomeView } from "./HomeView";
import type { AuditClient, ModelClient, ProjectClient } from "./ipc";
import { ReportsView } from "./ReportsView";
import { SettingsView } from "./SettingsView";
import { Sidebar, type View } from "./Sidebar";
import { useProjectSession } from "./useProjectSession";

export interface AppProps {
  client: ProjectClient;
  models: ModelClient;
  audit: AuditClient;
  pickFolder: () => Promise<string | null>;
  dropSource?: DropSource;
  /** Which editions this install may use; defaults to all (a later subscription tier plugs in here). */
  entitlement?: EditionEntitlement;
  /** The system dark-mode preference; injectable so tests do not depend on matchMedia. */
  prefersDark?: () => boolean;
}

export function App({ entitlement, prefersDark, ...rest }: AppProps) {
  return (
    <EditionProvider entitlement={entitlement} prefersDark={prefersDark}>
      <AppBody {...rest} />
    </EditionProvider>
  );
}

function AppBody({
  client,
  models,
  audit,
  pickFolder,
  dropSource,
}: Omit<AppProps, "entitlement" | "prefersDark">) {
  const session = useProjectSession(client);
  const boss = useIsBoss();
  const { isBusy, openPaths, pickAndOpen } = session;
  const [view, setView] = useState<View>("projects");
  const [auditProject, setAuditProject] = useState<Project | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropUnavailable, setDropUnavailable] = useState(false);

  useEffect(() => {
    if (!dropSource) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    dropSource({
      onHover: setDragging,
      onDrop: (paths) => {
        if (isBusy()) return;
        setView("projects");
        setAuditProject(null);
        void openPaths(paths);
      },
    }).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      () => {
        if (!disposed) setDropUnavailable(true);
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dropSource, isBusy, openPaths]);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        view={view}
        onSelect={(next) => {
          // Pressing 项目 again while a project's check is open goes back to the list.
          if (next === "projects" && view === "projects") setAuditProject(null);
          setView(next);
        }}
      />
      <main className="mx-auto w-full max-w-3xl p-8">
        {view === "projects" && auditProject && (
          <AuditView
            key={auditProject.id}
            audit={audit}
            project={auditProject}
            onBack={() => setAuditProject(null)}
          />
        )}
        {view === "projects" && !auditProject && boss && (
          <BossOverview
            audit={audit}
            projects={session.projects}
            failure={session.failure}
            alreadyListed={session.alreadyListed}
            tooMany={session.tooMany}
            busy={session.busy}
            dragging={dragging}
            dropUnavailable={dropUnavailable}
            onPick={() => void pickAndOpen(pickFolder)}
            onCheck={setAuditProject}
          />
        )}
        {view === "projects" && !auditProject && !boss && (
          <HomeView
            projects={session.projects}
            failure={session.failure}
            alreadyListed={session.alreadyListed}
            tooMany={session.tooMany}
            busy={session.busy}
            dragging={dragging}
            dropUnavailable={dropUnavailable}
            onPick={() => void pickAndOpen(pickFolder)}
            onCheck={setAuditProject}
          />
        )}
        {view === "reports" && <ReportsView audit={audit} projects={session.projects} />}
        {view === "settings" && <SettingsView models={models} />}
      </main>
    </div>
  );
}
