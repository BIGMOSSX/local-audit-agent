import { describe, expect, it } from "vitest";
import type { AuditEngine, ProjectContext } from "../src/engine";
import type { Finding } from "../src/finding";
import { emptyImpact } from "../src/impact";
import { runEngine } from "../src/run-engine";
import {
  assertConsentRespected,
  assertEngineHealthy,
  engineContractCases,
} from "../src/testing/contract";
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

async function check(
  engine: AuditEngine,
  opts: { allowEmpty?: boolean; forbidden?: string[] } = {},
) {
  const run = await runEngine(engine, {
    context,
    impact: emptyImpact(),
    projectDir: "/sandbox/p",
    userCode: { allowed: false },
    signal: new AbortController().signal,
    tools: null,
  });
  const plan = await engine
    .plan(context, emptyImpact())
    .catch(() => ({ projectPath: "/p", tasks: [] }));
  return () =>
    assertEngineHealthy(run, plan, {
      forbiddenNames: opts.forbidden ?? ["aqe"],
      ...(opts.allowEmpty === undefined ? {} : { allowEmpty: opts.allowEmpty }),
    });
}

describe("assertEngineHealthy has teeth", () => {
  it("accepts a healthy engine, including expected consent skips", async () => {
    expect(await check(createFakeEngine({ withRunTests: true, needsNetwork: true }))).not.toThrow();
  });

  it("rejects an engine whose execute always throws", async () => {
    expect(await check(createFakeEngine({ throwIn: "execute" }))).toThrow();
  });

  it("rejects an engine whose normalize always throws", async () => {
    expect(await check(createFakeEngine({ throwIn: "normalize" }))).toThrow();
  });

  it("rejects an engine whose plan throws", async () => {
    expect(await check(createFakeEngine({ throwIn: "plan" }))).toThrow();
  });

  it("rejects an engine that emits only invalid findings", async () => {
    const base = createFakeEngine();
    const bad: AuditEngine = {
      ...base,
      normalize: (r) => base.normalize(r).map((f) => ({ ...f, id: "not-hex" })),
    };
    expect(await check(bad)).toThrow();
  });

  it("rejects an engine that silently produces nothing, unless allowEmpty", async () => {
    const empty = createFakeEngine({ applicable: false });
    expect(await check(empty)).toThrow();
    expect(await check(empty, { allowEmpty: true })).not.toThrow();
  });

  it("rejects findings owned by a different engine", async () => {
    const base = createFakeEngine();
    const bad: AuditEngine = {
      ...base,
      normalize: (r) => base.normalize(r).map((f): Finding => ({ ...f, engine: "other" })),
    };
    expect(await check(bad)).toThrow();
  });

  it("rejects forbidden names in findings, task titles and not-done entries", async () => {
    expect(await check(createFakeEngine(), { forbidden: ["fake finding"] })).toThrow();
    expect(await check(createFakeEngine(), { forbidden: ["scan"] })).toThrow();
    expect(
      await check(createFakeEngine({ withRunTests: true }), { forbidden: ["运行项目测试"] }),
    ).toThrow();
  });
});

describe("assertConsentRespected", () => {
  it("fails when a non-read-only or network task was executed without consent", async () => {
    const plan = await createFakeEngine({ withRunTests: true, needsNetwork: true }).plan(
      context,
      emptyImpact(),
    );
    expect(() => assertConsentRespected(["fake.scan"], plan)).not.toThrow();
    expect(() => assertConsentRespected(["fake.scan", "fake.run-tests"], plan)).toThrow();
    expect(() => assertConsentRespected(["fake.net"], plan)).toThrow();
  });
});

describe("engineContract has teeth", () => {
  // engineContract is `describe` + one `it` per engineContractCases() entry, so running the cases
  // directly proves what the registered suite would report.
  const failures = async (engine: AuditEngine, forbiddenNames: string[] = ["aqe"]) => {
    const failed: string[] = [];
    for (const c of engineContractCases(() => engine, { forbiddenNames })) {
      try {
        await c.run();
      } catch {
        failed.push(c.name);
      }
    }
    return failed;
  };

  it("passes every case for a healthy engine", async () => {
    expect(await failures(createFakeEngine())).toEqual([]);
  });

  it("fails the healthy case for an engine emitting a forbidden vendor name", async () => {
    const base = createFakeEngine();
    const bad: AuditEngine = {
      ...base,
      normalize: (r) => base.normalize(r).map((f) => ({ ...f, message: "Reported by AQE." })),
    };
    expect(await failures(bad)).toEqual([expect.stringContaining("is healthy")]);
  });

  it("fails the healthy case for an engine emitting findings with the wrong engine id", async () => {
    const base = createFakeEngine();
    const bad: AuditEngine = {
      ...base,
      normalize: (r) => base.normalize(r).map((f): Finding => ({ ...f, engine: "other" })),
    };
    expect(await failures(bad)).toEqual([expect.stringContaining("is healthy")]);
  });

  it("fails the id case for a non-kebab-case engine id", async () => {
    const failed = await failures(createFakeEngine({ id: "Bad_Id" }));
    expect(failed).toContain("has a kebab-case id");
  });
});
