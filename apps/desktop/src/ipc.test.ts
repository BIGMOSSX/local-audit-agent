import type { AuditRun, Finding, Project } from "@audit/audit-core";
import { describe, expect, it, vi } from "vitest";
import {
  createAuditClient,
  createModelClient,
  createProjectClient,
  IpcCallError,
  toCallError,
} from "./ipc";

const project: Project = {
  id: "p1",
  path: "/work/alpha",
  name: "alpha",
  ecosystems: ["node"],
  packageManager: "pnpm",
  isMonorepo: false,
  isGitRepo: true,
  addedAt: 1,
  lastOpenedAt: 2,
};

describe("createProjectClient", () => {
  it("list calls project.list and returns the projects", async () => {
    const transport = vi.fn().mockResolvedValue({ projects: [project] });
    expect(await createProjectClient(transport).list()).toEqual([project]);
    expect(transport).toHaveBeenCalledWith("project.list", {});
  });

  it("open calls project.open with the path and returns the project", async () => {
    const transport = vi.fn().mockResolvedValue(project);
    expect(await createProjectClient(transport).open("/work/alpha")).toEqual(project);
    expect(transport).toHaveBeenCalledWith("project.open", { path: "/work/alpha" });
  });

  it("passes a Unicode path through untouched", async () => {
    const transport = vi.fn().mockResolvedValue(project);
    await createProjectClient(transport).open("/work/AI软件安全审计项目开发 (副本)");
    expect(transport).toHaveBeenCalledWith("project.open", {
      path: "/work/AI软件安全审计项目开发 (副本)",
    });
  });

  it.each([null, {}, { projects: "no" }, { projects: [{ id: "x" }] }, "text"])(
    "a malformed list reply %j becomes sidecar_protocol",
    async (reply) => {
      const client = createProjectClient(vi.fn().mockResolvedValue(reply));
      await expect(client.list()).rejects.toMatchObject({ code: "sidecar_protocol" });
    },
  );

  it("a malformed open reply becomes sidecar_protocol", async () => {
    const client = createProjectClient(vi.fn().mockResolvedValue({ id: "x" }));
    await expect(client.open("/a")).rejects.toMatchObject({ code: "sidecar_protocol" });
  });

  it("errors from the transport propagate unchanged", async () => {
    const boom = new IpcCallError("invalid_path", "This folder does not exist.");
    const client = createProjectClient(vi.fn().mockRejectedValue(boom));
    await expect(client.open("/nope")).rejects.toBe(boom);
  });
});

describe("toCallError", () => {
  it("keeps a known code and message from the shell", () => {
    const err = toCallError({ code: "invalid_path", message: "This folder does not exist." });
    expect(err).toBeInstanceOf(IpcCallError);
    expect(err).toMatchObject({ code: "invalid_path", message: "This folder does not exist." });
  });

  it("keeps shell-side codes", () => {
    expect(toCallError({ code: "sidecar_unavailable", message: "x" }).code).toBe(
      "sidecar_unavailable",
    );
  });

  it("maps an unknown code to internal but keeps the message", () => {
    expect(toCallError({ code: "brand_new_code", message: "hi" })).toMatchObject({
      code: "internal",
      message: "hi",
    });
  });

  it.each([
    ["a string", "plain failure"],
    ["an Error", new Error("plain failure")],
    ["an object without a message", { code: "internal" }],
    ["null", null],
    ["undefined", undefined],
  ])("turns %s into internal", (_name, raw) => {
    expect(toCallError(raw).code).toBe("internal");
  });

  it("returns an IpcCallError untouched", () => {
    const original = new IpcCallError("not_found", "x");
    expect(toCallError(original)).toBe(original);
  });
});

describe("createModelClient", () => {
  it("list calls models.list with empty params and returns the services", async () => {
    const services = [{ port: 4321, models: ["m1", "m2"] }];
    const transport = vi.fn().mockResolvedValue({ services });
    expect(await createModelClient(transport).list()).toEqual(services);
    expect(transport).toHaveBeenCalledWith("models.list", {});
  });

  it.each([
    null,
    {},
    { services: "no" },
    { services: [{ port: 0, models: [] }] },
    { services: [{ port: 80, models: [1] }] },
    { services: [{ port: 80, models: [], extra: 1 }] },
    "text",
  ])("a malformed reply %j becomes sidecar_protocol", async (reply) => {
    const transport = vi.fn().mockResolvedValue(reply);
    await expect(createModelClient(transport).list()).rejects.toMatchObject({
      code: "sidecar_protocol",
    });
  });
});

