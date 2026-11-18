import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpPolicyError, McpServerError, mcpToolHost } from "../src/sandbox/mcp-client";
import { killAllManaged, type ManagedProcess, spawnManaged } from "../src/sandbox/run";
import { cleanupTmp, makeTmp, minimalChildEnv } from "./helpers";

afterEach(() => {
  killAllManaged();
  cleanupTmp();
});

const server = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const ALL_BUT_FORBIDDEN = [
  "echo",
  "slow",
  "huge",
  "ask_sampling",
  "noisy",
  "fail",
  "garbage",
  "nonewline",
  "die",
  "straddle",
  "multibyte",
  "idlen",
  "flood_requests",
  "stall",
  "closeout",
];

function spawnServer() {
  return spawnManaged({
    command: process.execPath,
    args: [server],
    cwd: makeTmp(),
    env: minimalChildEnv(),
    timeoutMs: 30_000,
  });
}

async function connect(
  over: Partial<{
    allowedTools: string[];
    maxMessageBytes: number;
    callTimeoutMs: number;
    handshakeTimeoutMs: number;
    secrets: string[];
  }> = {},
) {
  const proc = spawnServer();
  const client = await McpClient.connect(proc, {
    allowedTools: over.allowedTools ?? ALL_BUT_FORBIDDEN,
    maxMessageBytes: over.maxMessageBytes ?? 1024 * 1024,
    callTimeoutMs: over.callTimeoutMs ?? 5000,
    ...(over.handshakeTimeoutMs ? { handshakeTimeoutMs: over.handshakeTimeoutMs } : {}),
    ...(over.secrets ? { secrets: over.secrets } : {}),
  });
  return { client, proc };
}

/** stderr and stdout are separate pipes: wait for the drained stderr to reach the state under test. */
const tailWhen = (client: McpClient, ready: (tail: string) => boolean): Promise<string> =>
  vi.waitFor(
    () => {
      const tail = client.stderrTail();
      if (!ready(tail)) throw new Error("stderr not drained yet");
      return tail;
    },
    { timeout: 5000, interval: 10 },
  );

