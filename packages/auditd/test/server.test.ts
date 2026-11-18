import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IPC_METHODS } from "@audit/audit-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateEndpoint, generateToken } from "../src/endpoint";
import { IpcError } from "../src/errors";
import type { Logger } from "../src/logger";
import { type Handlers, type IpcServer, startIpcServer } from "../src/server";
import { callOnce, connect } from "./ipc-client";

const TOKEN = generateToken();
const isWindows = process.platform === "win32";
const open: IpcServer[] = [];

function recordingLog() {
  const entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const log: Logger = {
    info: (msg, fields) => void entries.push({ level: "info", msg, fields }),
    warn: (msg, fields) => void entries.push({ level: "warn", msg, fields }),
    error: (msg, fields) => void entries.push({ level: "error", msg, fields }),
  };
  return { log, entries };
}

async function start(
  handlers: Handlers,
  extra: { maxLineBytes?: number; firstLineTimeoutMs?: number } = {},
) {
  const rec = recordingLog();
  const server = await startIpcServer({
    endpoint: generateEndpoint(),
    token: TOKEN,
    handlers,
    log: rec.log,
    ...extra,
  });
  open.push(server);
  return { server, endpoint: server.endpoint, ...rec };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("IPC server: happy path and ordering", () => {
  it("passes params to the handler and echoes string and numeric ids", async () => {
    const { endpoint } = await start({ "project.status": (params) => ({ got: params }) });
    expect(await callOnce(endpoint, TOKEN, "project.status", { id: "p1" }, "abc")).toEqual({
      id: "abc",
      ok: true,
      result: { got: { id: "p1" } },
    });
    expect((await callOnce(endpoint, TOKEN, "project.status", undefined, 7)).id).toBe(7);
  });

  it("omits result when the handler returns undefined", async () => {
    const { endpoint } = await start({ "project.list": () => undefined });
    expect(await callOnce(endpoint, TOKEN, "project.list")).toEqual({ id: 1, ok: true });
  });

  it("answers pipelined requests in order even when the first handler is slower", async () => {
    const { endpoint } = await start({
      "project.list": async () => {
        await new Promise((r) => setTimeout(r, 60));
        return "slow";
      },
      "project.status": () => "fast",
    });
    const client = connect(endpoint);
    client.socket.write(
      `${JSON.stringify({ id: 1, token: TOKEN, method: "project.list" })}\n${JSON.stringify({ id: 2, token: TOKEN, method: "project.status" })}\n`,
    );
    expect((await client.next()).result).toBe("slow");
    expect((await client.next()).result).toBe("fast");
    client.destroy();
  });

  it("reassembles a request split across chunks, even in the middle of a multi-byte character", async () => {
    const { endpoint } = await start({ "project.open": (params) => params });
    const bytes = Buffer.from(
      `${JSON.stringify({ id: 1, token: TOKEN, method: "project.open", params: { path: "/项目/é" } })}\n`,
    );
    const cut = bytes.indexOf(Buffer.from("项")) + 1; // one byte into a 3-byte character
    const client = connect(endpoint);
    client.socket.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 30));
    client.socket.write(bytes.subarray(cut));
    expect((await client.next()).result).toEqual({ path: "/项目/é" });
    client.destroy();
  });

  it("ignores blank lines between requests", async () => {
    const { endpoint } = await start({ "project.list": () => "ok" });
    const client = connect(endpoint);
    client.socket.write(`\n\n${JSON.stringify({ id: 1, token: TOKEN, method: "project.list" })}\n`);
    expect((await client.next()).result).toBe("ok");
    client.destroy();
  });
});

describe("IPC server: authentication", () => {
  it("rejects a wrong token, never calls the handler, and closes the connection", async () => {
    let called = false;
    const { endpoint } = await start({ "project.list": () => (called = true) });
    const client = connect(endpoint);
    client.send({ id: 1, token: "0".repeat(64), method: "project.list" });
    expect(await client.next()).toEqual({
      id: 1,
      ok: false,
      error: { code: "unauthorized", message: "Invalid session token." },
    });
    await client.closed;
    expect(called).toBe(false);
  });

  it.each([
    ["no token", { id: 1, method: "project.list" }],
    ["a non-string token", { id: 1, token: 5, method: "project.list" }],
    ["an empty token", { id: 1, token: "", method: "project.list" }],
    ["a JSON array", [1, 2, 3]],
    ["a bare JSON string", '"hello"'],
  ])("treats %s as unauthorized", async (_label, payload) => {
    const { endpoint } = await start({ "project.list": () => "leak" });
    const client = connect(endpoint);
    client.send(payload);
    expect((await client.next()).error?.code).toBe("unauthorized");
    await client.closed;
  });

  it("drops requests queued behind an unauthorized one", async () => {
    let called = 0;
    const { endpoint } = await start({ "project.list": () => ++called });
    const client = connect(endpoint);
    client.socket.write(
      `${JSON.stringify({ id: 1, token: "bad", method: "project.list" })}\n${JSON.stringify({ id: 2, token: TOKEN, method: "project.list" })}\n`,
    );
    await client.closed;
    expect(called).toBe(0);
  });

  it("does not put the token in the log", async () => {
    const { endpoint, entries } = await start({ "project.list": () => "ok" });
    await callOnce(endpoint, TOKEN, "project.list");
    await callOnce(endpoint, "wrong-token-value", "project.list");
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
    expect(JSON.stringify(entries)).not.toContain("wrong-token-value");
  });
});

