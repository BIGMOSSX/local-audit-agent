import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Finding } from "@audit/audit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { generateEndpoint, generateToken } from "../src/endpoint";
import type { EngineRunOptions, ServiceResult } from "../src/engine-service";
import { createHandlers } from "../src/handlers";
import type { Logger } from "../src/logger";
import { createOrchestrator } from "../src/orchestrator";
import { ProjectsRepo } from "../src/projects-repo";
import { RunsRepo } from "../src/runs-repo";
import { type IpcServer, startIpcServer } from "../src/server";
import { cleanupTmp, makeTmp } from "./helpers";
import { callOnce } from "./ipc-client";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const finding: Finding = {
  id: hex(1),
  engine: "fake",
  ruleId: "fake.rule",
  title: "t",
  severity: "low",
  confidence: "medium",
  category: "quality",
  source: "heuristic",
  message: "m",
  evidence: [],
};

let dbFile: string;
let db: ReturnType<typeof openDb>;
let projectId: string;
let release: (r: ServiceResult) => void;
let seenOpts: EngineRunOptions | undefined;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const build = () => {
  const projects = new ProjectsRepo(db, { now: () => 1, newId: () => "p-1" });
  const runs = new RunsRepo(db, { now: Date.now, newId: () => `r-${Math.random()}` });
  const orchestrator = createOrchestrator({
    projects,
    runs,
    modelConnected: true,
    stamp: async () => "stamp",
    service: {
      run: (_path, opts) =>
        new Promise((resolve) => {
          seenOpts = opts;
          release = resolve;
        }),
    },
  });
  return createHandlers({ repo: projects, orchestrator });
};
let handlers: ReturnType<typeof build>;
const call = (method: keyof typeof handlers, params?: unknown) => {
  const h = handlers[method];
  if (!h) throw new Error(`no handler for ${method}`);
  return h(params);
};
const done: ServiceResult = {
  findings: [finding],
  notDone: [],
  completeness: "complete",
  impact: {} as ServiceResult["impact"],
  engines: [],
};

beforeEach(() => {
  dbFile = join(makeTmp(), "audit.db");
  db = openDb(dbFile);
  projectId = new ProjectsRepo(db, { now: () => 1, newId: () => "p-1" }).upsert({
    path: "/work/alpha",
    name: "alpha",
    ecosystems: [],
    packageManager: null,
    isMonorepo: false,
    isGitRepo: false,
  }).id;
  handlers = build();
  seenOpts = undefined;
});
afterEach(() => {
  db.close();
  cleanupTmp();
});

