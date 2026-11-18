import {
  type AuditRun,
  type Finding,
  FindingCategorySchema,
  SeveritySchema,
  sortByImportance,
} from "@audit/audit-core";
import { conclusionOf } from "./bossCopy";
import { safeLocation } from "./fixPrompt";
import { t } from "./i18n";
import { fingerprintOf, reportNumber } from "./reportMeta";

const MAX_ITEMS = 50;

/**
 * The text 转给技术同事 copies. A fixed template over numbers and validated tokens only: no project
 * name or path (a folder name is attacker-controlled), no titles, messages, remediation, evidence,
 * rule ids or not-done reasons. The receiving person or AI tool has the repository and reads the code.
 */
export function buildHandoff(run: AuditRun, findings: readonly Finding[]): string {
  const summary = run.summary;
  const lines: string[] = [t("boss.handoff.header")];
  const conclusion = conclusionOf(run);
  if (conclusion) lines.push(t("boss.handoff.conclusion", { conclusion: conclusion.sentence }));
  lines.push(
    t("boss.handoff.scope", {
      checked: summary?.checked ?? 0,
      skipped: summary?.skipped ?? 0,
      failed: summary?.failed ?? 0,
    }),
  );
  const number = reportNumber(run);
  if (number !== null) lines.push(t("boss.handoff.number", { number }));
  const fingerprint = fingerprintOf(run);
  if (fingerprint !== null) lines.push(t("boss.handoff.fingerprint", { fingerprint }));
  if (run.notDone.length > 0) lines.push(t("boss.handoff.notDone", { n: run.notDone.length }));

  lines.push("");
  const total = Math.max(findings.length, run.findingCount);
  if (total === 0) {
    lines.push(t("boss.handoff.noFindings"));
  } else {
    lines.push(t("boss.handoff.listTitle", { total }));
    const listed = sortByImportance(findings).slice(0, MAX_ITEMS);
    listed.forEach((finding, i) => {
      const parts: string[] = [];
      const severity = SeveritySchema.safeParse(finding.severity);
      if (severity.success) {
        parts.push(t("boss.handoff.severity", { severity: t(`severity.${severity.data}`) }));
      }
      const category = FindingCategorySchema.safeParse(finding.category);
      if (category.success) {
        parts.push(t("boss.handoff.category", { category: t(`category.${category.data}`) }));
      }
      const location = safeLocation(finding);
      if (location !== null) parts.push(t("boss.handoff.location", { location }));
      lines.push(
        `${i + 1}. ${parts.length > 0 ? parts.join(" · ") : t("boss.handoff.unknownItem")}`,
      );
    });
    if (total > listed.length) {
      lines.push(t("boss.handoff.more", { n: total - listed.length }));
    }
  }
  lines.push("", t("boss.handoff.closing"));
  return lines.join("\n");
}
