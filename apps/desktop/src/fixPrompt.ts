import {
  type Finding,
  FindingCategorySchema,
  RepoPathSchema,
  SeveritySchema,
} from "@audit/audit-core";
import { t } from "./i18n";

const RULE_ID = /^[a-z][a-z0-9._-]{0,99}$/;
// Letters and digits of any script plus a few path punctuation marks. No whitespace, quotes,
// backticks, `$`, `|`, `;`, `<`, `>`, `&` or `\`: nothing a shell or a markdown fence could use.
const SAFE_PATH = /^[\p{L}\p{N}._\-/@+()]+$/u;
const MAX_PATH = 300;

/** `path` or `path:line` when the path passes validation and the safe charset, else null. */
export function safeLocation(finding: Pick<Finding, "file" | "line">): string | null {
  const file: unknown = finding.file;
  if (typeof file !== "string" || file.length > MAX_PATH) return null;
  if (!RepoPathSchema.safeParse(file).success || !SAFE_PATH.test(file)) return null;
  const line: unknown = finding.line;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0
    ? `${file}:${line}`
    : file;
}

/**
 * Fixed template over validated tokens only. Titles, messages, remediation, evidence and every
 * other engine-written string are never copied: the AI tool that receives the prompt has the
 * repository, and an injected instruction must not travel through this door (§35, §102).
 */
export function buildFixPrompt(finding: Finding): string {
  const lines: string[] = [t("fix.header")];
  const category = FindingCategorySchema.safeParse(finding.category);
  if (category.success) {
    lines.push(t("fix.category", { category: t(`category.${category.data}`) }));
  }
  const severity = SeveritySchema.safeParse(finding.severity);
  if (severity.success) {
    lines.push(t("fix.severity", { severity: t(`severity.${severity.data}`) }));
  }
  const ruleId: unknown = finding.ruleId;
  if (typeof ruleId === "string" && RULE_ID.test(ruleId)) lines.push(t("fix.rule", { ruleId }));
  const location = safeLocation(finding);
  lines.push(location ? t("fix.location", { location }) : t("fix.locationOmitted"));
  lines.push(t("fix.instruction"), t("fix.verify"));
  return lines.join("\n");
}
