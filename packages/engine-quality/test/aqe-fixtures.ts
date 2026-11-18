import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTURED_DIR = "/tmp/aqe-contract-WAPKVx/project2";
const dir = join(import.meta.dirname, "fixtures", "aqe-captured");

/** The full captured JSON-RPC response. */
export function loadResponse(name: "measured" | "estimated"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `coverage_analyze_sublinear.${name}.json`), "utf8"));
}

/** What a ToolHost hands the adapter: the MCP `result` of the captured response. */
export function loadResult(name: "measured" | "estimated"): unknown {
  return loadResponse(name).result;
}

/** Replaces the captured roots in every string of a parsed JSON value (keys are left alone). */
function reroot(value: unknown, projectDir: string): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(CAPTURED_DIR, projectDir) // measured capture: .../project2
      .replaceAll("/tmp/aqe-contract-WAPKVx/project", projectDir); // estimated capture: .../project
  if (Array.isArray(value)) return value.map((v) => reroot(v, projectDir));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reroot(v, projectDir)]));
  return value;
}

/**
 * Same result, with the captured absolute paths re-rooted at `projectDir`. The tool text is a JSON
 * document inside a JSON string, so it is parsed, re-rooted as data and serialized again: a Windows
 * `projectDir` (backslashes) is escaped by JSON.stringify instead of being pasted into the text.
 */
export function retarget(result: unknown, projectDir: string): unknown {
  const r = structuredClone(result) as { content: { type: string; text: string }[] };
  for (const part of r.content) {
    part.text = JSON.stringify(reroot(JSON.parse(part.text), projectDir), null, 2);
  }
  return r;
}

/** The inner `{success, data}` document of a result. */
export function innerOf(result: unknown): { success: boolean; data: Record<string, unknown> } {
  const r = result as { content: { text: string }[] };
  return JSON.parse(r.content[0]?.text ?? "null");
}

/** Wraps a document the way the server does. */
export function wrap(doc: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(doc) }] };
}
