import { EditionSettings } from "./EditionSettings";
import { t } from "./i18n";
import type { ModelClient } from "./ipc";
import { ModelsView } from "./ModelsView";

export function SettingsView({ models }: { models: ModelClient }) {
  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
      <section aria-labelledby="settings-edition" className="flex flex-col gap-4">
        <h2 id="settings-edition" className="text-xl font-semibold">
          {t("settings.edition.title")}
        </h2>
        <p className="text-sm opacity-70">{t("settings.edition.note")}</p>
        <EditionSettings />
      </section>
      <section aria-labelledby="settings-models">
        <ModelsView client={models} headingId="settings-models" />
      </section>
    </div>
  );
}