const textOf = (r: unknown): string =>
  (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("McpClient", () => {
  it("initializes and lists tools", async () => {
    const { client } = await connect();
    expect(await client.listTools()).toContain("echo");
  });
  it("calls an allowlisted tool and returns the raw result", async () => {
    const { client } = await connect();
    expect(await client.callTool("echo", { a: 1 })).toEqual({
      content: [{ type: "text", text: '{"a":1}' }],
    });
  });
  it("refuses a non-allowlisted tool BEFORE sending anything to the server", async () => {
    const { client, proc } = await connect();
    // The client is the only writer to the child's stdin: no write call means nothing was sent.
    const write = vi.spyOn(proc.child.stdin as NodeJS.WritableStream, "write");
    await expect(client.callTool("forbidden", {})).rejects.toBeInstanceOf(McpPolicyError);
    expect(write).not.toHaveBeenCalled();
    // A permitted call does write, so the spy is live.
    await client.callTool("echo", {});
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("drains stderr: a server that writes >64 KiB to stderr before replying does not block", async () => {
    const { client } = await connect({ callTimeoutMs: 5000 });
    const result = (await client.callTool("noisy", {})) as { content: { text: string }[] };
    expect(result.content[0]?.text).toBe("done");
  });
  it("keeps only a capped tail of stderr and redacts secrets in it", async () => {
    const { client } = await connect();
    await client.callTool("noisy", {});
    const tail = await tailWhen(client, (t) => t.includes("last line"));
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail).not.toContain("abcd1234efgh");
  });
  it("redacts a caller secret that straddles the tail boundary before cutting", async () => {
    const secret = "ZQXJ-7734-WVUT-9981";
    // The final 64 KiB of the redacted text would start inside the raw secret if the cut came first.
    const { client } = await connect({ secrets: [secret] });
    await client.callTool("straddle", { pre: 5000, secret, post: 64 * 1024 - 5 });
    const tail = await tailWhen(
      client,
      (t) => t.endsWith("q") && Buffer.byteLength(t, "utf8") >= 64 * 1024,
    );
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64 * 1024);
    for (const frag of ["ZQXJ", "7734", "WVUT", "9981"]) expect(tail).not.toContain(frag);
  });
  it("cuts the stderr tail by bytes without splitting a UTF-8 sequence", async () => {
    const { client } = await connect();
    await client.callTool("multibyte", { count: 80_000 });
    // stderr is a separate pipe from the reply: wait for it to fill the window (a full tail is >= 64 KiB - 3).
    const tail = await tailWhen(client, (t) => Buffer.byteLength(t, "utf8") >= 64 * 1024 - 3);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(tail).not.toContain("\ufffd");
  });
  it("answers a server-initiated sampling request with an error and counts it", async () => {
    const { client } = await connect();
    const result = (await client.callTool("ask_sampling", {})) as { content: { text: string }[] };
    const echoed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(echoed.error.code).toBe(-32601);
    expect(client.refusedRequests).toBe(1);
  });
  it("times out a call that never answers, without wedging later calls", async () => {
    // The handshake budget covers a cold node start (slow under a real-time virus scanner on
    // Windows); only the call budget is tight.
    const { client } = await connect({ callTimeoutMs: 300, handshakeTimeoutMs: 20_000 });
    await expect(client.callTool("slow", {})).rejects.toThrow(/timed out/i);
    expect(await client.callTool("echo", { ok: true })).toBeDefined();
  });
  it("cuts a handshake that never completes at handshakeTimeoutMs, not at callTimeoutMs", async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: [server],
      cwd: makeTmp(),
      env: { ...minimalChildEnv(), FAKE_MCP_NO_INIT: "1" },
      timeoutMs: 30_000,
    });
    const started = Date.now();
    await expect(
      McpClient.connect(proc, {
        allowedTools: ["echo"],
        maxMessageBytes: 1024 * 1024,
        callTimeoutMs: 60_000,
        handshakeTimeoutMs: 700,
      }),
    ).rejects.toThrow(/initialize timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await proc.done;
  });
  it("kills the server and rejects when a message exceeds the size cap", async () => {
    const { client, proc } = await connect({ maxMessageBytes: 64 * 1024 });
    await expect(client.callTool("huge", {})).rejects.toThrow(/too large/i);
    await proc.done;
  });
  it("caps an unterminated line before any newline arrives", async () => {
    const { client, proc } = await connect({ maxMessageBytes: 64 * 1024 });
    await expect(client.callTool("nonewline", {})).rejects.toThrow(/too large/i);
    await proc.done;
    await expect(client.callTool("echo", {})).rejects.toThrow();
  });
  it("rejects pending calls when the server dies", async () => {
    const { client, proc } = await connect();
    const pending = client.callTool("slow", {});
    proc.kill();
    await expect(pending).rejects.toThrow();
  });
  it("rejects a pending call when the server exits on its own", async () => {
    const { client } = await connect();
    await expect(client.callTool("die", {})).rejects.toThrow(/stopped/i);
  });
  it("rejects cleanly (no crash) when calling a server that already died", async () => {
    const { client, proc } = await connect();
    proc.kill();
    // Immediately, before the exit is observed: the write may hit a dead pipe (EPIPE).
    await expect(client.callTool("echo", { a: 1 })).rejects.toThrow();
    await proc.done;
    await expect(client.callTool("echo", { a: 1 })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
  });
  it("surfaces a JSON-RPC error response as a rejection", async () => {
    const { client } = await connect();
    const err = await client.callTool("fail", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerError);
    expect((err as McpServerError).untrusted).toBe(true);
    expect((err as McpServerError).message).toBe("boom");
    expect(await client.callTool("echo", { ok: 1 })).toBeDefined();
  });
  it("truncates a long server error message without splitting a surrogate pair", async () => {
    const { client } = await connect();
    // Unit 999 is the high half of a pair, so a plain slice(0, 1000) would leave a lone surrogate.
    const message = `a${"\u{1F600}".repeat(600)}`;
    const err = (await client.callTool("fail", { message }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(McpServerError);
    expect(err.message.length).toBeLessThanOrEqual(1000);
    expect(err.message).not.toMatch(/[\ud800-\udbff]$/);
    expect(err.message.startsWith("a\u{1F600}")).toBe(true);
  });
  it("echoes a short string request id but answers an oversized one with a null id", async () => {
    const { client } = await connect();
    const ok = JSON.parse(textOf(await client.callTool("idlen", { len: 128 })));
    expect(ok.id).toBe("i".repeat(128));
    const big = JSON.parse(textOf(await client.callTool("idlen", { len: 129 })));
    expect(big.id).toBeNull();
    expect(big.error.code).toBe(-32601);
  });
  it("shuts down when a server that stopped reading floods requests with huge ids", async () => {
    const { client, proc } = await connect({ maxMessageBytes: 1024 * 1024 });
    const err = await client
      .callTool("flood_requests", { count: 500, idChars: 100_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpPolicyError);
    expect((err as Error).message).toMatch(/too many requests/);
    expect(client.refusedRequests).toBe(101);
    // Every oversized id is refused with a null id. Had any been echoed (>= 100 KB each) the client
    // would have written megabytes; the handshake, the call and 101 short refusals fit in a few KB.
    // (bytesWritten counts queued and flushed bytes alike, unlike writableLength, which is vacuous
    // once the stream is destroyed.)
    const written = (proc.child.stdin as unknown as { bytesWritten: number }).bytesWritten;
    expect(written).toBeGreaterThan(101 * 40);
    expect(written).toBeLessThan(32 * 1024);
    await proc.done;
    await expect(client.callTool("echo", {})).rejects.toThrow();
  });
  describe("a server that dribbles a line one byte at a time", () => {
    // COUPLING: reaches into McpClient's private members (`onData`, `nextId`, `partialBuf`). The buffer
    // growth and the one-byte feed cannot be observed through the public API (a real child's chunking
    // is up to the OS). If McpClient is refactored, update these names; the tests then still say what
    // they must: a dribbled line is parsed and its memory stays within 2x the message cap.
    type Inner = { onData(chunk: Buffer): void; nextId: number; partialBuf: Buffer };
    const inner = (c: McpClient) => c as unknown as Inner;

    it("still gets its reply parsed, with one growable buffer instead of one object per byte", async () => {
      const { client } = await connect({ callTimeoutMs: 20_000 });
      const pending = client.callTool("slow", {});
      const id = inner(client).nextId - 1;
      const payload = "p".repeat(200_000);
      const line = Buffer.from(
        `${JSON.stringify({ jsonrpc: "2.0", id, result: { payload } })}\n`,
        "utf8",
      );
      const started = Date.now();
      for (let i = 0; i < line.length; i++) inner(client).onData(line.subarray(i, i + 1));
      expect(await pending).toEqual({ payload });
      expect(Date.now() - started).toBeLessThan(5000);
    });
    it("keeps the buffered bytes within twice the message cap, then rejects an endless line", async () => {
      const cap = 64 * 1024;
      const { client, proc } = await connect({ maxMessageBytes: cap });
      const pending = client.callTool("slow", {}).catch((e: unknown) => e);
      const one = Buffer.from("a");
      for (let i = 0; i < cap; i++) inner(client).onData(one);
      expect(inner(client).partialBuf.length).toBeLessThanOrEqual(2 * cap);
      inner(client).onData(one); // one byte past the cap, still no newline
      expect(((await pending) as Error).message).toMatch(/too large/i);
      expect(inner(client).partialBuf.length).toBe(0);
      await proc.done;
    });
  });
  it("shuts down after more than 100 small server requests", async () => {
    const { client, proc } = await connect();
    const err = await client
      .callTool("flood_requests", { count: 150, idChars: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpPolicyError);
    expect(client.refusedRequests).toBe(101);
    await proc.done;
  });
  it("shuts down when the child stops reading its stdin and the write queue grows", async () => {
    const { client, proc } = await connect({ maxMessageBytes: 4 * 1024 * 1024 });
    await client.callTool("stall", {});
    const pad = "x".repeat(2 * 1024 * 1024);
    const calls = [1, 2].map((i) => client.callTool("echo", { pad, i }).catch((e: unknown) => e));
    for (const e of await Promise.all(calls)) {
      expect(e).toBeInstanceOf(McpPolicyError);
      expect((e as Error).message).toMatch(/stopped reading/);
    }
    // The queue stopped at the two messages that tripped the cap, and the stream was torn down.
    expect(proc.child.stdin?.destroyed).toBe(true);
    expect(proc.child.stdin?.writableLength ?? 0).toBeLessThanOrEqual(2 * (pad.length + 1024));
    await proc.done;
    await expect(client.callTool("echo", {})).rejects.toThrow();
  });
  // libuv never closes stdio fds 0-2 on Windows (uv_fs_close and the stream close both skip them), so a real
  // child cannot close its own stdout there while staying alive. The same client behaviour is covered on every
  // OS, Windows included, by the fake-process test below.
  it.skipIf(process.platform === "win32")(
    "rejects pending calls at once when the server closes stdout but keeps running",
    async () => {
      const { client, proc } = await connect({ callTimeoutMs: 20_000 });
      await expect(client.callTool("closeout", {})).rejects.toThrow(/stopped/i);
      await proc.done; // the client killed the still-running child
    },
  );
  it("rejects pending calls at once, and kills the child, when its stdout ends while it is still running", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdin,
      stderr,
    }) as unknown as ChildProcess;
    const kill = vi.fn();
    // `done` never settles: the process is still running as far as the client can tell.
    const proc: ManagedProcess = { child, done: new Promise(() => undefined), kill };
    // Answer `initialize` like a server would, then stay silent.
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string };
        if (msg.method === "initialize")
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      }
    });
    const client = await McpClient.connect(proc, {
      allowedTools: ["closeout"],
      maxMessageBytes: 1024 * 1024,
      callTimeoutMs: 20_000,
    });
    const pending = client.callTool("closeout", {});
    stdout.end(); // the server closes its output; no exit, no error
    await expect(pending).rejects.toThrow(/stopped/i);
    expect(kill).toHaveBeenCalled();
    await expect(client.callTool("closeout", {})).rejects.toThrow();
  });
  it("ignores malformed lines, non-object JSON, unknown ids, notifications and duplicate replies", async () => {
    const { client } = await connect();
    expect(textOf(await client.callTool("garbage", {}))).toBe("first");
    // A hostile id object is refused with a null id, never executed or echoed back as an object.
    expect(client.refusedRequests).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(textOf(await client.callTool("echo", { still: "ok" }))).toBe('{"still":"ok"}');
  });
  it("rejects (does not throw out of the call) when args cannot be serialised", async () => {
    const { client } = await connect();
    await expect(client.callTool("echo", { n: 1n as unknown as number })).rejects.toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    await expect(client.callTool("echo", cyc)).rejects.toThrow();
    expect(await client.callTool("echo", { ok: true })).toBeDefined();
  });
  it("close() is idempotent, rejects pending calls, kills the child and blocks later calls", async () => {
    const { client, proc } = await connect();
    const pending = client.callTool("slow", {});
    client.close();
    client.close();
    await expect(pending).rejects.toThrow();
    await proc.done;
    await expect(client.callTool("echo", {})).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
  });
  it("clamps a huge callTimeoutMs instead of firing immediately", async () => {
    const { client } = await connect({ callTimeoutMs: 1e12 });
    expect(await client.callTool("echo", { ok: true })).toBeDefined();
  });
  it.each([
    ["maxMessageBytes 0", { maxMessageBytes: 0 }],
    ["maxMessageBytes NaN", { maxMessageBytes: Number.NaN }],
    ["maxMessageBytes Infinity", { maxMessageBytes: Number.POSITIVE_INFINITY }],
    ["callTimeoutMs -1", { callTimeoutMs: -1 }],
    ["callTimeoutMs NaN", { callTimeoutMs: Number.NaN }],
    ["callTimeoutMs Infinity", { callTimeoutMs: Number.POSITIVE_INFINITY }],
    ["handshakeTimeoutMs 0", { handshakeTimeoutMs: 0 }],
    ["handshakeTimeoutMs NaN", { handshakeTimeoutMs: Number.NaN }],
    ["handshakeTimeoutMs Infinity", { handshakeTimeoutMs: Number.POSITIVE_INFINITY }],
  ])("rejects invalid options (%s) and kills the child", async (_label, over) => {
    const proc = spawnServer();
    await expect(
      McpClient.connect(proc, {
        allowedTools: ["echo"],
        maxMessageBytes: 1024,
        callTimeoutMs: 1000,
        ...over,
      }),
    ).rejects.toThrow(/maxMessageBytes|callTimeoutMs|handshakeTimeoutMs/);
    await proc.done;
  });
  it("fails connect and kills the child when the process never started", async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: [server],
      cwd: makeTmp(),
      env: minimalChildEnv(),
      timeoutMs: 0, // spawnManaged returns a never-started process
    });
    await expect(
      McpClient.connect(proc, { allowedTools: [], maxMessageBytes: 1024, callTimeoutMs: 500 }),
    ).rejects.toThrow();
  });
  it("mcpToolHost forwards to callTool and inherits the allowlist", async () => {
    const { client } = await connect();
    const host = mcpToolHost(client);
    expect(await host.call("echo", { z: 1 })).toBeDefined();
    await expect(host.call("forbidden", {})).rejects.toBeInstanceOf(McpPolicyError);
  });
});
