import { emptyImpact, type ProjectContext, runEngine } from "@audit/audit-core";
import { engineContract } from "@audit/audit-core/testing";
import { describe, expect, it } from "vitest";
import { createCodeIntelligenceEngine } from "../src/engine";
import { ImportGraphSchema } from "../src/graph";
import { computeImpact } from "../src/impact";
import small from "./fixtures/graph-small.json";

const graph = ImportGraphSchema.parse(small);
const context: ProjectContext = {
  project: {
    path: "/p",
    name: "p",
    ecosystems: ["node"],
    packageManager: "npm",
    isMonorepo: false,
    isGitRepo: true,
  },
  rootDir: "/p",
  files: graph.nodes.map((n) => n.file),
};
const forbidden = ["understand", "agentic", "aqe", "anthropic", "openai"];

// The shared contract runs with an empty impact, so a healthy run legitimately has no tasks and no findings.
engineContract("code-intelligence", () => createCodeIntelligenceEngine(graph), {
  forbiddenNames: forbidden,
  context,
  allowEmpty: true,
});

// Same engine, but plan() always sees a changed file, so a run executes the impact task and yields findings.
engineContract(
  "code-intelligence (changed file)",
  () => {
    const engine = createCodeIntelligenceEngine(graph, {
      wideAffectedThreshold: 1,
      highComplexity: 1,
    });
    return {
      ...engine,
      plan: (c) => engine.plan(c, { ...emptyImpact(), changedFiles: ["src/a.ts"] }),
    };
  },
  { forbiddenNames: forbidden, context },
);

const input = (impact = emptyImpact(), signal = new AbortController().signal) => ({
  context,
  impact,
  projectDir: "/sandbox/p",
  userCode: { allowed: false },
  signal,
  tools: null,
});
const changedA = { ...emptyImpact(), changedFiles: ["src/a.ts"] };

