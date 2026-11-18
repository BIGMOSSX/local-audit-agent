import { type Edition, useEdition } from "./edition";
import { type MessageKey, t } from "./i18n";

const OPTIONS: { edition: Edition; name: MessageKey; desc: MessageKey }[] = [
  { edition: "easy", name: "settings.edition.easy.name", desc: "settings.edition.easy.desc" },
  { edition: "boss", name: "settings.edition.boss.name", desc: "settings.edition.boss.desc" },
];

export function EditionSettings() {
  const { edition, setEdition, allowed } = useEdition();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">{t("settings.edition.legend")}</legend>
      {OPTIONS.map((option) => {
        const enabled = allowed(option.edition);
        const nameId = `edition-${option.edition}-name`;
        const descId = `edition-${option.edition}-desc`;
        return (
          <label
            key={option.edition}
            className={`flex items-start gap-3 rounded-lg border border-divider p-4 ${
              enabled ? "cursor-pointer" : "opacity-70"
            }`}
          >
            <input
              type="radio"
              name="edition"
              value={option.edition}
              checked={edition === option.edition}
              disabled={!enabled}
              aria-labelledby={nameId}
              aria-describedby={descId}
              onChange={() => setEdition(option.edition)}
              className="mt-1"
            />
            <span className="flex flex-col gap-1">
              <span id={nameId} className="font-medium">
                {t(option.name)}
              </span>
              <span id={descId} className="text-sm opacity-70">
                {enabled ? t(option.desc) : t("settings.edition.denied")}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
