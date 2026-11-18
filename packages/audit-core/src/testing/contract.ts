import { describe, expect, it } from "vitest";
import type { AuditEngine, ExecutionContext, ProjectContext } from "../engine";
import { emptyImpact } from "../impact";
import { type AuditPlan, AuditPlanSchema } from "../plan";
import {
  type EngineRun,
  NOT_DONE_NO_ISOLATION,
  NOT_DONE_NO_NETWORK,
  runEngine,
} from "../run-engine";

export interface ContractOptions {
  /** Lower-case substrings that must never appear in serialized findings (upstream product names). */
  forbiddenNames: readonly string[];
  /** Project to run against; defaults to a tiny node project. */
  context?: ProjectContext;
  projectDir?: string;
  tools?: ExecutionContext["tools"];
  /** Set only for an engine that legitimately finds nothing on `context`. Default false. */
  allowEmpty?: boolean;
}

const DEFAULT_CONTEXT: ProjectContext = {
  project: {
    path: "/p",
    name: "p",
    ecosystems: ["node"],
    packageManager: "npm",
    isMonorepo: false,
    isGitRepo: false,
  },
  rootDir: "/p",
  files: ["src/a.ts", "src/b.ts", "package.json"],
};

/**
 * Fails if a run is not that of a healthy engine: no failed task, no dropped invalid results,
 * every plan task accounted for exactly once, only the two consent-gate not-done entries, findings
 * owned by this engine, no forbidden names anywhere a user could see, and (unless `allowEmpty`) at
 * least one finding. Exported so tests can prove the gate rejects bad engines.
 */
export function assertEngineHealthy(
  run: EngineRun,
  plan: AuditPlan,
  options: Pick<ContractOptions, "forbiddenNames" | "allowEmpty">,
): void {
  expect(
    run.tasks.filter((t) => t.status === "failed"),
    "no task may fail",
  ).toEqual([]);
  const allowed = [NOT_DONE_NO_ISOLATION.what, NOT_DONE_NO_NETWORK.what];
  expect(
    run.notDone.filter((n) => !allowed.includes(n.what)),
    "only consent-gate skips may be not-done",
  ).toEqual([]);
  // A not-applicable engine (allowEmpty) legitimately runs no tasks.
  if (!(options.allowEmpty && run.tasks.length === 0)) {
    expect(run.tasks.map((t) => t.id).sort(), "one status per plan task").toEqual(
      plan.tasks.map((t) => t.id).sort(),
    );
  }
  const gated = plan.tasks.some((t) => !t.readOnly || t.networkRequired);
  if (!gated) expect(run.completeness).toBe("complete");
  for (const f of run.findings) expect(f.engine).toBe(run.engine);
  if (!options.allowEmpty)
    expect(run.findings.length, "engine produced no findings").toBeGreaterThan(0);
  const visible = JSON.stringify([
    run.findings,
    run.notDone,
    plan.tasks.map((t) => [t.id, t.kind, t.title]),
  ]).toLowerCase();
  for (const n of options.forbiddenNames) expect(visible).not.toContain(n.toLowerCase());
}

/** Fails if any executed task needed consent (non-read-only) or network, when consent was withheld. */
export function assertConsentRespected(executedTaskIds: readonly string[], plan: AuditPlan): void {
  for (const id of executedTaskIds) {
    const t = plan.tasks.find((x) => x.id === id);
    expect(t, `executed unknown task ${id}`).toBeDefined();
    expect(t?.readOnly, `task ${id} is not read-only but was executed without consent`).toBe(true);
    expect(t?.networkRequired, `task ${id} needs network but was executed`).toBe(false);
  }
}

export interface ContractCase {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

/**
 * The cases `engineContract` registers, as plain functions, so tests can run them directly against a
 * deliberately bad engine and prove the suite itself fails. Note: a `skipped` execute result must not
 * carry a note, because every note becomes a not-done entry and a healthy engine has none beyond the
 * two consent-gate entries.
 */
export function engineContractCases(
  make: () => AuditEngine,
  options: ContractOptions,
): ContractCase[] {
  const context = options.context ?? DEFAULT_CONTEXT;
  const input = (allowed: boolean) => ({
    context,
    impact: emptyImpact(),
    projectDir: options.projectDir ?? "/sandbox/p",
    userCode: { allowed },
    signal: new AbortController().signal,
    tools: options.tools ?? null,
  });
  // Delegating wrapper (not a spread: adapters may be classes) that records what execute() sees.
  const spy = (engine: AuditEngine, executed: string[]): AuditEngine => ({
    id: engine.id,
    detect: (c) => engine.detect(c),
    plan: (c, i) => engine.plan(c, i),
    execute: (t, rt) => {
      executed.push(t.id);
      return engine.execute(t, rt);
    },
    normalize: (r) => engine.normalize(r),
  });

  return [
    {
      name: "has a kebab-case id",
      run: () => {
        expect(make().id).toMatch(/^[a-z][a-z0-9-]*$/);
      },
    },
    {
      name: "plans only valid, uniquely-identified tasks owned by this engine",
      run: async () => {
        const engine = make();
        const plan = AuditPlanSchema.parse(await engine.plan(context, emptyImpact()));
        for (const t of plan.tasks) expect(t.engine).toBe(engine.id);
      },
    },
    {
      name: "is healthy: nothing failed or dropped, findings produced, no upstream names anywhere",
      run: async () => {
        const engine = make();
        const plan = AuditPlanSchema.parse(await engine.plan(context, emptyImpact()));
        assertEngineHealthy(await runEngine(engine, input(false)), plan, options);
      },
    },
    {
      name: "is deterministic: same input → same finding ids",
      run: async () => {
        const a = (await runEngine(make(), input(false))).findings.map((f) => f.id).sort();
        const b = (await runEngine(make(), input(false))).findings.map((f) => f.id).sort();
        expect(a).toEqual(b);
      },
    },
    {
      name: "without user-code consent, execute() is never invoked for a non-read-only or network task",
      run: async () => {
        const engine = make();
        const executed: string[] = [];
        const plan = AuditPlanSchema.parse(await engine.plan(context, emptyImpact()));
        const run = await runEngine(spy(engine, executed), input(false));
        assertConsentRespected(executed, plan);
        for (const t of plan.tasks.filter((x) => !x.readOnly)) {
          expect(run.tasks.find((x) => x.id === t.id)?.status).toBe("skipped");
        }
      },
    },
  ];
}

export function engineContract(
  name: string,
  make: () => AuditEngine,
  options: ContractOptions,
): void {
  describe(`engine contract: ${name}`, () => {
    for (const c of engineContractCases(make, options)) it(c.name, c.run);
  });
}