describe("code intelligence engine", () => {
  it("feeds impact to other engines: impact() = computeImpact over the injected graph", async () => {
    const engine = createCodeIntelligenceEngine(graph);
    expect((await engine.impact(context, ["src/a.ts"])).affectedFiles).toEqual([
      "src/d.ts",
      "src/e.ts",
    ]);
    expect(
      (await createCodeIntelligenceEngine(null).impact(context, ["src/a.ts"])).changedFiles,
    ).toEqual(["src/a.ts"]);
  });
  it("emits an info finding for a wide blast radius and a high-complexity changed file only", async () => {
    const engine = createCodeIntelligenceEngine(graph, {
      wideAffectedThreshold: 2,
      highComplexity: 10,
    });
    const run = await runEngine(engine, input(changedA));
    expect(run.findings.map((f) => f.ruleId).sort()).toEqual([
      "code-intelligence.high-complexity",
      "code-intelligence.wide-impact",
    ]);
    expect(run.findings.every((f) => f.source === "static-analysis" && f.severity === "info")).toBe(
      true,
    );
    expect(run.findings.find((f) => f.ruleId.endsWith("high-complexity"))).toMatchObject({
      file: "src/a.ts",
      category: "maintainability",
    });
    expect(run.findings.find((f) => f.ruleId.endsWith("wide-impact"))?.category).toBe(
      "architecture",
    );
    expect(run.completeness).toBe("complete");
    expect(run.tasks).toEqual([{ id: "code-intelligence.impact-review", status: "ok" }]);
  });
  it("below both thresholds it emits nothing, and finding ids are stable across runs", async () => {
    const quiet = await runEngine(createCodeIntelligenceEngine(graph), input(changedA));
    expect(quiet.findings).toEqual([]);
    const mk = () =>
      runEngine(
        createCodeIntelligenceEngine(graph, { wideAffectedThreshold: 2, highComplexity: 10 }),
        input(changedA),
      );
    const [a, b] = [await mk(), await mk()];
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
    expect(a.findings.every((f) => /^[0-9a-f]{32}$/.test(f.id))).toBe(true);
  });
  it("no forbidden vendor/engine name appears in findings or plan", async () => {
    const engine = createCodeIntelligenceEngine(graph, {
      wideAffectedThreshold: 1,
      highComplexity: 1,
    });
    const run = await runEngine(engine, input(changedA));
    const plan = await engine.plan(context, changedA);
    const seen = JSON.stringify([run, plan]).toLowerCase();
    expect(run.findings.length).toBeGreaterThan(0);
    for (const n of forbidden) expect(seen).not.toContain(n);
  });
  it("with nothing changed it emits nothing", async () => {
    const run = await runEngine(createCodeIntelligenceEngine(graph), input());
    expect(run.findings).toEqual([]);
    expect(run.tasks).toEqual([]);
  });
  it("is not applicable without a graph", async () => {
    const engine = createCodeIntelligenceEngine(null);
    expect((await engine.detect(context)).applicable).toBe(false);
    const run = await runEngine(engine, input(changedA));
    expect(run.findings).toEqual([]);
    expect(run.tasks).toEqual([]);
  });
  it("plan scopes only clean changed paths and is read-only, offline", async () => {
    const engine = createCodeIntelligenceEngine(graph);
    const plan = await engine.plan(context, {
      ...emptyImpact(),
      changedFiles: ["src/a.ts", "/abs", "../x", "src/a.ts"],
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      scope: ["src/a.ts"],
      readOnly: true,
      networkRequired: false,
    });
  });
  it("honors an aborted signal and never reads context.rootDir during execute", async () => {
    const engine = createCodeIntelligenceEngine(graph);
    const [task] = (await engine.plan(context, changedA)).tasks;
    if (!task) throw new Error("no task");
    const ac = new AbortController();
    ac.abort();
    const hostile = {
      ...context,
      get rootDir(): string {
        throw new Error("rootDir was read");
      },
    };
    const base = {
      context: hostile,
      projectDir: "/sandbox/p",
      scope: task.scope,
      userCode: { allowed: false },
      tools: null,
    };
    expect((await engine.execute(task, { ...base, signal: ac.signal })).status).toBe("skipped");
    const ok = await engine.execute(task, { ...base, signal: new AbortController().signal });
    expect(ok.status).toBe("ok");
  });
  it("normalize ignores skipped results, foreign tasks and malformed data", () => {
    const engine = createCodeIntelligenceEngine(graph, {
      wideAffectedThreshold: 1,
      highComplexity: 1,
    });
    const id = "code-intelligence.impact-review";
    expect(engine.normalize({ taskId: id, status: "skipped", data: null })).toEqual([]);
    expect(engine.normalize({ taskId: "other", status: "ok", data: emptyImpact() })).toEqual([]);
    for (const data of [
      null,
      "x",
      3,
      [],
      { affectedFiles: ["../x"] },
      { ...emptyImpact(), changedFiles: ["/abs"] },
    ]) {
      expect(engine.normalize({ taskId: id, status: "ok", data })).toEqual([]);
    }
  });
  it("wide-impact evidence only shows importer lines even with 60 dependencies and 30 importers", async () => {
    const deps = Array.from({ length: 60 }, (_, i) => `lib/dep${i}.ts`);
    const users = Array.from({ length: 30 }, (_, i) => `app/user${i}.ts`);
    const big = ImportGraphSchema.parse({
      nodes: [],
      edges: [
        ...deps.map((d) => ({ from: "core/hub.ts", to: d })),
        ...users.map((u) => ({ from: u, to: "core/hub.ts" })),
      ],
    });
    const engine = createCodeIntelligenceEngine(big, { wideAffectedThreshold: 20 });
    const run = await runEngine(engine, input({ ...emptyImpact(), changedFiles: ["core/hub.ts"] }));
    const wide = run.findings.find((f) => f.ruleId === "code-intelligence.wide-impact");
    expect(wide?.title).toBe("Change touches 30 dependent files");
    expect(wide?.evidence).toHaveLength(20);
    expect(
      wide?.evidence.every(
        (e) => e.text === "imports core/hub.ts" && e.file?.startsWith("app/user"),
      ),
    ).toBe(true);
  });
  it("impact evidence keeps importer lines when dependencies are many", () => {
    const edges = [
      ...Array.from({ length: 60 }, (_, i) => ({ from: "core/hub.ts", to: `lib/dep${i}.ts` })),
      ...Array.from({ length: 30 }, (_, i) => ({ from: `app/user${i}.ts`, to: "core/hub.ts" })),
    ];
    const impact = computeImpact(ImportGraphSchema.parse({ nodes: [], edges }), ["core/hub.ts"]);
    expect(impact.evidence).toHaveLength(50);
    expect(impact.evidence.filter((e) => e.text === "imports core/hub.ts")).toHaveLength(25);
  });
  it("counts below the cap are exact", async () => {
    const run = await runEngine(
      createCodeIntelligenceEngine(graph, { wideAffectedThreshold: 2 }),
      input(changedA),
    );
    const wide = run.findings.find((f) => f.ruleId.endsWith("wide-impact"));
    expect(wide?.title).toBe("Change touches 2 dependent files");
    expect(wide?.message).toBe("1 changed file(s) are imported directly by 2 other files.");
  });
  it("carries the true dependent count past the 5000 list cap", async () => {
    const edges = Array.from({ length: 6000 }, (_, i) => ({
      from: `src/n${i}.ts`,
      to: "src/hub.ts",
    }));
    const hub = ImportGraphSchema.parse({ nodes: [], edges });
    const run = await runEngine(
      createCodeIntelligenceEngine(hub),
      input({ ...emptyImpact(), changedFiles: ["src/hub.ts"] }),
    );
    expect(run.findings.find((f) => f.ruleId.endsWith("wide-impact"))?.title).toBe(
      "Change touches 6000 dependent files",
    );
  });
  it("says 'at least' when only a capped list is known", () => {
    const engine = createCodeIntelligenceEngine(graph);
    const impact = {
      ...emptyImpact(),
      changedFiles: ["src/hub.ts"],
      affectedFiles: Array.from({ length: 5000 }, (_, i) => `src/n${i}.ts`),
    };
    const [f] = engine.normalize({
      taskId: "code-intelligence.impact-review",
      status: "ok",
      data: { impact },
    });
    expect(f?.title).toBe("Change touches at least 5000 dependent files");
    expect(f?.message).toContain("at least 5000 other files");
    const [exact] = engine.normalize({
      taskId: "code-intelligence.impact-review",
      status: "ok",
      data: { impact, affectedTotal: 5000 },
    });
    expect(exact?.title).toBe("Change touches 5000 dependent files");
  });
  it("says 'at least' for a capped changed-file list", () => {
    const engine = createCodeIntelligenceEngine(graph);
    const impact = {
      ...emptyImpact(),
      changedFiles: Array.from({ length: 5000 }, (_, i) => `src/c${i}.ts`),
      affectedFiles: ["src/x.ts"],
    };
    const [f] = engine.normalize({
      taskId: "code-intelligence.impact-review",
      status: "ok",
      data: { impact, affectedTotal: 1 },
    });
    expect(f).toBeUndefined();
    const [g] = createCodeIntelligenceEngine(graph, { wideAffectedThreshold: 1 }).normalize({
      taskId: "code-intelligence.impact-review",
      status: "ok",
      data: { impact, affectedTotal: 1 },
    });
    expect(g?.message).toContain("at least 5000 changed file(s)");
  });
  it("an invalid injected graph behaves as no graph", async () => {
    const bad = { nodes: [{ file: "/abs" }], edges: [] } as never;
    const engine = createCodeIntelligenceEngine(bad);
    expect((await engine.detect(context)).applicable).toBe(false);
    const run = await runEngine(engine, input(changedA));
    expect(run.findings).toEqual([]);
    expect(run.tasks).toEqual([]);
  });
});