describe("IPC server: allowlist", () => {
  it("rejects a method outside the allowlist even if a handler is registered under that name", async () => {
    let called = false;
    const handlers = { "shell.exec": () => (called = true) } as unknown as Handlers;
    const { endpoint } = await start(handlers);
    const reply = await callOnce(endpoint, TOKEN, "shell.exec", { cmd: "id" });
    expect(reply.error?.code).toBe("method_not_allowed");
    expect(called).toBe(false);
  });

  it.each(["PROJECT.LIST", "project.list ", "__proto__", "constructor", "toString"])(
    "rejects the odd method name %j",
    async (method) => {
      const { endpoint } = await start({});
      const reply = await callOnce(endpoint, TOKEN, method);
      expect(reply.error?.code).toBe("method_not_allowed");
    },
  );

  it("treats an empty method name as a broken envelope and never calls a handler for it", async () => {
    let called = false;
    const handlers = { "": () => (called = true) } as unknown as Handlers;
    const { endpoint } = await start(handlers);
    const reply = await callOnce(endpoint, TOKEN, "");
    expect(reply.error?.code).toBe("bad_request");
    expect(called).toBe(false);
  });

  it("an allowlisted method without a handler is method_not_implemented, for every listed method", async () => {
    const { endpoint } = await start({});
    for (const method of IPC_METHODS) {
      expect((await callOnce(endpoint, TOKEN, method)).error?.code).toBe("method_not_implemented");
    }
  });
});

describe("IPC server: errors", () => {
  it("passes IpcError code and message through", async () => {
    const { endpoint } = await start({
      "project.status": () => {
        throw new IpcError("not_found", "No such project.");
      },
    });
    expect((await callOnce(endpoint, TOKEN, "project.status")).error).toEqual({
      code: "not_found",
      message: "No such project.",
    });
  });

  it("hides the text of unexpected errors from the client but logs it", async () => {
    const { endpoint, entries } = await start({
      "project.status": () => {
        throw new Error("secret detail from /etc/passwd");
      },
    });
    const reply = await callOnce(endpoint, TOKEN, "project.status");
    expect(reply.error).toEqual({ code: "internal", message: "Internal error." });
    expect(JSON.stringify(reply)).not.toContain("secret detail");
    expect(JSON.stringify(entries)).toContain("secret detail");
  });

  it("turns an unserialisable result into an internal error instead of crashing", async () => {
    const { endpoint } = await start({ "project.list": () => ({ n: 10n }) });
    expect((await callOnce(endpoint, TOKEN, "project.list")).error?.code).toBe("internal");
  });

  it("answers malformed JSON with bad_request and closes a connection that has not authenticated", async () => {
    const { endpoint } = await start({ "project.list": () => "ok" });
    const client = connect(endpoint);
    client.send("{ this is not json");
    expect((await client.next()).error?.code).toBe("bad_request");
    await client.closed;
  });

  it("keeps an authenticated connection usable after a malformed line", async () => {
    const { endpoint } = await start({ "project.list": () => "ok" });
    const client = connect(endpoint);
    client.send({ id: 1, token: TOKEN, method: "project.list" });
    expect((await client.next()).result).toBe("ok");
    client.send("{ this is not json");
    expect((await client.next()).error?.code).toBe("bad_request");
    client.send({ id: 2, token: TOKEN, method: "project.list" });
    expect((await client.next()).result).toBe("ok");
    client.destroy();
  });

  it("rejects an authenticated request with a broken envelope", async () => {
    const { endpoint } = await start({ "project.list": () => "ok" });
    const client = connect(endpoint);
    client.send({ id: 1, token: TOKEN });
    expect((await client.next()).error?.code).toBe("bad_request");
    client.send({ id: 1, token: TOKEN, method: "project.list", cwd: "/" });
    expect((await client.next()).error?.code).toBe("bad_request");
    client.destroy();
  });

  it("refuses a line over the size limit and closes", async () => {
    const { endpoint } = await start({ "project.list": () => "ok" }, { maxLineBytes: 1024 });
    const client = connect(endpoint);
    client.socket.write("x".repeat(4000));
    expect((await client.next()).error?.code).toBe("bad_request");
    await client.closed;
  });

  it("accepts a legitimate request just under the limit", async () => {
    const { endpoint } = await start(
      { "project.open": (p) => (p as { path: string }).path.length },
      { maxLineBytes: 4096 },
    );
    const reply = await callOnce(endpoint, TOKEN, "project.open", { path: "/".padEnd(3000, "a") });
    expect(reply.result).toBe(3000);
  });

  it("drops a connection that never sends a line", async () => {
    const { endpoint } = await start({}, { firstLineTimeoutMs: 150 });
    const client = connect(endpoint);
    await client.closed;
  });
});

