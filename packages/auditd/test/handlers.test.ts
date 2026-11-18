import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DetectedProject } from "@audit/audit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { generateEndpoint, generateToken } from "../src/endpoint";
import { IpcError } from "../src/errors";
import { createHandlers } from "../src/handlers";
import type { Logger } from "../src/logger";
import { ProjectsRepo } from "../src/projects-repo";
import { type IpcServer, startIpcServer } from "../src/server";
import { cleanupTmp, makeTmp } from "./helpers";
import { callOnce, type Reply } from "./ipc-client";

const alpha: DetectedProject = {
  path: "/work/alpha",
  name: "alpha",
  ecosystems: ["node"],
  packageManager: "pnpm",
  isMonorepo: false,
  isGitRepo: true,
};

let dbFile: string;
let db: ReturnType<typeof openDb>;
let repo: ProjectsRepo;
let detectCalls: string[];
let detectResult: () => Promise<DetectedProject>;
let probeCalls: number;

const handlers = () =>
  createHandlers({
    repo,
    detect: async (path) => {
      detectCalls.push(path);
      return detectResult();
    },
    probeModels: async () => {
      probeCalls += 1;
      return [{ port: 4321, models: ["m1"] }];
    },
  });

beforeEach(() => {
  dbFile = join(makeTmp(), "audit.db");
  db = openDb(dbFile);
  let n = 0;
  repo = new ProjectsRepo(db, { now: () => 1000 + n, newId: () => `id-${++n}` });
  detectCalls = [];
  probeCalls = 0;
  detectResult = async () => alpha;
});
afterEach(() => {
  db.close();
  cleanupTmp();
});

const call = (
  method: "project.open" | "project.list" | "project.status" | "models.list",
  params?: unknown,
) => {
  const handler = handlers()[method];
  if (!handler) throw new Error("missing handler");
  return handler(params);
};

