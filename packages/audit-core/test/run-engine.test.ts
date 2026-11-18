import { describe, expect, it } from "vitest";
import type { AuditEngine, ProjectContext } from "../src/engine";
import type { Finding } from "../src/finding";
import { emptyImpact } from "../src/impact";
import { NotDoneSchema } from "../src/plan";
import { runEngine } from "../src/run-engine";
import { createFakeEngine } from "../src/testing/fake-engine";

const context: ProjectContext = {
  project: {
    path: "/p",
    name: "p",
    ecosystems: ["node"],
    packageManager: "npm",
    isMonorepo: false,
    isGitRepo: false,
  },
  rootDir: "/p",
  files: ["src/a.ts", "src/b.ts"],
};

function input(over: Partial<{ allowed: boolean; signal: AbortSignal }> = {}) {
  return {
    context,
    impact: emptyImpact(),
    projectDir: "/sandbox/p",
    userCode: { allowed: over.allowed ?? false },
    signal: over.signal ?? new AbortController().signal,
    tools: null,
  };
}

describe("runEngine", () => {
  it("returns validated findings and complete when everything ran", async () => {
    const run = await runEngine(createFakeEngine(), input());
    expect(run.findings).toHaveLength(2);
    expect(run.completeness).toBe("complete");
    expect(run.notDone).toEqual([]);
  });

  it("§16/R6: skips non-read-only tasks without consent and marks partial", async () => {
    const run = await runEngine(createFakeEngine({ withRunTests: true }), input());
    expect(run.completeness).toBe("partial");
    expect(run.notDone).toEqual([
      { what: "运行项目测试", reason: "无法在隔离环境中执行（未获用户授权或隔离机制不可用）" },
    ]);
    expect(run.tasks.find((t) => t.id === "fake.run-tests")?.status).toBe("skipped");
  });

  it("R12: skips a networkRequired task and records it as not done", async () => {
    const run = await runEngine(createFakeEngine({ needsNetwork: true }), input());
    expect(run.tasks.find((t) => t.id === "fake.net")?.status).toBe("skipped");
    expect(run.notDone).toContainEqual({ what: "需要联网的检查", reason: "未获联网授权，未执行" });
    expect(run.completeness).toBe("partial");
  });

  it("records exactly one status per task id even when normalize throws", async () => {
    const run = await runEngine(createFakeEngine({ throwIn: "normalize" }), input());
    const mine = run.tasks.filter((t) => t.id === "fake.scan");
    expect(mine).toEqual([{ id: "fake.scan", status: "failed" }]);
  });

  it("does not skip a non-read-only task when consent is given (the engine decides)", async () => {
    const run = await runEngine(createFakeEngine({ withRunTests: true }), input({ allowed: true }));
    expect(run.tasks.find((t) => t.id === "fake.run-tests")?.status).toBe("ok");
  });

  it.each(["detect", "plan", "execute", "normalize"] as const)(
    "never throws when %s throws; reports partial",
    async (stage) => {
      const run = await runEngine(createFakeEngine({ throwIn: stage }), input());
      expect(run.completeness).toBe("partial");
      expect(run.notDone.length).toBeGreaterThan(0);
    },
  );

  it("drops findings that fail the schema and says so", async () => {
    const run = await runEngine(createFakeEngine({ emitInvalid: true }), input());
    expect(run.findings.every((f) => /^[0-9a-f]{32}$/.test(f.id))).toBe(true);
    expect(run.notDone.some((n) => n.what.includes("无效结果"))).toBe(true);
  });

  it("sanitizes engine text (§102) and dedupes by id", async () => {
    const run = await runEngine(createFakeEngine({ hostileText: true, duplicate: true }), input());
    expect(run.findings).toHaveLength(1);
    const f = run.findings[0];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are stripped
    expect(f?.message).not.toMatch(/\u001b|\u0000/);
    expect(f?.message.length).toBeLessThanOrEqual(2000);
  });

  it("stops between tasks once aborted mid-run, recording every task once", async () => {
    const ac = new AbortController();
    const base = createFakeEngine({ withRunTests: true });
    const engine: AuditEngine = {
      ...base,
      execute: async (task, rt) => {
        const r = await base.execute(task, rt);
        ac.abort();
        return r;
      },
    };
    const run = await runEngine(engine, input({ allowed: true, signal: ac.signal }));
    expect(run.tasks).toEqual([
      { id: "fake.scan", status: "ok" },
      { id: "fake.run-tests", status: "skipped" },
    ]);
    expect(run.completeness).toBe("partial");
  });

  it("M3: an already-aborted signal returns immediately, partial, without calling the engine", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const base = createFakeEngine();
    const engine: AuditEngine = {
      ...base,
      detect: async (c) => {
        calls += 1;
        return base.detect(c);
      },
    };
    const run = await runEngine(engine, input({ signal: ac.signal }));
    expect(calls).toBe(0);
    expect(run.findings).toEqual([]);
    expect(run.tasks).toEqual([]);
    expect(run.completeness).toBe("partial");
    expect(run.notDone).toHaveLength(1);
    expect(run.notDone[0]?.reason).toContain("取消");
  });

  describe("hostile engine output", () => {
    const base = createFakeEngine();
    const withNormalize = (fn: (f: Finding[]) => unknown): AuditEngine => ({
      ...base,
      normalize: (r) => fn(base.normalize(r)) as Finding[],
    });

    it("I1: sanitizes verifyAfterFix entries, drops empties, omits the key when none remain", async () => {
      const long = "y".repeat(600);
      const run = await runEngine(
        withNormalize((fs) =>
          fs.map((f, i) => ({
            ...f,
            verifyAfterFix:
              i === 0
                ? ["\u001b[31mnpm test\u0000", "\u202edcba\u200b", "\u200b\u0007", long]
                : ["\u200b", "\u0000"],
          })),
        ),
        input(),
      );
      expect(run.findings).toHaveLength(2);
      const [a, b] = run.findings;
      expect(a?.verifyAfterFix?.slice(0, 2)).toEqual(["npm test", "dcba"]);
      expect(a?.verifyAfterFix).toHaveLength(3);
      expect(a?.verifyAfterFix?.[2]?.length).toBeLessThanOrEqual(500);
      expect(b).toBeDefined();
      expect(b && "verifyAfterFix" in b).toBe(false);
    });

    it("M1: sanitizes before validating, so invisible padding does not get a finding rejected", async () => {
      const run = await runEngine(
        withNormalize((fs) => fs.map((f) => ({ ...f, message: `${"\u200b".repeat(3000)}hi` }))),
        input(),
      );
      expect(run.findings).toHaveLength(2);
      expect(run.findings.every((f) => f.message === "hi")).toBe(true);
      expect(run.notDone).toEqual([]);
    });

    it("I2: not-done entries for failed results are sanitized and capped (NotDoneSchema holds)", async () => {
      const longId = "a".repeat(1000);
      const b = createFakeEngine({ id: longId });
      const engine: AuditEngine = {
        ...b,
        plan: async (c, i) => {
          const p = await b.plan(c, i);
          return {
            ...p,
            tasks: p.tasks.map((t) => ({
              ...t,
              title: `\u001b[31mS\u0000can\u202e${"t".repeat(150)}`,
            })),
          };
        },
        execute: async (t) => ({
          taskId: t.id,
          status: "failed",
          data: null,
          note: `\u001b[31m${"n".repeat(1000)}\u0000`,
        }),
      };
      const run = await runEngine(engine, input());
      expect(run.notDone.length).toBeGreaterThan(0);
      for (const n of run.notDone) {
        expect(NotDoneSchema.safeParse(n).success).toBe(true);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are stripped
        expect(`${n.what}${n.reason}`).not.toMatch(/[\u0000-\u001f\u202e]/);
      }
    });

    it("I3: a generator throwing mid-iteration yields exactly one failed entry", async () => {
      const run = await runEngine(
        withNormalize((fs) =>
          (function* () {
            yield fs[0];
            throw new Error("mid-iteration");
          })(),
        ),
        input(),
      );
      expect(run.tasks).toEqual([{ id: "fake.scan", status: "failed" }]);
      expect(run.completeness).toBe("partial");
      expect(run.findings).toEqual([]);
    });

    it.each([[5], [null], [{ length: 2 }]])(
      "I3: a non-iterable normalize result (%j) yields exactly one failed entry",
      async (bad) => {
        const run = await runEngine(
          withNormalize(() => (bad !== null && typeof bad === "object" ? { ...bad } : bad)),
          input(),
        );
        expect(run.tasks).toEqual([{ id: "fake.scan", status: "failed" }]);
        expect(run.completeness).toBe("partial");
      },
    );

    it("I3: a throwing iterator getter yields exactly one failed entry", async () => {
      const run = await runEngine(
        withNormalize(() => ({
          get [Symbol.iterator](): never {
            throw new Error("getter");
          },
        })),
        input(),
      );
      expect(run.tasks).toEqual([{ id: "fake.scan", status: "failed" }]);
    });
  });

  it("an engine that is not applicable yields nothing and stays complete", async () => {
    const run = await runEngine(createFakeEngine({ applicable: false }), input());
    expect(run.findings).toEqual([]);
    expect(run.completeness).toBe("complete");
  });
});

