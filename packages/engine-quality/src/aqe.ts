import { type Finding, RepoPathSchema, sanitizeEngineText } from "@audit/audit-core";
import { z } from "zod";
import { fingerprint } from "./fingerprint";

const ENGINE = "quality";
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_ROWS_SCANNED = 5000;
export const MAX_COVERAGE_FINDINGS = 25;
/** Files whose measured line coverage is below this percentage are reported. */
export const LOW_COVERAGE_BELOW = 50;
/** Below this percentage the finding is medium instead of low. */
const MEDIUM_BELOW = 25;
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** One per-file row as the engine reports it. Only these fields are ever read. */
export const AqeCoverageRowSchema = z.looseObject({
  file: z.string(),
  lineCoverage: z.number().nullable(),
  branchCoverage: z.number().nullable().optional(),
  functionCoverage: z.number().nullable().optional(),
});

/** The parsed `{success, data}` document of a coverage response (rows are checked one by one). */
export const AqeCoverageSchema = z.looseObject({
  success: z.boolean(),
  data: z.looseObject({
    coverageByFile: z.array(AqeCoverageRowSchema),
    measured: z.boolean(),
    estimated: z.boolean(),
  }),
});

// Same document, rows left unchecked so that one bad row cannot discard the others.
const EnvelopeSchema = z.looseObject({
  success: z.boolean(),
  data: z.looseObject({
    coverageByFile: z.array(z.unknown()),
    measured: z.boolean(),
    estimated: z.boolean(),
  }),
});

/** A measured per-file line-coverage figure whose path is already repo-relative and validated. */
export interface CoverageRow {
  readonly file: string;
  readonly lineCoverage: number;
}

