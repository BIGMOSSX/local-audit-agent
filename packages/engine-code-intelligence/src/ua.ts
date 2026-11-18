import { RepoPathSchema, sanitizeEngineText } from "@audit/audit-core";
import { z } from "zod";
import { type ImportGraph, MAX_GRAPH_EDGES, MAX_GRAPH_NODES } from "./graph";

// Strict only on the fields mapUaGraph reads; everything else in the captured shape is ignored.
export const UaNodeSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  filePath: z.string().optional(),
  complexity: z.unknown().optional(),
});
export const UaEdgeSchema = z.looseObject({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  direction: z.string().optional(),
});
export const UaGraphSchema = z.looseObject({
  nodes: z.array(UaNodeSchema),
  edges: z.array(UaEdgeSchema),
});
export type UaGraph = z.infer<typeof UaGraphSchema>;

// Scan bound for raw nodes (function nodes outnumber files); the rest is dropped.
const MAX_SCAN_NODES = 1_000_000;
const MAX_SCAN_EDGES = MAX_GRAPH_EDGES;
const MAX_ID_LENGTH = 1100;
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

export interface UaMapResult {
  graph: ImportGraph;
  /** Entries rejected as malformed, duplicate, self-loop, unknown endpoint or over a cap. */
  dropped: number;
  /** True only when a scan or size cap was hit, so the graph may be missing real files or imports. */
  truncated: boolean;
}

const empty = (dropped: number): UaMapResult => ({
  graph: { nodes: [], edges: [] },
  dropped,
  truncated: false,
});

function cleanPath(raw: string): string | null {
  if (raw.length > 1024) return null;
  const p = raw.includes("\\") ? raw.replaceAll("\\", "/") : raw;
  if (!RepoPathSchema.safeParse(p).success) return null;
  if (!PLAIN_ASCII.test(p) && sanitizeEngineText(p, 1024) !== p) return null;
  return p;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Maps untrusted graph output to an ImportGraph; never throws, work is bounded by the caps. */
export function mapUaGraph(raw: unknown): UaMapResult {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty(1);
    const { nodes: rawNodes, edges: rawEdges } = raw as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(rawNodes)) return empty(1);

    let dropped = 0;
    let truncated = false;
    const idToPath = new Map<string, string>();
    const complexityOf = new Map<string, number | undefined>();
    const scanNodes = Math.min(rawNodes.length, MAX_SCAN_NODES);
    dropped += rawNodes.length - scanNodes;
    if (scanNodes < rawNodes.length) truncated = true;
    for (let i = 0; i < scanNodes; i++) {
      const parsed = UaNodeSchema.safeParse(rawNodes[i]);
      if (!parsed.success) {
        dropped++;
        continue;
      }
      const node = parsed.data;
      if (node.type !== "file") continue;
      const path = typeof node.filePath === "string" ? cleanPath(node.filePath) : null;
      // The id must name the same file so edge endpoints map unambiguously.
      if (
        path === null ||
        node.id !== `file:${node.filePath}` ||
        node.id.length > MAX_ID_LENGTH ||
        idToPath.has(node.id) ||
        complexityOf.has(path)
      ) {
        dropped++;
        continue;
      }
      if (complexityOf.size >= MAX_GRAPH_NODES) {
        dropped++;
        truncated = true;
        continue;
      }
      idToPath.set(node.id, path);
      const c = node.complexity;
      complexityOf.set(path, typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : undefined);
    }

    const edgeKeys = new Set<string>();
    const edges: { from: string; to: string }[] = [];
    if (!Array.isArray(rawEdges)) {
      dropped++;
    } else {
      const scanEdges = Math.min(rawEdges.length, MAX_SCAN_EDGES);
      dropped += rawEdges.length - scanEdges;
      if (scanEdges < rawEdges.length) truncated = true;
      for (let i = 0; i < scanEdges; i++) {
        const parsed = UaEdgeSchema.safeParse(rawEdges[i]);
        if (!parsed.success) {
          dropped++;
          continue;
        }
        const e = parsed.data;
        if (e.type !== "imports") continue;
        if (e.direction !== undefined && e.direction !== "forward") {
          dropped++;
          continue;
        }
        const from = e.source.length <= MAX_ID_LENGTH ? idToPath.get(e.source) : undefined;
        const to = e.target.length <= MAX_ID_LENGTH ? idToPath.get(e.target) : undefined;
        if (from === undefined || to === undefined || from === to) {
          dropped++;
          continue;
        }
        const key = `${from}\0${to}`;
        if (edgeKeys.has(key)) {
          dropped++;
          continue;
        }
        edgeKeys.add(key);
        edges.push({ from, to });
      }
    }

    const nodes = [...complexityOf]
      .map(([file, c]) => (c === undefined ? { file } : { file, complexity: c }))
      .sort((a, b) => byString(a.file, b.file));
    edges.sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to));
    return { graph: { nodes, edges }, dropped, truncated };
  } catch {
    return empty(1);
  }
}
