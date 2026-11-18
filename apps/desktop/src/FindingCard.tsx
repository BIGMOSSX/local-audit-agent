import { bucketOf, type Finding } from "@audit/audit-core";
import { CopyButton } from "./CopyButton";
import { buildFixPrompt } from "./fixPrompt";
import { type MessageKey, t } from "./i18n";

/** One label per bucket so a card never sits under one heading and wears another. */
export function labelKeyOf(finding: Finding): MessageKey {
  const bucket = bucketOf(finding);
  if (bucket === "must") return "severity.critical";
  if (bucket === "later") return "severity.low";
  return finding.severity === "critical" || finding.severity === "high"
    ? "severity.high"
    : "severity.medium";
}

function howKeyOf(finding: Finding): MessageKey {
  return `how.${bucketOf(finding)}`;
}

export function FindingCard({ finding }: { finding: Finding }) {
  const location = finding.file
    ? finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file
    : null;

  return (
    <article className="rounded-lg border border-divider p-4">
      <div className="text-sm font-medium">{t(labelKeyOf(finding))}</div>
      <h3 className="mt-1 break-words font-medium">{finding.title}</h3>
      {location && (
        <div className="break-all text-sm opacity-70">{t("card.where", { location })}</div>
      )}
      <dl className="mt-3 flex flex-col gap-2 text-sm">
        <div>
          <dt className="font-medium">{t("card.what")}</dt>
          <dd className="break-words">{finding.message}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("card.why")}</dt>
          <dd>{t(`why.${finding.category}`)}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("card.how")}</dt>
          <dd>{t(howKeyOf(finding))}</dd>
        </div>
      </dl>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer">{t("card.details")}</summary>
        <div className="mt-2 flex flex-col gap-2">
          {finding.remediation && (
            <div>
              <div className="font-medium">{t("card.remediation")}</div>
              <p className="break-words">{finding.remediation}</p>
            </div>
          )}
          {finding.verifyAfterFix && finding.verifyAfterFix.length > 0 && (
            <div>
              <div className="font-medium">{t("card.verify")}</div>
              <ul className="list-disc pl-5">
                {finding.verifyAfterFix.map((step, i) => (
                  <li key={i} className="break-words">
                    {step}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {finding.evidence.length > 0 && (
            <div>
              <div className="font-medium">{t("card.evidence")}</div>
              <ul className="flex flex-col gap-1">
                {finding.evidence.map((item, i) => (
                  <li key={i}>
                    <pre className="whitespace-pre-wrap break-words rounded bg-default p-2">
                      {item.text}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
      <CopyButton
        className="mt-3"
        getText={() => buildFixPrompt(finding)}
        label={t("card.copy")}
        copiedLabel={t("card.copied")}
        failedLabel={t("card.copyFailed")}
      />
    </article>
  );
}