const summary = {
  gate: "review",
  counts: { must: 0, should: 0, later: 0 },
  checked: 1,
  skipped: 0,
  failed: 0,
  needed: 0,
  afterFix: "review",
};
const finishedRun: AuditRun = {
  id: "r1",
  projectId: "p1",
  status: "completed",
  startedAt: 1,
  finishedAt: 2,
  stage: null,
  progress: null,
  completeness: "partial",
  notDone: [{ what: "检查", reason: "没有任何检查实际运行" }],
  engines: [],
  findingCount: 0,
  summary: summary as AuditRun["summary"],
  stale: false,
  fingerprint: "0a1b2c3d",
};
const finding = (n: number): Finding => ({
  id: n.toString(16).padStart(32, "0"),
  engine: "quality",
  ruleId: "r.test",
  title: `t${n}`,
  severity: "medium",
  confidence: "high",
  category: "quality",
  source: "static-analysis",
  message: "m",
  evidence: [],
});

describe("createAuditClient", () => {
  it("run sends audit.run with only the project id", async () => {
    const transport = vi.fn().mockResolvedValue(finishedRun);
    expect(await createAuditClient(transport).run("p1")).toEqual(finishedRun);
    expect(transport).toHaveBeenCalledWith("audit.run", { projectId: "p1" });
  });

  it("cancel sends audit.cancel with only the run id", async () => {
    const transport = vi.fn().mockResolvedValue(finishedRun);
    await createAuditClient(transport).cancel("r1");
    expect(transport).toHaveBeenCalledWith("audit.cancel", { runId: "r1" });
  });

  it("history sends exactly projectId and limit and returns the runs", async () => {
    const transport = vi.fn().mockResolvedValue({ runs: [finishedRun] });
    expect(await createAuditClient(transport).history("p1", 1)).toEqual([finishedRun]);
    expect(transport).toHaveBeenCalledWith("audit.history", { projectId: "p1", limit: 1 });
  });

  it("findings pages finding.list 50 at a time until the total is reached", async () => {
    const all = Array.from({ length: 120 }, (_, i) => finding(i + 1));
    const transport = vi.fn(async (_m: string, params?: unknown) => {
      const { offset } = params as { runId: string; offset: number; limit: number };
      return { findings: all.slice(offset, offset + 50), total: 120, offset };
    });
    const out = await createAuditClient(transport).findings("r1");
    expect(out).toHaveLength(120);
    expect(transport.mock.calls.map((c) => (c[1] as { offset: number }).offset)).toEqual([
      0, 50, 100,
    ]);
    expect(transport).toHaveBeenCalledWith("finding.list", { runId: "r1", offset: 0, limit: 50 });
  });

  it("findings stops at once when a page comes back empty", async () => {
    const transport = vi.fn().mockResolvedValue({ findings: [], total: 500, offset: 0 });
    expect(await createAuditClient(transport).findings("r1")).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("findings never asks for more than 40 pages", async () => {
    const transport = vi.fn(async (_m: string, params?: unknown) => {
      const { offset } = params as { offset: number };
      return {
        findings: Array.from({ length: 50 }, (_, i) => finding(offset + i + 1)),
        total: 100000,
        offset,
      };
    });
    const out = await createAuditClient(transport).findings("r1");
    expect(transport).toHaveBeenCalledTimes(40);
    expect(out).toHaveLength(2000);
  });

  it.each([
    ["run", (c: ReturnType<typeof createAuditClient>) => c.run("p1"), { ...finishedRun, extra: 1 }],
    ["run", (c: ReturnType<typeof createAuditClient>) => c.run("p1"), { id: "x" }],
    [
      "cancel",
      (c: ReturnType<typeof createAuditClient>) => c.cancel("r1"),
      { ...finishedRun, status: "weird" },
    ],
    ["history", (c: ReturnType<typeof createAuditClient>) => c.history("p1", 1), { runs: "no" }],
    [
      "findings",
      (c: ReturnType<typeof createAuditClient>) => c.findings("r1"),
      { findings: [{ id: "x" }], total: 1, offset: 0 },
    ],
  ])("a malformed %s reply becomes sidecar_protocol", async (_name, call, reply) => {
    const client = createAuditClient(vi.fn().mockResolvedValue(reply));
    await expect(call(client)).rejects.toMatchObject({ code: "sidecar_protocol" });
  });

  it("a transport error such as busy propagates with its code", async () => {
    const boom = new IpcCallError("busy", "Another audit is already running.");
    const client = createAuditClient(vi.fn().mockRejectedValue(boom));
    await expect(client.run("p2")).rejects.toMatchObject({ code: "busy" });
  });
});
