import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);

const TOKEN = "f".repeat(64);
const fixedNow = () => new Date("2026-09-30T00:00:00.000Z");

describe("logger", () => {
  it("writes one JSON object per line with time, level and message", () => {
    const file = join(makeTmp(), "logs", "auditd.log");
    const log = createLogger({ file, secrets: [], now: fixedNow });
    log.info("hello", { n: 1 });
    log.warn("careful");
    const lines = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: "2026-09-30T00:00:00.000Z", level: "info", msg: "hello", n: 1 },
      { t: "2026-09-30T00:00:00.000Z", level: "warn", msg: "careful" },
    ]);
  });

  it.skipIf(process.platform === "win32")("creates its directories owner-only (0700)", () => {
    const root = join(makeTmp(), "data");
    createLogger({ file: join(root, "logs", "auditd.log"), secrets: [] });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "logs")).mode & 0o777).toBe(0o700);
  });

  it("never writes the session token or key-shaped secrets, wherever they appear", () => {
    const file = join(makeTmp(), "auditd.log");
    const log = createLogger({ file, secrets: [TOKEN] });
    log.info(`token ${TOKEN}`, { nested: { t: TOKEN }, key: "sk-abcdefghijklmnopqrstu" });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("sk-abcdefghijklmnop");
  });

  it("keeps Chinese paths readable", () => {
    const file = join(makeTmp(), "auditd.log");
    createLogger({ file, secrets: [] }).info("open", {
      path: "/home/robin/AI软件安全审计项目开发",
    });
    expect(readFileSync(file, "utf8")).toContain("AI软件安全审计项目开发");
  });

  it("survives values JSON cannot serialise", () => {
    const file = join(makeTmp(), "auditd.log");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const log = createLogger({ file, secrets: [] });
    expect(() => log.info("cyclic", { cyclic })).not.toThrow();
    expect(readFileSync(file, "utf8")).toContain('"msg":"cyclic"');
  });

  it("does not throw when the log location disappears after start-up", () => {
    const dir = makeTmp();
    const file = join(dir, "logs", "auditd.log");
    const log = createLogger({ file, secrets: [] });
    rmSync(join(dir, "logs"), { recursive: true, force: true });
    expect(() => log.error("still fine")).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("creates the log file with mode 0600", () => {
    const file = join(makeTmp(), "auditd.log");
    createLogger({ file, secrets: [] }).info("x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
