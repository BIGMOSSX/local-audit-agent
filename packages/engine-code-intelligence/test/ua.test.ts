import { RepoPathSchema } from "@audit/audit-core";
import { describe, expect, it, vi } from "vitest";
import { ImportGraphSchema } from "../src/graph";
import { computeImpact } from "../src/impact";
import { mapUaGraph, UaGraphSchema } from "../src/ua";
import captured from "./fixtures/ua-captured/graph.json";

// The cap tests build inputs of up to a million entries; shared CI runners need far longer than the 5 s
// default (one took >5 s on all three OSes). Nothing here asserts on elapsed time.
vi.setConfig({ testTimeout: 60_000 });

type RawNode = { id: string; type: string; filePath?: string };
type RawEdge = { source: string; target: string; type: string };
const rawNodes = captured.nodes as RawNode[];
const rawEdges = captured.edges as RawEdge[];

// Expectations are derived from the raw capture here, independently of mapUaGraph.
const filePaths = rawNodes.filter((n) => n.type === "file").map((n) => n.id.slice("file:".length));
const known = new Set(filePaths);
const importEdges = rawEdges.filter(
  (e) =>
    e.type === "imports" &&
    e.source.startsWith("file:") &&
    e.target.startsWith("file:") &&
    known.has(e.source.slice(5)) &&
    known.has(e.target.slice(5)),
);
const importersOf = (file: string) =>
  [
    ...new Set(
      importEdges
        .filter((e) => e.target === `file:${file}`)
        .map((e) => e.source.slice("file:".length)),
    ),
  ]
    .filter((f) => f !== file)
    .sort();
const importsOf = (file: string) =>
  [
    ...new Set(
      importEdges.filter((e) => e.source === `file:${file}`).map((e) => e.target.slice(5)),
    ),
  ].sort();

const fileNode = (path: string, extra: Record<string, unknown> = {}) => ({
  id: `file:${path}`,
  type: "file",
  name: path,
  filePath: path,
  ...extra,
});
const imp = (from: string, to: string) => ({
  source: `file:${from}`,
  target: `file:${to}`,
  type: "imports",
});

describe("UaGraphSchema", () => {
  it("parses the captured graph", () => {
    expect(UaGraphSchema.safeParse(captured).success).toBe(true);
  });
  it("is strict only on the fields mapUaGraph reads, loose elsewhere", () => {
    const extra = { nodes: [{ id: "a", type: "t", whatever: [1] }], edges: [], futureField: 1 };
    expect(UaGraphSchema.safeParse(extra).success).toBe(true);
    expect(UaGraphSchema.safeParse({ nodes: [{ id: 1, type: "t" }], edges: [] }).success).toBe(
      false,
    );
    expect(
      UaGraphSchema.safeParse({ nodes: [], edges: [{ source: "a", type: "imports" }] }).success,
    ).toBe(false);
    expect(UaGraphSchema.safeParse({ nodes: "x", edges: [] }).success).toBe(false);
  });
});

