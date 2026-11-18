import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { killAllManaged, liveChildCount, runProcess, spawnManaged } from "../src/sandbox/run";
import { cleanupTmp, isProcessLive, makeTmp, minimalChildEnv } from "./helpers";

afterEach(() => {
  killAllManaged();
  cleanupTmp();
});

const child = fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url));
const base = () => ({
  command: process.execPath,
  cwd: makeTmp(),
  env: minimalChildEnv(),
  timeoutMs: 10_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
});
// Signal 0 alone also succeeds for a zombie; see isProcessLive.
const alive = (pid: number) => isProcessLive(pid);
const waitDead = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};
const isWindows = process.platform === "win32";

describe("runProcess", () => {
  it("runs with exactly the env it is given (no inheritance)", async () => {
    process.env.LEAK_CANARY = "leak";
    try {
      const r = await runProcess({ ...base(), args: [child, "env"] });
      const seen = JSON.parse(r.stdout) as Record<string, string>;
      expect(seen.LEAK_CANARY).toBeUndefined();
      expect(Object.keys(seen).map((k) => k.toUpperCase())).toContain("PATH");
    } finally {
      delete process.env.LEAK_CANARY;
    }
  });
  it("uses the given cwd", async () => {
    const opts = base();
    const r = await runProcess({ ...opts, args: [child, "cwd"] });
    expect(r.stdout.replace(/\\/g, "/").toLowerCase()).toContain(
      opts.cwd.replace(/\\/g, "/").toLowerCase().slice(-12),
    );
  });
  it("reports the exit code", async () => {
    expect((await runProcess({ ...base(), args: [child, "exit", "3"] })).exitCode).toBe(3);
  });
  it("kills on timeout and reports timedOut", async () => {
    const started = Date.now();
    const r = await runProcess({ ...base(), timeoutMs: 400, args: [child, "sleep"] });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("kills the whole process tree on timeout (grandchild does not survive)", async () => {
    const pidFile = join(makeTmp(), "gpid");
    const r = await runProcess({ ...base(), timeoutMs: 800, args: [child, "grandchild", pidFile] });
    expect(r.timedOut).toBe(true);
    const gpid = Number(readFileSync(pidFile, "utf8"));
    expect(await waitDead(gpid)).toBe(true);
  });
  // POSIX only: Windows taskkill returns before the OS finishes tearing the process down.
  it.skipIf(isWindows)(
    "done resolves only after the whole group is dead (no waiting needed)",
    async () => {
      const pidFile = join(makeTmp(), "gpid");
      const r = await runProcess({
        ...base(),
        timeoutMs: 800,
        args: [child, "grandchild", pidFile],
      });
      expect(r.timedOut).toBe(true);
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    },
  );
  // POSIX only: Node has no Job Object on Windows, so orphans of a normally-exiting parent cannot be reaped there.
  it.skipIf(isWindows)(
    "sweeps orphans left by a child that exits on its own, before done resolves",
    async () => {
      const pidFile = join(makeTmp(), "gpid");
      const r = await runProcess({ ...base(), args: [child, "orphan", pidFile] });
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    },
  );
  it("caps stdout: kills a flooding child and flags truncation", async () => {
    const r = await runProcess({ ...base(), maxStdoutBytes: 100_000, args: [child, "flood"] });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(100_000);
  });
  it("redacts secrets in stderr, including caller-supplied ones", async () => {
    const r = await runProcess({
      ...base(),
      secrets: ["custom-session-secret"],
      args: [child, "stderr", "abcd1234efgh"],
    });
    expect(r.stderr).not.toContain("abcd1234efgh");
    const r2 = await runProcess({
      ...base(),
      secrets: ["custom-session-secret"],
      args: [child, "stderr", "custom-session-secret"],
    });
    expect(r2.stderr).not.toContain("custom-session-secret");
  });
  describe("stderr cap and redaction", () => {
    const run = (text: string, extra: { secrets?: string[]; cap?: number } = {}) =>
      runProcess({
        ...base(),
        maxStderrBytes: extra.cap ?? 64,
        secrets: extra.secrets ?? [],
        args: [child, "stderr-raw", text],
      });
    const pad = "x".repeat(40);
    const longPad = "x".repeat(50); // pattern secrets start at byte 51, so the 64-byte cap cuts them mid-way
    it("a caller secret straddling the cap leaves no prefix", async () => {
      const secret = "custom-session-secret-0123456789";
      const r = await run(pad + secret, { secrets: [secret] });
      expect(r.stderr).not.toContain("custom");
      expect(r.stderr).not.toContain("secret");
      expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(64);
    });
    it("a sk- pattern secret straddling the cap leaves no prefix", async () => {
      const r = await run(`${longPad} sk-abcdefghijklmnopqrst`);
      expect(r.stderr).not.toContain("sk-");
      expect(r.stderr).not.toContain("abcdef");
    });
    it("a Bearer token straddling the cap leaves no prefix", async () => {
      const r = await run(`${longPad} Bearer abcdefghijklmnop1234`);
      expect(r.stderr).not.toContain("abcdefgh");
      expect(r.stderr).not.toContain("Bearer abc");
    });
    it("truncates by bytes without splitting a UTF-8 sequence and flags truncation", async () => {
      const r = await run("é".repeat(100), { cap: 63 });
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(63);
      expect(r.stderr).not.toContain("\uFFFD");
      expect(r.stderr).toBe("é".repeat(31));
    });
    it("does not flag truncation when stderr fits", async () => {
      const r = await run("short");
      expect(r.truncated).toBe(false);
      expect(r.stderr).toBe("short");
    });
  });
  it("feeds stdin when asked", async () => {
    const r = await runProcess({
      ...base(),
      stdin: "ping",
      args: [child, "stdin-echo"],
      timeoutMs: 1500,
    });
    expect(r.stdout).toBe("ping");
  });
  it("a command that does not exist resolves (never throws) with a null exit code", async () => {
    const r = await runProcess({ ...base(), command: join(makeTmp(), "nope"), args: [] });
    expect(r.exitCode).toBeNull();
  });
});

describe("spawn validation and failures", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "timeoutMs %s resolves as a failed spawn instead of killing at 1 ms",
    async (timeoutMs) => {
      const r = await runProcess({ ...base(), timeoutMs, args: [child, "exit", "0"] });
      expect(r.exitCode).toBeNull();
      expect(r.timedOut).toBe(false);
      expect(liveChildCount()).toBe(0);
    },
  );
  it("a huge timeoutMs is clamped, not turned into a 1 ms timer", async () => {
    const r = await runProcess({ ...base(), timeoutMs: 2 ** 40, args: [child, "exit", "0"] });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });
  it("a synchronous spawn throw (NUL in args) resolves with a null exit code and a clean registry", async () => {
    const r = await runProcess({ ...base(), args: ["a\0b"] });
    expect(r.exitCode).toBeNull();
    expect(liveChildCount()).toBe(0);
    const p = spawnManaged({ ...base(), args: ["a\0b"] });
    expect((await p.done).exitCode).toBeNull();
    expect(() => p.kill()).not.toThrow();
    expect(liveChildCount()).toBe(0);
  });
  it("a clean exit is not reported as timed out when the timer fires during the drain window", async () => {
    const pidFile = join(makeTmp(), "gpid");
    try {
      const r = await runProcess({
        ...base(),
        timeoutMs: 1000,
        args: [child, "holdpipe", pidFile],
      });
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});

describe("killAllManaged", () => {
  it("kills every live child and empties the registry", async () => {
    const p = spawnManaged({ ...base(), args: [child, "sleep"] });
    expect(liveChildCount()).toBe(1);
    const pid = p.child.pid as number;
    killAllManaged();
    expect(await waitDead(pid)).toBe(true);
    await p.done;
    expect(liveChildCount()).toBe(0);
  });
  it("kill() is safe to call repeatedly and after exit", async () => {
    const p = spawnManaged({ ...base(), args: [child, "sleep"] });
    p.kill();
    p.kill();
    await p.done;
    expect(() => {
      p.kill();
      killAllManaged();
    }).not.toThrow();
  });
  it("does not shell-interpret arguments", async () => {
    const marker = join(makeTmp(), "pwned");
    const r = await runProcess({ ...base(), args: [child, "exit", `0; touch ${marker}`] });
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).not.toBeNull();
  });
});
