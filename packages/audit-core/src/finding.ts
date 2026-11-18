import { z } from "zod";

// Control characters (C0, DEL, C1) and bidi override/isolate characters can forge how a path renders.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character rejection
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export const RepoPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !CONTROL_OR_BIDI.test(p) &&
      !p.includes("\\") &&
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split("/").some((seg) => seg === ".." || seg === "." || seg === ""),
    { message: "must be a clean repo-relative POSIX path" },
  );
export type RepoPath = z.infer<typeof RepoPathSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const FindingCategorySchema = z.enum([
  "security",
  "quality",
  "testing",
  "architecture",
  "dependency",
  "maintainability",
  "secret",
  "performance",
  "data",
  "release",
]);
// §55: `ai-reasoning` must stay distinguishable from tool output.
export const FindingSourceSchema = z.enum([
  "scanner",
  "static-analysis",
  "heuristic",
  "ai-reasoning",
]);

export const EvidenceSchema = z
  .strictObject({
    kind: z.enum(["code", "graph", "metric", "log"]),
    file: RepoPathSchema.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    text: z.string().max(2000),
  })
  .refine((e) => e.endLine === undefined || e.startLine === undefined || e.endLine >= e.startLine, {
    message: "endLine must be >= startLine",
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z
  .strictObject({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    engine: z.string().regex(/^[a-z][a-z0-9-]*$/),
    ruleId: z.string().regex(/^[a-z][a-z0-9._-]*$/),
    title: z.string().min(1).max(200),
    severity: SeveritySchema,
    confidence: ConfidenceSchema,
    category: FindingCategorySchema,
    source: FindingSourceSchema,
    file: RepoPathSchema.optional(),
    line: z.number().int().positive().optional(),
    message: z.string().min(1).max(2000),
    evidence: z.array(EvidenceSchema).max(20),
    remediation: z.string().max(2000).optional(),
    // Commands/checks that prove the fix (spec §9 `remediation.verifyAfterFix`, flattened per R12).
    verifyAfterFix: z.array(z.string().min(1).max(500)).max(10).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.source === "scanner" && f.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "scanner findings require evidence",
        path: ["evidence"],
      });
    }
    if (f.source === "ai-reasoning" && f.confidence === "high") {
      ctx.addIssue({
        code: "custom",
        message: "ai-reasoning findings cannot claim high confidence (§55)",
        path: ["confidence"],
      });
    }
  });
export type Finding = z.infer<typeof FindingSchema>;

/** Free-text string fields of a finding: the only ones an engine controls the wording of. */
export const FINDING_TEXT_FIELDS = ["title", "message", "remediation"] as const;
/** Free-text list fields (each entry is text). Evidence entries' `text` is handled separately. */
export const FINDING_TEXT_LIST_FIELDS = ["verifyAfterFix"] as const;
export type FindingTextField =
  | (typeof FINDING_TEXT_FIELDS)[number]
  | (typeof FINDING_TEXT_LIST_FIELDS)[number]
  | "evidence.text";

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Applies `fn` to every free-text string of an UNTRUSTED finding candidate and returns a shallow copy.
 * Ids, paths, enums and numbers, and anything not shaped as expected, are left for FindingSchema to
 * judge. The one place that knows which fields are text: run-engine (sanitize) and the daemon's
 * engine service (redact) both go through it, so a new text field cannot be missed by one of them.
 */
export function mapFindingText(
  raw: unknown,
  fn: (text: string, field: FindingTextField) => string,
): unknown {
  if (!isPlainRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const key of FINDING_TEXT_FIELDS) {
    const v = out[key];
    if (typeof v === "string") out[key] = fn(v, key);
  }
  for (const key of FINDING_TEXT_LIST_FIELDS) {
    const v = out[key];
    if (Array.isArray(v)) {
      out[key] = v.map((item: unknown) => (typeof item === "string" ? fn(item, key) : item));
    }
  }
  if (Array.isArray(out.evidence)) {
    out.evidence = out.evidence.map((e: unknown) =>
      isPlainRecord(e) && typeof e.text === "string"
        ? { ...e, text: fn(e.text, "evidence.text") }
        : e,
    );
  }
  return out;
}
