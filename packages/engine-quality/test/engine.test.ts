import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyImpact, runEngine } from "@audit/audit-core";
import { engineContract } from "@audit/audit-core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { AQE_ALLOWED_TOOLS, createQualityEngine } from "../src";
import { loadResult, retarget } from "./aqe-fixtures";

// `sandboxDir` is what the adapter must read (runtime.projectDir). `realDir` is the decoy "real project"
// (context.rootDir): it deliberately has NO framework, so any read of it changes the result.
const sandboxDir = mkdtempSync(join(tmpdir(), "eq-sandbox-"));
const realDir = mkdtempSync(join(tmpdir(), "eq-real-"));
afterAll(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(realDir, { recursive: true, force: true });
});
const files = ["package.json", "src/a.ts", "src/a.test.ts", "src/b.ts"];
writeFileSync(join(sandboxDir, "package.json"), '{"devDependencies":{"vitest":"5"}}');
writeFileSync(join(realDir, "package.json"), "{}");
mkdirSync(join(sandboxDir, "src"));
const context = {
  project: {
    path: realDir,
    name: "p",
    ecosystems: ["node"] as const,
    packageManager: "npm" as const,
    isMonorepo: false,
    isGitRepo: false,
  },
  rootDir: realDir,
  files,
};
const project = { ...context, project: { ...context.project, ecosystems: ["node" as const] } };

// A host that answers the one allowed tool with the captured measured response, re-rooted at `dir`.
function host(dir: string, answer?: (tool: string, args: Record<string, unknown>) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return answer ? answer(tool, args) : retarget(loadResult("measured"), dir);
    },
  };
}

engineContract("quality", createQualityEngine, {
  forbiddenNames: ["agentic", "aqe", "vibium", "understand", "anthropic", "openai"],
  context: project,
  projectDir: sandboxDir,
  tools: host(sandboxDir),
});