describe("project handlers", () => {
  it("open detects, stores and returns the project", async () => {
    const opened = await call("project.open", { path: "/anything" });
    expect(opened).toMatchObject({ id: "id-1", path: "/work/alpha", name: "alpha" });
    expect(detectCalls).toEqual(["/anything"]);
    expect(await call("project.list")).toEqual({ projects: [opened] });
  });

  it("open propagates invalid_path from detection", async () => {
    detectResult = async () => {
      throw new IpcError("invalid_path", "This folder does not exist.");
    };
    await expect(call("project.open", { path: "/gone" })).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(await call("project.list")).toEqual({ projects: [] });
  });

  it.each([undefined, {}, { path: "" }, { path: 5 }, { path: "/x", extra: 1 }, "text", null])(
    "open rejects params %j",
    async (params) => {
      await expect(call("project.open", params)).rejects.toMatchObject({ code: "invalid_params" });
    },
  );

  it("caps the invalid_params message so a client-chosen key cannot bloat the reply", async () => {
    const err = await Promise.resolve(
      call("project.open", { path: "/x", ["k".repeat(5000)]: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_params" });
    expect((err as IpcError).message.length).toBeLessThanOrEqual(200);
  });

  it("list accepts no params or an empty object, rejects anything else", async () => {
    await expect(call("project.list")).resolves.toEqual({ projects: [] });
    await expect(call("project.list", {})).resolves.toEqual({ projects: [] });
    await expect(call("project.list", { a: 1 })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("status re-detects and stores the fresh result", async () => {
    const opened = (await call("project.open", { path: "/work/alpha" })) as { id: string };
    detectResult = async () => ({ ...alpha, ecosystems: ["node", "rust"], isMonorepo: true });
    const status = await call("project.status", { id: opened.id });
    expect(status).toMatchObject({
      id: opened.id,
      ecosystems: ["node", "rust"],
      isMonorepo: true,
      pathExists: true,
    });
    expect(repo.get(opened.id)?.ecosystems).toEqual(["node", "rust"]);
  });

  it("status of a project whose folder was deleted reports pathExists:false with the stored data", async () => {
    const opened = (await call("project.open", { path: "/work/alpha" })) as { id: string };
    detectResult = async () => {
      throw new IpcError("invalid_path", "This folder does not exist.");
    };
    expect(await call("project.status", { id: opened.id })).toEqual({
      ...opened,
      pathExists: false,
    });
  });

  it("status lets unexpected detection failures surface", async () => {
    const opened = (await call("project.open", { path: "/work/alpha" })) as { id: string };
    detectResult = async () => {
      throw new Error("disk on fire");
    };
    await expect(call("project.status", { id: opened.id })).rejects.toThrow("disk on fire");
  });

  it("status of an unknown id is not_found", async () => {
    await expect(call("project.status", { id: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("status rejects a missing id", async () => {
    await expect(call("project.status", {})).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("corrupt or unreadable storage, seen through the real dispatch path", () => {
  const TOKEN = generateToken();
  const servers: IpcServer[] = [];
  let logged: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;

  beforeEach(() => {
    logged = [];
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const serve = async () => {
    const log: Logger = {
      info: (msg, fields) => void logged.push({ level: "info", msg, fields }),
      warn: (msg, fields) => void logged.push({ level: "warn", msg, fields }),
      error: (msg, fields) => void logged.push({ level: "error", msg, fields }),
    };
    const server = await startIpcServer({
      endpoint: generateEndpoint(),
      token: TOKEN,
      handlers: handlers(),
      log,
    });
    servers.push(server);
    return server.endpoint;
  };

  const corrupt = (column: string, value: string | number) => {
    const other = new DatabaseSync(dbFile);
    try {
      other.prepare(`UPDATE projects SET ${column} = ? WHERE id = 'id-1'`).run(value);
    } finally {
      other.close();
    }
  };

  const expectGeneric = (reply: Reply) => {
    expect(reply.ok).toBe(false);
    expect(reply.error).toEqual({ code: "internal", message: "Internal error." });
    expect(JSON.stringify(reply)).not.toMatch(
      /JSON|Unexpected|ZodError|invalid_type|SQLITE|sqlite|constraint|id-1/i,
    );
  };

  it.each([
    ["invalid JSON in ecosystems", "ecosystems", "{not json", /JSON/],
    ["schema-invalid ecosystems", "ecosystems", '["cobol"]', /cobol|ecosystems/],
    ["schema-invalid name", "name", "", /name/],
  ])(
    "list over the socket: corrupt row (%s) is a generic error to the client and a logged stack",
    async (_l, column, value, rawPattern) => {
      await call("project.open", { path: "/work/alpha" });
      corrupt(column, value);
      const endpoint = await serve();
      expectGeneric(await callOnce(endpoint, TOKEN, "project.list"));
      const entry = logged.find((e) => e.level === "error" && e.msg === "handler failed");
      expect(entry?.fields?.method).toBe("project.list");
      expect(String(entry?.fields?.error)).toMatch(rawPattern);
    },
  );

  it("status over the socket: corrupt stored row is a generic error", async () => {
    const opened = (await call("project.open", { path: "/work/alpha" })) as { id: string };
    corrupt("ecosystems", "{not json");
    const endpoint = await serve();
    expectGeneric(await callOnce(endpoint, TOKEN, "project.status", { id: opened.id }));
    expect(logged.some((e) => e.level === "error" && e.msg === "handler failed")).toBe(true);
  });

  it("a closed database is a generic error over the socket", async () => {
    await call("project.open", { path: "/work/alpha" });
    const endpoint = await serve();
    db.close();
    expectGeneric(await callOnce(endpoint, TOKEN, "project.list"));
    expect(logged.some((e) => e.level === "error" && e.msg === "handler failed")).toBe(true);
    db = openDb(dbFile); // so afterEach can close it
  });

  it("re-opening a project whose stored row is corrupt rewrites the row (self-heals)", async () => {
    await call("project.open", { path: "/work/alpha" });
    corrupt("ecosystems", "{not json");
    await expect(call("project.open", { path: "/work/alpha" })).resolves.toMatchObject({
      path: "/work/alpha",
    });
    expect(await call("project.list")).toMatchObject({ projects: [{ ecosystems: ["node"] }] });
  });
});

describe("models.list", () => {
  it("returns what the loopback probe found and stores nothing", async () => {
    expect(await call("models.list")).toEqual({ services: [{ port: 4321, models: ["m1"] }] });
    expect(await call("models.list", {})).toEqual({ services: [{ port: 4321, models: ["m1"] }] });
    expect(probeCalls).toBe(2);
    expect(await call("project.list")).toEqual({ projects: [] });
  });

  it.each([{ a: 1 }, "text", 5])("rejects params %j without probing", async (params) => {
    await expect(call("models.list", params)).rejects.toMatchObject({ code: "invalid_params" });
    expect(probeCalls).toBe(0);
  });
});
