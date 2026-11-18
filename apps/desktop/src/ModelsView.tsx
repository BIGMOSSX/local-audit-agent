import { Button } from "@audit/ui";
import { errorText, t } from "./i18n";
import type { ModelClient } from "./ipc";
import { useLocalModels } from "./useLocalModels";

export function ModelsView({ client, headingId }: { client: ModelClient; headingId?: string }) {
  const { services, failure, detecting, detect } = useLocalModels(client);
  return (
    <div className="flex flex-col gap-6">
      <h2 id={headingId} className="text-xl font-semibold">
        {t("settings.models.title")}
      </h2>
      <p>{t("settings.models.status")}</p>

      {failure && (
        <div role="alert" className="rounded-lg border border-danger p-4">
          <p>{errorText(failure.code)}</p>
          <p className="mt-1 text-sm opacity-70">
            {t("error.detail", { message: failure.detail })}
          </p>
        </div>
      )}

      {services !== null && services.length === 0 && !failure && <p>{t("settings.models.none")}</p>}
      {services !== null && services.length > 0 && (
        <section className="flex flex-col gap-3">
          <p className="text-sm opacity-70">{t("settings.models.found")}</p>
          <ul className="flex flex-col gap-3">
            {services.map((service) => (
              <li key={service.port} className="rounded-lg border border-divider p-4">
                <div className="font-medium">
                  {t("settings.models.service", {
                    port: String(service.port),
                    count: String(service.models.length),
                  })}
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {service.models.map((name) => (
                    <li key={name} className="break-all opacity-70">
                      {name}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-sm">{t("settings.models.notUsed")}</p>
        </section>
      )}

      <div>
        <Button variant="secondary" isDisabled={detecting} onPress={() => void detect()}>
          {detecting ? t("settings.models.detecting") : t("settings.models.redetect")}
        </Button>
        <p className="mt-3 text-sm opacity-70">{t("settings.models.privacy")}</p>
      </div>
    </div>
  );
}
