import { RepoPathSchema, sanitizeEngineText } from "@audit/audit-core";

const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** Windows separators are accepted in the input list for matching only; output is always POSIX. */
export function toPosix(path: string): string {
  return path.includes("\\") ? path.replaceAll("\\", "/") : path;
}

/**
 * Normalizes and validates a file list in one linear pass: non-strings and entries that are not a
 * clean repo-relative path (or that sanitizing would alter) are skipped (never thrown on); duplicates are dropped; first-seen order is kept.
 */
export function cleanFileList(files: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    if (typeof raw !== "string" || raw.length > 1024) continue;
    const p = toPosix(raw);
    if (seen.has(p)) continue;
    if (!RepoPathSchema.safeParse(p).success) continue;
    // RepoPathSchema allows zero-width and direction marks; a name those would alter is not shown or used.
    if (!PLAIN_ASCII.test(p) && sanitizeEngineText(p, 1024) !== p) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