describe("mapUaGraph on the captured fixture", () => {
  const { graph, dropped } = mapUaGraph(captured);

  it("keeps every file node and every import between known files, nothing else", () => {
    expect(filePaths.length).toBe(61);
    expect(importEdges.length).toBe(174);
    expect(graph.nodes.length).toBe(filePaths.length);
    expect(graph.edges.length).toBe(importEdges.length);
    expect(dropped).toBe(0);
    expect(graph.nodes.map((n) => n.file)).toEqual([...filePaths].sort());
  });
  it("passes ImportGraphSchema with clean repo-relative POSIX paths", () => {
    expect(ImportGraphSchema.safeParse(graph).success).toBe(true);
    for (const n of graph.nodes) {
      expect(RepoPathSchema.safeParse(n.file).success).toBe(true);
      expect(n.file).not.toContain("\\");
    }
  });
  it("does not invent a numeric complexity from the placeholder string", () => {
    expect(rawNodes.some((n) => (n as { complexity?: unknown }).complexity === "simple")).toBe(
      true,
    );
    expect(graph.nodes.every((n) => !("complexity" in n))).toBe(true);
  });
  it("has no function nodes and no contains edges", () => {
    const files = new Set(graph.nodes.map((n) => n.file));
    expect(graph.edges.every((e) => files.has(e.from) && files.has(e.to))).toBe(true);
  });
  it("is deterministic, sorted and unique", () => {
    expect(mapUaGraph(captured)).toEqual({ graph, dropped, truncated: false });
    const reversed = {
      ...captured,
      nodes: [...rawNodes].reverse(),
      edges: [...rawEdges].reverse(),
    };
    expect(mapUaGraph(reversed).graph).toEqual(graph);
    const keys = graph.edges.map((e) => `${e.from}\0${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
  });
  it("computeImpact over the mapped graph agrees with importers derived from the raw imports edges", () => {
    const withImporters = filePaths.filter((f) => importersOf(f).length > 0);
    expect(withImporters.length).toBeGreaterThan(10);
    for (const f of filePaths) {
      const impact = computeImpact(graph, [f]);
      expect(impact.affectedFiles).toEqual(importersOf(f));
      expect(impact.directDependencies).toEqual([{ file: f, dependsOn: importsOf(f) }]);
    }
    const multi = filePaths.find((f) => importersOf(f).length >= 3) as string;
    expect(multi).toBeDefined();
    expect(computeImpact(graph, [multi]).affectedFiles.length).toBeGreaterThanOrEqual(3);
  });
});

describe("mapUaGraph filtering", () => {
  it("drops edges that point outside the node set, to functions, or from unknown ids", () => {
    const raw = {
      nodes: [
        fileNode("a.ts"),
        fileNode("b.ts"),
        { id: "function:a.ts:f", type: "function", filePath: "a.ts" },
      ],
      edges: [
        imp("a.ts", "b.ts"),
        imp("a.ts", "missing.ts"),
        imp("missing.ts", "b.ts"),
        { source: "file:a.ts", target: "function:a.ts:f", type: "imports" },
        { source: "file:a.ts", target: "function:a.ts:f", type: "contains" },
      ],
    };
    const { graph, dropped } = mapUaGraph(raw);
    expect(graph.edges).toEqual([{ from: "a.ts", to: "b.ts" }]);
    expect(graph.nodes).toEqual([{ file: "a.ts" }, { file: "b.ts" }]);
    expect(dropped).toBe(3);
  });
  it("drops self-loops and counts them", () => {
    const { graph, dropped } = mapUaGraph({
      nodes: [fileNode("a.ts")],
      edges: [imp("a.ts", "a.ts")],
    });
    expect(graph.edges).toEqual([]);
    expect(dropped).toBe(1);
  });
  it("dedupes nodes and edges and counts the duplicates", () => {
    const { graph, dropped } = mapUaGraph({
      nodes: [fileNode("a.ts"), fileNode("a.ts"), fileNode("b.ts")],
      edges: [imp("a.ts", "b.ts"), imp("a.ts", "b.ts")],
    });
    expect(graph).toEqual({
      nodes: [{ file: "a.ts" }, { file: "b.ts" }],
      edges: [{ from: "a.ts", to: "b.ts" }],
    });
    expect(dropped).toBe(2);
  });
  it("keeps only a finite non-negative numeric complexity", () => {
    const { graph } = mapUaGraph({
      nodes: [
        fileNode("a.ts", { complexity: 7 }),
        fileNode("b.ts", { complexity: "simple" }),
        fileNode("c.ts", { complexity: -1 }),
        fileNode("d.ts", { complexity: null }),
        fileNode("e.ts", { complexity: 0 }),
      ],
      edges: [],
    });
    expect(graph.nodes).toEqual([
      { file: "a.ts", complexity: 7 },
      { file: "b.ts" },
      { file: "c.ts" },
      { file: "d.ts" },
      { file: "e.ts", complexity: 0 },
    ]);
    expect(ImportGraphSchema.safeParse(graph).success).toBe(true);
  });
  it("normalizes backslashes to slashes and merges the resulting duplicate", () => {
    const { graph, dropped } = mapUaGraph({
      nodes: [fileNode("src\\a.ts"), fileNode("src/a.ts"), fileNode("src\\b.ts")],
      edges: [{ source: "file:src\\b.ts", target: "file:src\\a.ts", type: "imports" }],
    });
    expect(graph.nodes.map((n) => n.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.edges).toEqual([{ from: "src/b.ts", to: "src/a.ts" }]);
    expect(dropped).toBe(1);
  });
  it("ignores unknown node/edge types without counting them", () => {
    const { graph, dropped } = mapUaGraph({
      nodes: [fileNode("a.ts"), { id: "config:x", type: "config" }],
      edges: [{ source: "a", target: "b", type: "calls" }],
    });
    expect(graph.nodes).toEqual([{ file: "a.ts" }]);
    expect(dropped).toBe(0);
  });
  it("drops a file node whose id does not name its filePath", () => {
    const { graph, dropped } = mapUaGraph({
      nodes: [{ id: "file:a.ts", type: "file", filePath: "b.ts" }, fileNode("c.ts")],
      edges: [],
    });
    expect(graph.nodes).toEqual([{ file: "c.ts" }]);
    expect(dropped).toBe(1);
  });
});

describe("mapUaGraph edge direction and truncation", () => {
  const nodes = [fileNode("a.ts"), fileNode("b.ts")];
  it("accepts an absent or forward direction and drops anything else, counted", () => {
    const e = imp("a.ts", "b.ts");
    expect(mapUaGraph({ nodes, edges: [e] }).graph.edges).toHaveLength(1);
    expect(mapUaGraph({ nodes, edges: [{ ...e, direction: "forward" }] }).graph.edges).toHaveLength(
      1,
    );
    for (const direction of ["backward", "bidirectional", "", 3, null]) {
      const r = mapUaGraph({ nodes, edges: [{ ...e, direction }] });
      expect(r.graph.edges).toEqual([]);
      expect(r.dropped).toBe(1);
    }
  });
  it("is not truncated for the capture or for benign drops", () => {
    expect(mapUaGraph(captured).truncated).toBe(false);
    const benign = mapUaGraph({
      nodes: [...nodes, fileNode("a.ts"), null, fileNode("../x")],
      edges: [imp("a.ts", "a.ts"), imp("a.ts", "b.ts"), imp("a.ts", "b.ts"), imp("a.ts", "zz.ts")],
    });
    expect(benign.dropped).toBeGreaterThan(0);
    expect(benign.truncated).toBe(false);
    expect(mapUaGraph(null).truncated).toBe(false);
  });
  it("is truncated when a file, node-scan or edge-scan cap is hit", () => {
    const files = Array.from({ length: 100_001 }, (_, i) => fileNode(`d/f${i}.ts`));
    expect(mapUaGraph({ nodes: files, edges: [] }).truncated).toBe(true);
    expect(mapUaGraph({ nodes: new Array(1_000_001).fill(null), edges: [] }).truncated).toBe(true);
    expect(mapUaGraph({ nodes, edges: new Array(1_000_001).fill(null) }).truncated).toBe(true);
    expect(mapUaGraph({ nodes: new Array(1_000_000).fill(null), edges: [] }).truncated).toBe(false);
  });
});

describe("mapUaGraph hostile input never throws", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["an array", []],
    ["a 10 MB string", "x".repeat(10 * 1024 * 1024)],
    ["missing arrays", {}],
    ["non-array nodes", { nodes: { length: 3 }, edges: [] }],
    ["null entries", { nodes: [null, 1, "x", [], undefined], edges: [null, 2] }],
    [
      "non-string ids",
      {
        nodes: [
          { id: 1, type: "file", filePath: "a.ts" },
          { id: "file:a.ts", type: 5 },
        ],
        edges: [{ source: 1, target: 2, type: "imports" }],
      },
    ],
  ];
  for (const [name, raw] of cases) {
    it(`handles ${name}`, () => {
      const r = mapUaGraph(raw);
      expect(ImportGraphSchema.safeParse(r.graph).success).toBe(true);
      expect(r.graph.nodes).toEqual([]);
      expect(r.graph.edges).toEqual([]);
    });
  }
  it("non-array edges keep the valid nodes, return no edges and count one drop", () => {
    const r = mapUaGraph({ nodes: [fileNode("a.ts")], edges: "nope" });
    expect(r.graph).toEqual({ nodes: [{ file: "a.ts" }], edges: [] });
    expect(r.dropped).toBe(1);
  });
  it("counts what it dropped for empty or unusable input", () => {
    expect(mapUaGraph({}).dropped).toBe(1);
    expect(mapUaGraph({ nodes: [null, 1], edges: [] }).dropped).toBe(2);
  });
  it("rejects traversal, absolute, NUL, empty and control-character paths", () => {
    const bad = [
      "../x.ts",
      "a/../b.ts",
      "/etc/passwd",
      "C:\\x.ts",
      "C:/x.ts",
      "a\0b.ts",
      "",
      "a//b.ts",
      "./a.ts",
      "a\nb.ts",
      "a\u202eb.ts",
      "x".repeat(1025),
    ];
    const { graph, dropped } = mapUaGraph({
      nodes: [...bad.map((p) => fileNode(p)), fileNode("ok.ts")],
      edges: [],
    });
    expect(graph.nodes).toEqual([{ file: "ok.ts" }]);
    expect(dropped).toBe(bad.length);
  });
  it("rejects a path that sanitizing would alter (zero-width character)", () => {
    const { graph, dropped } = mapUaGraph({ nodes: [fileNode("a\u200b.ts")], edges: [] });
    expect(graph.nodes).toEqual([]);
    expect(dropped).toBe(1);
  });
  it("keeps a non-ASCII file name that sanitizing leaves alone", () => {
    expect(mapUaGraph({ nodes: [fileNode("src/文件.ts")], edges: [] }).graph.nodes).toEqual([
      { file: "src/文件.ts" },
    ]);
  });
  it("survives __proto__ keys without polluting anything", () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":1},"nodes":[{"id":"file:a.ts","type":"file","filePath":"a.ts","__proto__":{"polluted":1}},{"__proto__":{"x":1}}],"edges":[{"__proto__":{"polluted":1},"source":"file:a.ts","target":"file:a.ts","type":"imports"}]}',
    );
    const r = mapUaGraph(raw);
    expect(r.graph.nodes).toEqual([{ file: "a.ts" }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r.graph.nodes[0] ?? {})).toEqual(["file"]);
  });
  it("survives deeply nested junk", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50_000; i++) deep = { n: deep };
    const r = mapUaGraph({
      nodes: [
        fileNode("a.ts", { junk: deep, complexity: deep }),
        { id: "x", type: "file", filePath: deep },
      ],
      edges: [{ source: "file:a.ts", target: "file:a.ts", type: "imports", junk: deep }],
    });
    expect(r.graph.nodes).toEqual([{ file: "a.ts" }]);
  });
  it("a hostile getter or proxy cannot make it throw", () => {
    const evil = new Proxy(
      {},
      {
        get: () => {
          throw new Error("boom");
        },
      },
    );
    expect(mapUaGraph(evil).graph).toEqual({ nodes: [], edges: [] });
    expect(mapUaGraph({ nodes: [evil], edges: [evil] }).graph.nodes).toEqual([]);
  });
  it("a 10 MB id or path is dropped without being hashed into the graph", () => {
    const big = "x".repeat(10 * 1024 * 1024);
    const r = mapUaGraph({
      nodes: [fileNode("a.ts"), { id: `file:${big}`, type: "file", filePath: big }],
      edges: [{ source: `file:${big}`, target: "file:a.ts", type: "imports" }],
    });
    expect(r.graph).toEqual({ nodes: [{ file: "a.ts" }], edges: [] });
    expect(r.dropped).toBe(2);
  });
  it("caps file nodes at 100 000: the first 100 000 are kept, the rest and their edges are dropped", () => {
    const nodes = Array.from({ length: 100_001 }, (_, i) => fileNode(`d/f${i}.ts`));
    const edges = [imp("d/f0.ts", "d/f100000.ts"), imp("d/f0.ts", "d/f1.ts")];
    const r = mapUaGraph({ nodes, edges });
    expect(r.graph.nodes.length).toBe(100_000);
    expect(r.graph.nodes.some((n) => n.file === "d/f100000.ts")).toBe(false);
    expect(r.graph.edges).toEqual([{ from: "d/f0.ts", to: "d/f1.ts" }]);
    expect(r.dropped).toBe(2);
    expect(ImportGraphSchema.safeParse(r.graph).success).toBe(true);
  });
  it("does not scan more than 1 000 000 raw nodes and counts the overflow as dropped", () => {
    const nodes = new Array(1_000_003).fill(null);
    expect(mapUaGraph({ nodes, edges: [] }).dropped).toBe(1_000_003);
  });
  it("caps edges at 1 000 000 scanned entries and counts the overflow as dropped", () => {
    const edges = new Array(1_000_002).fill(null);
    const r = mapUaGraph({ nodes: [fileNode("a.ts")], edges });
    expect(r.dropped).toBe(1_000_002);
    expect(r.graph.edges).toEqual([]);
  });
  it("an edge past the scan cap is never read", () => {
    const edges: unknown[] = new Array(1_000_000).fill(null);
    edges.push(imp("a.ts", "b.ts"));
    const r = mapUaGraph({ nodes: [fileNode("a.ts"), fileNode("b.ts")], edges });
    expect(r.graph.edges).toEqual([]);
    expect(r.dropped).toBe(1_000_001);
  });
});