describe("audit handlers", () => {
  it("stay method_not_implemented without an orchestrator, and plan/suppress always are", () => {
    const bare = createHandlers({ repo: new ProjectsRepo(db, { now: () => 1, newId: () => "x" }) });
    for (const m of [
      "audit.run",
      "audit.cancel",
      "audit.history",
      "finding.list",
      "finding.detail",
    ] as const) {
      expect(bare[m]).toBeUndefined();
    }
    expect(handlers["audit.plan"]).toBeUndefined();
    expect(handlers["finding.suppress"]).toBeUndefined();
  });

  it("audit.run returns a running run at once; history shows it; finishing makes findings readable", async () => {
    const run = (await call("audit.run", { projectId })) as { id: string; status: string };
    expect(run.status).toBe("running");
    expect((await call("audit.history", { projectId })) as { runs: unknown[] }).toMatchObject({
      runs: [{ id: run.id, status: "running" }],
    });
    await tick(); // the project is fingerprinted before the service is called
    release(done);
    await tick();
    expect(await call("finding.list", { runId: run.id })).toEqual({
      findings: [finding],
      total: 1,
      offset: 0,
    });
    expect(await call("finding.detail", { runId: run.id, id: finding.id })).toEqual(finding);
  });

  it("finding.list is paged and each page stays small even with large findings", async () => {
    const big = (n: number): Finding => ({ ...finding, id: hex(n), message: "x".repeat(2000) });
    const run = (await call("audit.run", { projectId })) as { id: string };
    await tick();
    release({ ...done, findings: Array.from({ length: 120 }, (_, i) => big(i + 1)) });
    await tick();
    const page = (await call("finding.list", { runId: run.id })) as {
      findings: unknown[];
      total: number;
      offset: number;
    };
    expect(page.total).toBe(120);
    expect(page.findings).toHaveLength(50);
    const next = (await call("finding.list", { runId: run.id, offset: 100, limit: 50 })) as {
      findings: unknown[];
    };
    expect(next.findings).toHaveLength(20);
    expect(JSON.stringify(page).length).toBeLessThan(500_000);
    await expect(call("finding.list", { runId: run.id, limit: 51 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("audit.history carries the stored summary and staleness of a finished run", async () => {
    const run = (await call("audit.run", { projectId })) as { id: string };
    await tick();
    release({
      ...done,
      engines: [{ id: "fake", applicable: true, tasks: [{ id: "fake.scan", status: "ok" }] }],
    });
    await tick();
    const { runs } = (await call("audit.history", { projectId })) as {
      runs: { id: string; summary: { gate: string; checked: number }; stale: boolean }[];
    };
    expect(runs[0]).toMatchObject({
      id: run.id,
      summary: { gate: "ready", checked: 1 },
      stale: false,
    });
  });

  it("audit.run never takes a userCode or any other extra field", async () => {
    for (const extra of [{ userCode: { allowed: true } }, { allowed: true }, { x: 1 }]) {
      await expect(call("audit.run", { projectId, ...extra })).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    await tick();
    expect(seenOpts).toBeUndefined();
  });

  it("audit.run: unknown project is not_found; a second project while busy is busy", async () => {
    await expect(call("audit.run", { projectId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await call("audit.run", { projectId });
    new ProjectsRepo(db, { now: () => 1, newId: () => "p-2" }).upsert({
      path: "/work/beta",
      name: "beta",
      ecosystems: [],
      packageManager: null,
      isMonorepo: false,
      isGitRepo: false,
    });
    await expect(call("audit.run", { projectId: "p-2" })).rejects.toMatchObject({ code: "busy" });
  });

  it("audit.cancel cancels, and an unknown run is not_found", async () => {
    const run = (await call("audit.run", { projectId })) as { id: string };
    await tick();
    seenOpts?.signal?.addEventListener("abort", () => release(done));
    expect(await call("audit.cancel", { runId: run.id })).toMatchObject({
      status: "cancelled",
      completeness: "partial",
    });
    await expect(call("audit.cancel", { runId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("history, finding.list and finding.detail reject bad params and unknown ids", async () => {
    await expect(call("audit.history", { projectId, limit: 0 })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(call("audit.history", { projectId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(call("finding.list", {})).rejects.toMatchObject({ code: "invalid_params" });
    await expect(call("finding.list", { runId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(call("finding.detail", { runId: "nope", id: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("a corrupt stored finding is a generic error over the real dispatch path", async () => {
    const run = (await call("audit.run", { projectId })) as { id: string };
    await tick();
    release(done);
    await tick();
    const other = new DatabaseSync(dbFile);
    other.exec(`UPDATE findings SET data = '{"id":"x"}'`);
    other.close();
    const logged: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (msg) => void logged.push(msg),
    };
    const token = generateToken();
    const server: IpcServer = await startIpcServer({
      endpoint: generateEndpoint(),
      token,
      handlers,
      log,
    });
    try {
      const reply = await callOnce(server.endpoint, token, "finding.list", { runId: run.id });
      expect(reply.error).toEqual({ code: "internal", message: "Internal error." });
      expect(JSON.stringify(reply)).not.toMatch(/Zod|JSON|SQLITE|invalid_type/i);
      expect(logged).toContain("handler failed");
    } finally {
      await server.close();
    }
  });
});