describe("IPC server: endpoint hygiene and lifecycle", () => {
  it.skipIf(isWindows)("creates the socket as 0600 inside a 0700 directory", async () => {
    const { endpoint } = await start({});
    expect(statSync(endpoint).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(endpoint)).mode & 0o777).toBe(0o700);
  });

  it("close() drops open connections, stops listening, and removes the socket directory", async () => {
    const { server, endpoint } = await start({ "project.list": () => "ok" });
    const client = connect(endpoint);
    client.send({ id: 1, token: TOKEN, method: "project.list" });
    await client.next();
    await server.close();
    await client.closed;
    if (!isWindows) expect(existsSync(dirname(endpoint))).toBe(false);
    const late = connect(endpoint);
    await late.closed; // connection refused → socket closes without a reply
  });

  // POSIX only: the permission check is for Unix-socket directories; Windows named pipes have no
  // socket directory, so there is no equivalent scenario to exercise.
  it.skipIf(isWindows)("refuses to start in a group/world-accessible directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auditd-insecure-"));
    try {
      chmodSync(dir, 0o755);
      await expect(
        startIpcServer({
          endpoint: join(dir, "d.sock"),
          token: TOKEN,
          handlers: {},
          log: recordingLog().log,
        }),
      ).rejects.toThrow(/must be a private directory owned by the current user/);
      expect(existsSync(join(dir, "d.sock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("IPC server: connections that refuse to hang up", () => {
  it("destroys a refused connection even if the client never sends FIN, freeing its slot", async () => {
    const rec = recordingLog();
    const server = await startIpcServer({
      endpoint: generateEndpoint(),
      token: TOKEN,
      handlers: { "project.list": () => "ok" },
      log: rec.log,
      maxConnections: 1,
      firstLineTimeoutMs: 200,
    });
    open.push(server);
    const stranger = net.createConnection({ path: server.endpoint, allowHalfOpen: true });
    stranger.on("error", () => {});
    stranger.setEncoding("utf8");
    let reply = "";
    stranger.on("data", (d: string) => {
      reply += d;
    });
    // The client never half-closes, so "the server hung up" shows as 'end' (FIN received).
    const gone = new Promise<void>((resolve) => stranger.on("end", () => resolve()));
    stranger.write("garbage\n");
    await Promise.race([
      gone,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("server kept the refused connection open")), 3000),
      ),
    ]);
    try {
      expect(JSON.parse(reply.trim()).error.code).toBe("bad_request");
      // The stranger is still connected (it never sent FIN); its slot must nevertheless be free.
      expect((await callOnce(server.endpoint, TOKEN, "project.list")).result).toBe("ok");
    } finally {
      stranger.destroy();
    }
  });
});

describe("IPC server: handlers that throw odd values", () => {
  it("answers internal and keeps serving when a handler throws a null-prototype object or a string", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { endpoint, entries } = await start({
        "project.list": () => {
          throw Object.create(null);
        },
        "project.status": () => {
          throw "plain string with secret-ish text";
        },
        "project.open": () => "still alive",
      });
      const client = connect(endpoint);
      client.send({ id: 1, token: TOKEN, method: "project.list" });
      client.send({ id: 2, token: TOKEN, method: "project.status" });
      client.send({ id: 3, token: TOKEN, method: "project.open" });
      for (const id of [1, 2]) {
        const reply = await client.next();
        expect(reply.id).toBe(id);
        expect(reply.error).toEqual({ code: "internal", message: "Internal error." });
      }
      expect((await client.next()).result).toBe("still alive");
      client.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
      expect(entries.some((e) => e.level === "error")).toBe(true);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("IPC server: startup validation", () => {
  it.each([
    ["empty", ""],
    ["short", "abc123"],
    ["31 chars", "a".repeat(31)],
  ])("refuses a %s token", async (_l, token) => {
    await expect(
      startIpcServer({
        endpoint: generateEndpoint(),
        token,
        handlers: {},
        log: recordingLog().log,
      }),
    ).rejects.toThrow(/token/);
  });

  it.skipIf(isWindows)("removes the directory it created when listen fails", async () => {
    const dir = join(tmpdir(), `audit-${"f".repeat(16)}`);
    const endpoint = join(dir, `${"a".repeat(200)}.sock`); // too long for sun_path
    await expect(
      startIpcServer({ endpoint, token: TOKEN, handlers: {}, log: recordingLog().log }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
