import { useEdition } from "./edition";
import { SKIPPED_GATES } from "./gates";
import { type MessageKey, t } from "./i18n";

export type View = "projects" | "reports" | "settings";

function NavButton({
  view,
  label,
  current,
  onSelect,
}: {
  view: View;
  label: MessageKey;
  current: View;
  onSelect: (view: View) => void;
}) {
  const active = view === current;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(view)}
      className={`rounded-lg px-3 py-2 text-left ${active ? "bg-default font-medium" : "opacity-70 hover:opacity-100"}`}
    >
      {t(label)}
    </button>
  );
}

export function Sidebar({ view, onSelect }: { view: View; onSelect: (view: View) => void }) {
  const boss = useEdition().edition === "boss";
  return (
    <nav
      aria-label={t("nav.label")}
      className="boss-sidebar no-print flex w-44 shrink-0 flex-col gap-1 border-r border-divider p-4"
    >
      <div className={boss ? "font-semibold" : "mb-4 font-semibold"}>{t("app.title")}</div>
      {boss && <div className="boss-label mb-4 text-xs">{t("boss.nav.edition")}</div>}
      <NavButton
        view="projects"
        label={boss ? "boss.nav.overview" : "nav.projects"}
        current={view}
        onSelect={onSelect}
      />
      <NavButton
        view="reports"
        label={boss ? "boss.nav.reports" : "nav.reports"}
        current={view}
        onSelect={onSelect}
      />
      <div className="mt-auto flex flex-col gap-1">
        <NavButton
          view="settings"
          label={boss ? "boss.nav.settings" : "nav.settings"}
          current={view}
          onSelect={onSelect}
        />
        {boss && (
          <div className="mt-3 flex flex-col gap-1 px-3 text-xs opacity-70">
            {SKIPPED_GATES.understand === "model" && <p>{t("boss.nav.status")}</p>}
            <p>{t("boss.nav.local")}</p>
          </div>
        )}
      </div>
    </nav>
  );
}