export type AqeExtract =
  | { readonly kind: "measured"; readonly rows: CoverageRow[] }
  /** Well-formed, but not an instrumented measurement (e.g. no report on disk): never reported. */
  | { readonly kind: "not-measured" }
  /** Measured rows existed but none could be tied to a file in the project: no conclusion possible. */
  | { readonly kind: "unmapped" }
  | { readonly kind: "unreadable" };

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parsed JSON inside an MCP tool result (or its JSON-RPC wrapper); null on anything unexpected. */
export function unwrapToolText(raw: unknown): unknown {
  try {
    if (!isPlain(raw)) return null;
    const result = isPlain(raw.result) && !("content" in raw) ? raw.result : raw;
    if (result.isError === true) return null;
    const content = result.content;
    if (!Array.isArray(content)) return null;
    const first: unknown = content[0];
    if (!isPlain(first) || first.type !== "text" || typeof first.text !== "string") return null;
    if (first.text.length > MAX_TEXT_CHARS) return null;
    return JSON.parse(first.text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Forward-slash spelling of an engine-supplied absolute path. Works on the string alone (never the
 * host `node:path`), so Windows spellings are read the same on every OS. A Windows extended-length
 * prefix (`\\?\C:\x`, `\\?\UNC\srv\share`) is dropped.
 */
function slashed(path: string): string {
  const p = path.replaceAll("\\", "/");
  if (p.startsWith("//?/UNC/")) return `//${p.slice(8)}`;
  return p.startsWith("//?/") ? p.slice(4) : p;
}
/** ASCII-only lower-casing: the drive letter and directory names of a Windows path compare without case. */
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** A drive-letter or UNC path: Windows file systems are case-insensitive, POSIX ones are not. */
const isWindowsPath = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith("//");

/**
 * Absolute path under `projectDir` to repo-relative POSIX path, or null if outside / not clean.
 * Accepts `C:\x\y`, `C:/x/y`, mixed separators and a differently-cased drive letter or directory
 * name when `projectDir` is a Windows path; the file name part keeps the engine's spelling.
 */
export function toRepoRelative(absolute: string, projectDir: string): string | null {
  if (typeof absolute !== "string" || typeof projectDir !== "string") return null;
  const dir = slashed(projectDir).replace(/\/+$/, "");
  if (dir === "" && !projectDir.startsWith("/") && !projectDir.startsWith("\\")) return null;
  const prefix = `${dir}/`;
  const path = slashed(absolute);
  const head = path.slice(0, prefix.length);
  const inside = isWindowsPath(dir) ? foldAscii(head) === foldAscii(prefix) : head === prefix;
  if (!inside) return null;
  const rel = path.slice(prefix.length);
  if (!RepoPathSchema.safeParse(rel).success) return null;
  // Zero-width and direction marks pass the path schema but would alter what the user sees.
  if (!PLAIN_ASCII.test(rel) && sanitizeEngineText(rel, 1024) !== rel) return null;
  return rel;
}

/** Never throws. Only `measured === true && estimated === false` yields rows. */
export function extractAqeCoverage(raw: unknown, projectDir: string): AqeExtract {
  try {
    const parsed = EnvelopeSchema.safeParse(unwrapToolText(raw));
    if (!parsed.success || !parsed.data.success) return { kind: "unreadable" };
    const { data } = parsed.data;
    if (!(data.measured === true && data.estimated === false)) return { kind: "not-measured" };
    const byFile = new Map<string, number>();
    let usable = 0;
    for (const item of data.coverageByFile.slice(0, MAX_ROWS_SCANNED)) {
      const row = AqeCoverageRowSchema.safeParse(item);
      if (!row.success) continue;
      const pct = row.data.lineCoverage;
      if (pct === null || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
      usable += 1;
      const file = toRepoRelative(row.data.file, projectDir);
      if (file === null) continue;
      const prev = byFile.get(file);
      if (prev === undefined || pct < prev) byFile.set(file, pct);
    }
    if (usable > 0 && byFile.size === 0) return { kind: "unmapped" };
    return {
      kind: "measured",
      rows: [...byFile].map(([file, lineCoverage]) => ({ file, lineCoverage })),
    };
  } catch {
    return { kind: "unreadable" };
  }
}

const shown = (pct: number): string => (Math.round(pct * 10) / 10).toFixed(1);
const shorten = (s: string, max: number): string => {
  const points = Array.from(s);
  return points.length <= max ? s : `…${points.slice(points.length - max + 1).join("")}`;
};

/** Findings for the lowest-covered files; rows are re-validated, sorted lowest first, capped. */
export function findingsFromCoverage(rows: readonly unknown[]): Finding[] {
  const low: CoverageRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isPlain(r)) continue;
    const { file, lineCoverage } = r;
    if (typeof file !== "string" || typeof lineCoverage !== "number") continue;
    if (!Number.isFinite(lineCoverage) || lineCoverage < 0 || lineCoverage >= LOW_COVERAGE_BELOW) {
      continue;
    }
    if (!RepoPathSchema.safeParse(file).success || seen.has(file)) continue;
    seen.add(file);
    low.push({ file, lineCoverage });
  }
  low.sort((a, b) =>
    a.lineCoverage !== b.lineCoverage
      ? a.lineCoverage - b.lineCoverage
      : a.file < b.file
        ? -1
        : a.file > b.file
          ? 1
          : 0,
  );
  return low.slice(0, MAX_COVERAGE_FINDINGS).map(({ file, lineCoverage }) => {
    const ruleId = "quality.low-coverage";
    return {
      id: fingerprint([ENGINE, ruleId, file]),
      engine: ENGINE,
      ruleId,
      title: `测试覆盖率偏低：${shorten(file, 120)}`,
      severity: lineCoverage < MEDIUM_BELOW ? "medium" : "low",
      confidence: "medium",
      category: "testing",
      source: "static-analysis",
      file,
      message: `根据已有的覆盖率报告，${file} 的行覆盖率为 ${shown(lineCoverage)}%，低于 ${LOW_COVERAGE_BELOW}%，说明这个文件里有较多代码没有被测试执行过。`,
      evidence: [
        {
          kind: "metric",
          file,
          text: `行覆盖率 ${shown(lineCoverage)}%（来自覆盖率报告的实测值）`,
        },
      ],
      remediation: "为这个文件补充测试，优先覆盖没有被执行到的代码。",
    } satisfies Finding;
  });
}

/** Raw tool result and the sandbox dir it was pointed at, to Findings. */
export function mapAqeCoverage(raw: unknown, projectDir: string): Finding[] {
  const extracted = extractAqeCoverage(raw, projectDir);
  return extracted.kind === "measured" ? findingsFromCoverage(extracted.rows) : [];
}