describe("quality engine", () => {
  const input = (allowed: boolean) => ({
    context: project,
    impact: emptyImpact(),
    projectDir: sandboxDir,
    userCode: { allowed },
    signal: new AbortController().signal,
    tools: null,
  });

  it("§113: detects the framework and reports the missing test path as a normalized finding", async () => {
    const run = await runEngine(createQualityEngine(), input(false));
    const gap = run.findings.filter((f) => f.ruleId === "quality.missing-test");
    expect(gap.map((f) => f.file)).toEqual(["src/b.ts"]);
    expect(gap[0]).toMatchObject({
      engine: "quality",
      category: "testing",
      source: "heuristic",
      confidence: "low",
    });
    // The framework lives only in projectDir; the decoy rootDir has none. Reading rootDir would add this finding.
    expect(run.findings.some((f) => f.ruleId === "quality.no-test-framework")).toBe(false);
  });
  it("§16/R6: without consent the run-tests task is skipped and the run is partial with the exact reason", async () => {
    const run = await runEngine(createQualityEngine(), input(false));
    expect(run.completeness).toBe("partial");
    expect(run.notDone).toContainEqual({
      what: "运行项目测试",
      reason: "无法在隔离环境中执行（未获用户授权或隔离机制不可用）",
    });
  });
  it("even with consent, run-tests is skipped: no isolation mechanism exists (R6)", async () => {
    const run = await runEngine(createQualityEngine(), input(true));
    expect(run.tasks.find((t) => t.id === "quality.run-tests")?.status).toBe("skipped");
    expect(run.completeness).toBe("partial");
  });
  it("a project with no test framework yields one 'no tests' finding", async () => {
    const bare = mkdtempSync(join(tmpdir(), "eq-bare-"));
    try {
      writeFileSync(join(bare, "package.json"), "{}");
      // Reverse decoy: rootDir (= sandboxDir) HAS vitest, projectDir (= bare) has none. The adapter must follow projectDir.
      const ctx = { ...project, rootDir: sandboxDir, files: ["package.json", "index.js"] };
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        projectDir: bare,
        context: ctx,
      });
      expect(run.findings.some((f) => f.ruleId === "quality.no-test-framework")).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
  it("never opens context.rootDir: a rootDir that does not exist changes nothing", async () => {
    const missing = join(realDir, "does", "not", "exist");
    const ghost = { ...project, rootDir: missing, project: { ...project.project, path: missing } };
    const a = await runEngine(createQualityEngine(), input(false));
    const b = await runEngine(createQualityEngine(), { ...input(false), context: ghost });
    expect(b.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id));
  });
  it("is not applicable to a folder with no recognised ecosystem", async () => {
    const run = await runEngine(createQualityEngine(), {
      ...input(false),
      context: { ...project, project: { ...project.project, ecosystems: [] } },
    });
    expect(run.findings).toEqual([]);
  });

  describe("robustness", () => {
    it("truncation is reported: a capped list ends with one info finding stating how many were left out", async () => {
      const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`);
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        context: { ...project, files: ["package.json", ...many] },
      });
      expect(run.findings.filter((f) => f.ruleId === "quality.missing-test")).toHaveLength(25);
      const more = run.findings.filter((f) => f.ruleId === "quality.missing-test-truncated");
      expect(more).toHaveLength(1);
      expect(more[0]?.severity).toBe("info");
      expect(more[0]?.message).toContain("55");
    });
    it("skips file-list entries that are not clean repo-relative paths, never throws", async () => {
      const bad = [
        "../x.ts",
        "/abs/x.ts",
        "src/\u0000z.ts",
        "C:\\x.ts",
        "a/./b.ts",
        "src//d.ts",
        "",
        "src/\u202ee.ts",
      ];
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        context: {
          ...project,
          files: ["package.json", "src/ok.ts", ...bad, 7 as unknown as string],
        },
      });
      expect(
        run.findings.filter((f) => f.ruleId === "quality.missing-test").map((f) => f.file),
      ).toEqual(["src/ok.ts"]);
      expect(run.tasks.every((t) => t.status !== "failed")).toBe(true);
    });
    it("normalizes Windows separators in the file list (matching only) and reports POSIX paths", async () => {
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        context: {
          ...project,
          files: ["package.json", "src\\a.ts", "src\\a.test.ts", "src\\win.ts"],
        },
      });
      expect(
        run.findings.filter((f) => f.ruleId === "quality.missing-test").map((f) => f.file),
      ).toEqual(["src/win.ts"]);
    });
    it.skipIf(process.platform === "win32")(
      "a package.json that is a symlink in the sandbox is not read",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "eq-link-"));
        try {
          writeFileSync(join(realDir, "real.json"), '{"devDependencies":{"vitest":"5"}}');
          symlinkSync(join(realDir, "real.json"), join(dir, "package.json"));
          const run = await runEngine(createQualityEngine(), {
            ...input(false),
            projectDir: dir,
            context: { ...project, files: ["package.json", "src/a.ts"] },
          });
          expect(run.findings.some((f) => f.ruleId === "quality.no-test-framework")).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
    it("plans with hostile impact data without throwing: bad scope paths are dropped, scope is capped", async () => {
      const engine = createQualityEngine();
      const impact = {
        ...emptyImpact(),
        changedFiles: [
          "src/b.ts",
          "../evil",
          "/abs",
          ...Array.from({ length: 6000 }, (_, i) => `s/${i}.ts`),
        ],
      };
      const plan = await engine.plan(project, impact);
      const gap = plan.tasks.find((t) => t.id === "quality.coverage-gap");
      expect(gap?.scope[0]).toBe("src/b.ts");
      expect(gap?.scope.length).toBeLessThanOrEqual(5000);
      expect(gap?.scope).not.toContain("../evil");
      const run = await runEngine(engine, { ...input(false), impact });
      expect(run.notDone.every((n) => !n.what.includes("plan"))).toBe(true);
    });
    it("a change scope limits the missing-test findings to the changed files", async () => {
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        context: { ...project, files: ["package.json", "src/x.ts", "src/y.ts"] },
        impact: { ...emptyImpact(), changedFiles: ["src/y.ts"] },
      });
      expect(
        run.findings.filter((f) => f.ruleId === "quality.missing-test").map((f) => f.file),
      ).toEqual(["src/y.ts"]);
    });
    it("normalize survives garbage data and never throws", () => {
      const engine = createQualityEngine();
      for (const data of [
        null,
        undefined,
        5,
        "x",
        [],
        {},
        { untested: "x", frameworks: 3 },
        { untested: [1, null, "../a.ts", "ok.ts"], frameworks: ["jest"] },
      ]) {
        const out = engine.normalize({ taskId: "quality.coverage-gap", status: "ok", data });
        expect(Array.isArray(out)).toBe(true);
        for (const f of out) expect(f.file === undefined || !f.file.includes("..")).toBe(true);
      }
      expect(
        engine.normalize({ taskId: "quality.coverage-gap", status: "failed", data: null }),
      ).toEqual([]);
    });
    it("drops names containing zero-width or direction marks that RepoPathSchema allows", async () => {
      const run = await runEngine(createQualityEngine(), {
        ...input(false),
        context: {
          ...project,
          files: [
            "package.json",
            "src/ok.ts",
            "src/lrm\u200e.ts",
            "src/zw\u200bz.ts",
            "src/\u2060w.ts",
          ],
        },
      });
      expect(
        run.findings.filter((f) => f.ruleId === "quality.missing-test").map((f) => f.file),
      ).toEqual(["src/ok.ts"]);
    });
    it("an unexpected exception makes the task failed (not skipped) with a fixed note", async () => {
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const exploding = {
        [Symbol.iterator]() {
          throw new Error("boom /secret/path");
        },
      };
      const t = plan.tasks.find((x) => x.id === "quality.coverage-gap");
      if (!t) throw new Error("no task");
      const r = await engine.execute(t, {
        context: { ...project, files: exploding as unknown as string[] },
        projectDir: sandboxDir,
        scope: [],
        userCode: { allowed: false },
        signal: new AbortController().signal,
        tools: null,
      });
      expect(r.status).toBe("failed");
      expect(r.note).toBeTruthy();
      expect(r.note).not.toContain("secret");
    });
    it("with an aborted signal nothing is read and the run stops cleanly", async () => {
      const ac = new AbortController();
      ac.abort();
      const run = await runEngine(createQualityEngine(), { ...input(false), signal: ac.signal });
      expect(run.findings).toEqual([]);
      expect(run.completeness).toBe("partial");
    });
    it("honours the signal inside execute: an aborted task does no work at all", async () => {
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const ac = new AbortController();
      ac.abort();
      for (const t of plan.tasks) {
        let touched = 0;
        // Any read of the file list means work started after the abort.
        const watched = {
          [Symbol.iterator]() {
            touched += 1;
            return files[Symbol.iterator]();
          },
        } as unknown as string[];
        const r = await engine.execute(t, {
          context: { ...project, files: watched },
          // A real sandbox with a real framework: reading it would produce data.
          projectDir: sandboxDir,
          scope: t.scope,
          userCode: { allowed: true },
          signal: ac.signal,
          tools: null,
        });
        expect(r.status).toBe("skipped");
        expect(r.data).toBeNull();
        expect(r.note).toBeTruthy();
        expect(touched).toBe(0);
      }
    });
    it("aborting between tasks stops further work", async () => {
      const ac = new AbortController();
      const engine = createQualityEngine();
      const wrapped = {
        ...engine,
        execute: async (...a: Parameters<typeof engine.execute>) => {
          const r = await engine.execute(...a);
          ac.abort();
          return r;
        },
      };
      const run = await runEngine(wrapped, { ...input(false), signal: ac.signal });
      expect(run.tasks.filter((t) => t.status === "ok")).toHaveLength(1);
    });
    it("handles a 100k-entry file list in linear time with deterministic output", async () => {
      const listOf = (n: number): string[] => {
        const out = ["package.json"];
        for (let i = 0; i < n; i++) out.push(`src/p${i % 500}/f${i}.ts`);
        return out;
      };
      const runWith = (files: string[]) =>
        runEngine(createQualityEngine(), { ...input(false), context: { ...project, files } });
      // Best of three, so one slow scheduling hiccup on a shared CI runner cannot decide the result.
      const bestMs = async (files: string[]): Promise<number> => {
        let best = Number.POSITIVE_INFINITY;
        for (let k = 0; k < 3; k++) {
          const t = performance.now();
          await runWith(files);
          best = Math.min(best, performance.now() - t);
        }
        return best;
      };
      const small = listOf(20_000);
      const large = listOf(100_000);
      await runWith(small); // warm-up: JIT and module init are not what is being measured
      const tSmall = Math.max(await bestMs(small), 1);
      const tLarge = await bestMs(large);
      // 5x the input: linear work is about 5x, quadratic about 25x. The bound sits far from both
      // (it tolerates 3x noise on top of linear) and does not depend on how fast the machine is.
      expect(
        tLarge / tSmall,
        `20k: ${tSmall.toFixed(0)} ms, 100k: ${tLarge.toFixed(0)} ms`,
      ).toBeLessThan(15);

      const a = await runWith(large);
      const b = await runWith([...large].reverse());
      expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
      expect(a.findings.filter((f) => f.ruleId === "quality.missing-test")).toHaveLength(25);
    }, 60_000);
  });

  describe("measured coverage task", () => {
    const withTools = (tools: ReturnType<typeof host> | null, extra = {}) => ({
      ...input(false),
      tools,
      ...extra,
    });
    const coverageStatus = (run: Awaited<ReturnType<typeof runEngine>>) =>
      run.tasks.find((t) => t.id === "quality.measured-coverage")?.status;

    it("is planned as a read-only, offline task", async () => {
      const plan = await createQualityEngine().plan(project, emptyImpact());
      const t = plan.tasks.find((x) => x.id === "quality.measured-coverage");
      expect(t).toMatchObject({ readOnly: true, networkRequired: false, scope: [] });
      expect(plan.tasks.map((x) => x.id)).toEqual([
        "quality.detect-frameworks",
        "quality.coverage-gap",
        "quality.measured-coverage",
        "quality.run-tests",
      ]);
    });
    it("calls exactly the allowed tool with {target: projectDir, detectGaps: true} and nothing else", async () => {
      const h = host(sandboxDir);
      await runEngine(createQualityEngine(), withTools(h, { userCode: { allowed: true } }));
      expect(h.calls).toEqual([
        { tool: "coverage_analyze_sublinear", args: { target: sandboxDir, detectGaps: true } },
      ]);
      expect([...AQE_ALLOWED_TOOLS]).toEqual(["coverage_analyze_sublinear"]);
    });
    it("turns measured coverage into normalized findings (no upstream names)", async () => {
      const run = await runEngine(createQualityEngine(), withTools(host(sandboxDir)));
      const low = run.findings.filter((f) => f.ruleId === "quality.low-coverage");
      expect(low).toHaveLength(25);
      expect(low[0]).toMatchObject({
        engine: "quality",
        source: "static-analysis",
        severity: "medium",
      });
      expect(coverageStatus(run)).toBe("ok");
      expect(JSON.stringify([run.findings, run.notDone])).not.toMatch(
        /agentic|aqe|coverage_analyze|sublinear/i,
      );
    });
    it("a response whose paths all fall outside projectDir is a failure, not a clean ok", async () => {
      const run = await runEngine(
        createQualityEngine(),
        withTools(host(sandboxDir, () => loadResult("measured"))),
      );
      expect(run.findings.filter((f) => f.ruleId === "quality.low-coverage")).toEqual([]);
      expect(coverageStatus(run)).toBe("failed");
      expect(run.notDone).toContainEqual({
        what: "quality: Read measured test coverage",
        reason: "覆盖率报告中的文件路径无法与项目对应，未能得出结论。",
      });
      expect(JSON.stringify(run.notDone)).not.toMatch(/agentic|aqe|coverage_analyze|sublinear/i);
    });
    it("rows outside projectDir are dropped silently when others map", async () => {
      const mixed = retarget(loadResult("measured"), sandboxDir) as {
        content: { text: string }[];
      };
      const doc = JSON.parse(mixed.content[0]?.text ?? "null");
      doc.data.coverageByFile.push({ file: "/elsewhere/x.ts", lineCoverage: 0 });
      const answer = { content: [{ type: "text", text: JSON.stringify(doc) }] };
      const run = await runEngine(createQualityEngine(), withTools(host(sandboxDir, () => answer)));
      expect(coverageStatus(run)).toBe("ok");
      const low = run.findings.filter((f) => f.ruleId === "quality.low-coverage");
      expect(low).toHaveLength(25);
      expect(low.every((f) => f.file?.startsWith("src/mod"))).toBe(true);
    });
    it("an estimate is never reported as measured: no findings, task skipped with a plain note", async () => {
      const h = host(sandboxDir, () => retarget(loadResult("estimated"), sandboxDir));
      const run = await runEngine(createQualityEngine(), withTools(h));
      expect(run.findings.filter((f) => f.ruleId === "quality.low-coverage")).toEqual([]);
      expect(coverageStatus(run)).toBe("skipped");
      expect(run.notDone.some((n) => n.reason.includes("coverage/lcov.info"))).toBe(true);
      expect(JSON.stringify(run.notDone)).not.toMatch(
        /agentic|aqe|coverage_analyze|sublinear|estimat/i,
      );
    });
    it("without a tool host the task is skipped with 'engine not available'", async () => {
      const run = await runEngine(createQualityEngine(), withTools(null));
      expect(coverageStatus(run)).toBe("skipped");
      expect(run.notDone.some((n) => n.reason === "engine not available")).toBe(true);
    });
    it("a throwing tool makes the task failed with the fixed note and leaks nothing", async () => {
      const h = host(sandboxDir, () => {
        throw new Error("boom /home/secret/token=abc");
      });
      const run = await runEngine(createQualityEngine(), withTools(h));
      expect(coverageStatus(run)).toBe("failed");
      expect(run.notDone.some((n) => n.reason === "检查过程中出现意外错误")).toBe(true);
      expect(JSON.stringify(run.notDone)).not.toContain("secret");
    });
    it("an unrecognisable response makes the task failed, never throws", async () => {
      for (const bad of [null, "x", { content: [{ type: "text", text: "nope" }] }]) {
        const run = await runEngine(createQualityEngine(), withTools(host(sandboxDir, () => bad)));
        expect(coverageStatus(run)).toBe("failed");
        expect(run.findings.filter((f) => f.ruleId === "quality.low-coverage")).toEqual([]);
      }
    });
    it("aborted before the call: skipped as cancelled and the tool is never called", async () => {
      const h = host(sandboxDir);
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const t = plan.tasks.find((x) => x.id === "quality.measured-coverage");
      if (!t) throw new Error("no task");
      const ac = new AbortController();
      ac.abort();
      const r = await engine.execute(t, {
        context: project,
        projectDir: sandboxDir,
        scope: [],
        userCode: { allowed: false },
        signal: ac.signal,
        tools: h,
      });
      expect(r).toMatchObject({ status: "skipped", note: "已取消" });
      expect(h.calls).toEqual([]);
    });
    it("aborted during a never-resolving call: returns promptly as cancelled", async () => {
      const ac = new AbortController();
      const never = {
        call: () => new Promise<unknown>(() => {}),
      };
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const t = plan.tasks.find((x) => x.id === "quality.measured-coverage");
      if (!t) throw new Error("no task");
      setTimeout(() => ac.abort(), 20);
      const started = Date.now();
      const r = await engine.execute(t, {
        context: project,
        projectDir: sandboxDir,
        scope: [],
        userCode: { allowed: false },
        signal: ac.signal,
        tools: never,
      });
      expect(r).toMatchObject({ status: "skipped", note: "已取消" });
      expect(Date.now() - started).toBeLessThan(1000);
    });
    it("a call that rejects after the abort causes no unhandled rejection", async () => {
      const ac = new AbortController();
      const late = {
        call: () =>
          new Promise<unknown>((_, reject) => setTimeout(() => reject(new Error("late boom")), 40)),
      };
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const t = plan.tasks.find((x) => x.id === "quality.measured-coverage");
      if (!t) throw new Error("no task");
      setTimeout(() => ac.abort(), 5);
      const r = await engine.execute(t, {
        context: project,
        projectDir: sandboxDir,
        scope: [],
        userCode: { allowed: false },
        signal: ac.signal,
        tools: late,
      });
      expect(r.status).toBe("skipped");
      await new Promise((res) => setTimeout(res, 80));
    });
    it("aborted while the tool runs: the late answer is discarded", async () => {
      const ac = new AbortController();
      const h = host(sandboxDir, () => {
        ac.abort();
        return retarget(loadResult("measured"), sandboxDir);
      });
      const engine = createQualityEngine();
      const plan = await engine.plan(project, emptyImpact());
      const t = plan.tasks.find((x) => x.id === "quality.measured-coverage");
      if (!t) throw new Error("no task");
      const r = await engine.execute(t, {
        context: project,
        projectDir: sandboxDir,
        scope: [],
        userCode: { allowed: false },
        signal: ac.signal,
        tools: h,
      });
      expect(r).toMatchObject({ status: "skipped", note: "已取消" });
    });
    it("normalize re-validates its data: hostile rows are ignored", () => {
      const engine = createQualityEngine();
      const rows = [
        null,
        5,
        { file: "../x.ts", lineCoverage: 0 },
        { file: "a.ts", lineCoverage: Number.NaN },
        { file: "b.ts", lineCoverage: 120 },
        { file: "ok.ts", lineCoverage: 3 },
      ];
      const out = engine.normalize({
        taskId: "quality.measured-coverage",
        status: "ok",
        data: { measuredCoverage: rows },
      });
      expect(out.map((f) => f.file)).toEqual(["ok.ts"]);
      for (const data of [null, {}, { measuredCoverage: "x" }, 5]) {
        expect(
          engine.normalize({ taskId: "quality.measured-coverage", status: "ok", data }),
        ).toEqual([]);
      }
    });
  });

  it("exports the fixed tool allowlist (R9)", () => {
    expect([...AQE_ALLOWED_TOOLS]).toEqual(["coverage_analyze_sublinear"]);
  });
});