describe("runEngine: thrown values, duplicate ids, foreign findings", () => {
  const base = createFakeEngine();
  const withNormalize = (fn: (f: Finding[]) => Finding[]): AuditEngine => ({
    ...base,
    normalize: (r) => fn(base.normalize(r)),
  });

  it("never throws when the engine throws a null-prototype value", async () => {
    for (const stage of ["detect", "plan", "execute", "normalize"] as const) {
      const hostile = Object.create(null);
      const engine: AuditEngine = {
        ...base,
        detect: async (c) => (stage === "detect" ? Promise.reject(hostile) : base.detect(c)),
        plan: async (c, i) => (stage === "plan" ? Promise.reject(hostile) : base.plan(c, i)),
        execute: async (t, rt) => {
          if (stage === "execute") throw hostile;
          return base.execute(t, rt);
        },
        normalize: (r) => {
          if (stage === "normalize") throw hostile;
          return base.normalize(r);
        },
      };
      const run = await runEngine(engine, input());
      expect(run.completeness).toBe("partial");
      expect(run.notDone.length).toBeGreaterThan(0);
      if (stage === "execute" || stage === "normalize") {
        expect(run.tasks).toEqual([{ id: "fake.scan", status: "failed" }]);
      }
    }
  });

  it("never throws when String() of the thrown value throws", async () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    const engine: AuditEngine = {
      ...base,
      execute: async () => {
        throw hostile;
      },
    };
    const run = await runEngine(engine, input());
    expect(run.tasks).toEqual([{ id: "fake.scan", status: "failed" }]);
  });

  it("an identical duplicate id is dropped silently", async () => {
    const run = await runEngine(createFakeEngine({ duplicate: true }), input());
    expect(run.findings).toHaveLength(1);
    expect(run.notDone).toEqual([]);
    expect(run.completeness).toBe("complete");
  });

  it("same id with different content: first wins, later one is reported as not done", async () => {
    const run = await runEngine(
      withNormalize((fs) => {
        const first = fs[0] as Finding;
        return [first, { ...first, message: "Different content." }, ...fs.slice(1)];
      }),
      input(),
    );
    expect(run.findings).toHaveLength(2);
    expect(run.findings.find((f) => f.message === "Different content.")).toBeUndefined();
    expect(run.completeness).toBe("partial");
    expect(run.notDone).toHaveLength(1);
    expect(run.notDone[0]?.what).toBe("fake: 发现项编号重复，已忽略较晚的一条");
    for (const n of run.notDone) expect(NotDoneSchema.safeParse(n).success).toBe(true);
  });

  it("drops a finding whose engine differs from the running engine and says so", async () => {
    const run = await runEngine(
      withNormalize((fs) => fs.map((f, i): Finding => (i === 0 ? { ...f, engine: "other" } : f))),
      input(),
    );
    expect(run.findings).toHaveLength(1);
    expect(run.findings.every((f) => f.engine === "fake")).toBe(true);
    expect(run.completeness).toBe("partial");
    expect(run.notDone.map((n) => n.what)).toEqual(["fake: 1 条结果的引擎标识不符，已丢弃"]);
  });
});

describe("runEngine onProgress", () => {
  it("reports (0, n) after planning and once per settled task, skipped ones included", async () => {
    const calls: [number, number][] = [];
    await runEngine(createFakeEngine({ withRunTests: true }), {
      ...input(),
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("never reports when planning fails or the engine does not apply", async () => {
    const calls: unknown[] = [];
    const onProgress = (...a: unknown[]) => calls.push(a);
    await runEngine(createFakeEngine({ throwIn: "plan" }), { ...input(), onProgress });
    await runEngine(createFakeEngine({ applicable: false }), { ...input(), onProgress });
    expect(calls).toEqual([]);
  });

  it("is not broken by a throwing callback", async () => {
    const run = await runEngine(createFakeEngine(), {
      ...input(),
      onProgress: () => {
        throw new Error("boom");
      },
    });
    expect(run.findings).toHaveLength(2);
    expect(run.completeness).toBe("complete");
  });
});
