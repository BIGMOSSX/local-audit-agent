import { ImpactContextSchema } from "@audit/audit-core";
import { describe, expect, it } from "vitest";
import { ImportGraphSchema } from "../src/graph";
import { computeImpact } from "../src/impact";
import small from "./fixtures/graph-small.json";

const graph = ImportGraphSchema.parse(small);

describe("computeImpact (§112)", () => {
  it("reports changed file, direct dependencies, affected dependents, complexity and evidence", () => {
    const impact = computeImpact(graph, ["src/a.ts"]);
    expect(ImpactContextSchema.safeParse(impact).success).toBe(true);
    expect(impact.changedFiles).toEqual(["src/a.ts"]);
    expect(impact.directDependencies).toEqual([
      { file: "src/a.ts", dependsOn: ["src/b.ts", "src/c.ts"] },
    ]);
    expect(impact.affectedFiles).toEqual(["src/d.ts", "src/e.ts"]);
    expect(impact.complexity).toEqual([{ file: "src/a.ts", score: 14 }]);
    expect(impact.businessDomain).toBeNull();
    expect(impact.evidence.length).toBeGreaterThanOrEqual(3);
    expect(impact.evidence.every((e) => e.kind === "graph")).toBe(true);
    expect(impact.evidence).toContainEqual({
      kind: "graph",
      file: "src/d.ts",
      text: "imports src/a.ts",
    });
    expect(impact.evidence).toContainEqual({
      kind: "graph",
      file: "src/a.ts",
      text: "imports src/b.ts",
    });
  });
  it("a leaf dependency is affected by nothing it depends on, but its importer is reported", () => {
    const impact = computeImpact(graph, ["src/b.ts"]);
    expect(impact.directDependencies).toEqual([{ file: "src/b.ts", dependsOn: [] }]);
    expect(impact.affectedFiles).toEqual(["src/a.ts"]);
  });
  it("a file that is not in the graph is still listed as changed, with no relations", () => {
    const impact = computeImpact(graph, ["src/new.ts"]);
    expect(impact.changedFiles).toEqual(["src/new.ts"]);
    expect(impact.affectedFiles).toEqual([]);
    expect(impact.directDependencies).toEqual([{ file: "src/new.ts", dependsOn: [] }]);
  });
  it("affected files never include the changed files themselves and are unique and sorted", () => {
    const impact = computeImpact(graph, ["src/a.ts", "src/d.ts"]);
    expect(impact.affectedFiles).toEqual(["src/e.ts"]);
    const reversed = computeImpact(graph, ["src/d.ts", "src/a.ts", "src/a.ts"]);
    expect(reversed).toEqual(impact);
    expect(reversed.changedFiles).toEqual(["src/a.ts", "src/d.ts"]);
  });
  it("no changed files → empty impact", () => {
    expect(computeImpact(graph, []).changedFiles).toEqual([]);
    expect(computeImpact(graph, [])).toMatchObject({ affectedFiles: [], evidence: [] });
  });
  it("drops changed entries that are not clean repo paths so the result is always schema-valid", () => {
    const impact = computeImpact(graph, ["/abs", "../x", "src\\a.ts", "src/a.ts", 7 as never]);
    expect(impact.changedFiles).toEqual(["src/a.ts"]);
    expect(ImpactContextSchema.safeParse(impact).success).toBe(true);
  });
  it("caps evidence at 50 items on a huge fan-in", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({ file: `src/n${i}.ts` }));
    const edges = nodes.slice(1).map((n) => ({ from: n.file, to: "src/n0.ts" }));
    const big = ImportGraphSchema.parse({ nodes, edges });
    const impact = computeImpact(big, ["src/n0.ts"]);
    expect(impact.evidence.length).toBe(50);
    expect(impact.affectedFiles.length).toBe(299);
    expect(ImpactContextSchema.safeParse(impact).success).toBe(true);
  });
  it("keeps the result within the ImpactContext list caps even for a 6000-importer file", () => {
    const edges = Array.from({ length: 6000 }, (_, i) => ({
      from: `src/n${i}.ts`,
      to: "src/hub.ts",
    }));
    const impact = computeImpact(ImportGraphSchema.parse({ nodes: [], edges }), ["src/hub.ts"]);
    expect(impact.affectedFiles.length).toBe(5000);
    expect(ImpactContextSchema.safeParse(impact).success).toBe(true);
  });
  it("evidence text stays within its limit for maximum-length paths", () => {
    const long = (c: string) => `${c.repeat(1000)}.ts`;
    const g = ImportGraphSchema.parse({ nodes: [], edges: [{ from: long("a"), to: long("b") }] });
    expect(ImpactContextSchema.safeParse(computeImpact(g, [long("a")])).success).toBe(true);
    expect(ImpactContextSchema.safeParse(computeImpact(g, [long("b")])).success).toBe(true);
  });
  it("rejects a graph with a non-repo-relative path", () => {
    expect(ImportGraphSchema.safeParse({ nodes: [{ file: "/abs" }], edges: [] }).success).toBe(
      false,
    );
    expect(
      ImportGraphSchema.safeParse({ nodes: [], edges: [{ from: "a.ts", to: "../b.ts" }] }).success,
    ).toBe(false);
    expect(
      ImportGraphSchema.safeParse({ nodes: [{ file: "a.ts", complexity: -1 }], edges: [] }).success,
    ).toBe(false);
  });
});
