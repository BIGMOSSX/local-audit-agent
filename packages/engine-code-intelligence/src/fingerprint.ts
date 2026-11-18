import { createHash } from "node:crypto";

export function fingerprint(parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(p.length));
    h.update(":");
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}
