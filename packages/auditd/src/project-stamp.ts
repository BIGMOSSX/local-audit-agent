import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { listProjectFiles } from "./sandbox/workspace";

const STAT_CONCURRENCY = 32;

/**
 * A fingerprint of the files an audit reads: relative path, size and modification time of every file
 * `listProjectFiles` lists (so the same exclusions, caps and symlink rules as the audit itself).
 * Contents are not hashed: this must be cheap enough to run on every history call. A rewrite that
 * keeps both size and mtime is not noticed; the result is then merely shown as current.
 * Rejects when the project cannot be listed (unreadable root, over the size caps).
 */
export async function computeProjectStamp(root: string): Promise<string> {
  const files = await listProjectFiles(root);
  const lines: string[] = new Array(files.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < files.length; i = next++) {
      const rel = files[i] as string;
      // A file removed between the listing and this call is part of the change being fingerprinted.
      const st = await lstat(join(root, rel)).catch(() => null);
      lines[i] = st ? `${rel}\0${st.size}\0${st.mtimeMs}` : `${rel}\0gone`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
