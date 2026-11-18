import { type Evidence, type ImpactContext, RepoPathSchema } from "@audit/audit-core";
import type { ImportGraph } from "./graph";

const MAX_LIST = 5000;
const MAX_EVIDENCE = 50;

const sortUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

export const MAX_IMPACT_LIST = MAX_LIST;

/** One-hop impact plus the uncapped dependent count; the impact always satisfies ImpactContextSchema. */
export function analyzeImpact(
  graph: ImportGraph,
  changedFiles: readonly string[],
): { impact: ImpactContext; affectedTotal: number } {
  const changed = sortUnique(
    changedFiles.filter((f) => typeof f === "string" && RepoPathSchema.safeParse(f).success),
  ).slice(0, MAX_LIST);
  const changedSet = new Set(changed);
  const deps = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const complexity = new Map<string, number>();
  for (const n of graph.nodes) {
    if (changedSet.has(n.file) && n.complexity !== undefined) complexity.set(n.file, n.complexity);
  }
  for (const { from, to } of graph.edges) {
    if (changedSet.has(from)) addTo(deps, from, to);
    if (changedSet.has(to) && !changedSet.has(from)) {
      addTo(importers, to, from);
    }
  }

  const depEvidence: Evidence[] = [];
  const importerEvidence: Evidence[] = [];
  const affected = new Set<string>();
  const directDependencies = changed.map((file) => {
    const dependsOn = sortUnique(deps.get(file) ?? []).slice(0, MAX_LIST);
    for (const d of dependsOn) {
      if (depEvidence.length >= MAX_EVIDENCE) break;
      depEvidence.push({ kind: "graph", file, text: `imports ${d}` });
    }
    for (const i of sortUnique(importers.get(file) ?? [])) {
      affected.add(i);
      if (importerEvidence.length < MAX_EVIDENCE) {
        importerEvidence.push({ kind: "graph", file: i, text: `imports ${file}` });
      }
    }
    return { file, dependsOn };
  });

  // Importer lines get at least half of the evidence slots so a long dependency list cannot hide them.
  const importerShare = Math.max(MAX_EVIDENCE / 2, MAX_EVIDENCE - depEvidence.length);
  const importerPart = importerEvidence.slice(0, importerShare);
  const depPart = depEvidence.slice(0, MAX_EVIDENCE - importerPart.length);

  return {
    impact: {
      changedFiles: changed,
      directDependencies,
      affectedFiles: sortUnique(affected).slice(0, MAX_LIST),
      complexity: changed.flatMap((file) => {
        const score = complexity.get(file);
        return score === undefined ? [] : [{ file, score }];
      }),
      businessDomain: null,
      evidence: [...depPart, ...importerPart],
    },
    affectedTotal: affected.size,
  };
}

export function computeImpact(graph: ImportGraph, changedFiles: readonly string[]): ImpactContext {
  return analyzeImpact(graph, changedFiles).impact;
}
