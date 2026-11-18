import { RepoPathSchema } from "@audit/audit-core";
import { z } from "zod";

export const MAX_GRAPH_NODES = 100_000;
export const MAX_GRAPH_EDGES = 1_000_000;

export const ImportGraphSchema = z.strictObject({
  nodes: z
    .array(
      z.strictObject({ file: RepoPathSchema, complexity: z.number().nonnegative().optional() }),
    )
    .max(MAX_GRAPH_NODES),
  edges: z.array(z.strictObject({ from: RepoPathSchema, to: RepoPathSchema })).max(MAX_GRAPH_EDGES),
});
/** `from` imports `to`. */
export type ImportGraph = z.infer<typeof ImportGraphSchema>;
