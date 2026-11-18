import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disposeEndpoint, generateEndpoint, generateToken, prepareEndpoint } from "../src/endpoint";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);

const isWindows = process.platform === "win32";

describe("generateToken", () => {
  it("is 256 random bits as hex and never repeats", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateEndpoint", () => {
  it("is unique per call and touches nothing on disk", () => {
    const a = generateEndpoint();
    const b = generateEndpoint();
    expect(a).not.toBe(b);
    if (!isWindows) expect(existsSync(dirname(a))).toBe(false);
  });

  it.skipIf(isWindows)("fits in sun_path (100 bytes) and ends in d.sock", () => {
    const endpoint = generateEndpoint();
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
    expect(basename(endpoint)).toBe("d.sock");
    expect(basename(dirname(endpoint))).toMatch(/^audit-[0-9a-f]{16}$/);
  });

  it.skipIf(!isWindows)("is a named pipe on Windows", () => {
    expect(generateEndpoint()).toMatch(/^\\\\\.\\pipe\\audit-auditd-[0-9a-f]{32}$/);
  });
});

describe.skipIf(isWindows)("prepareEndpoint (POSIX)", () => {
  const base = () => realpathSync(makeTmp());

  it("creates a missing parent directory as 0700", () => {
    const endpoint = join(base(), "new-dir", "d.sock");
    prepareEndpoint(endpoint);
    expect(statSync(dirname(endpoint)).mode & 0o777).toBe(0o700);
  });

  it("accepts an existing private directory", () => {
    const dir = join(base(), "private");
    mkdirSync(dir, { mode: 0o700 });
    expect(() => prepareEndpoint(join(dir, "d.sock"))).not.toThrow();
  });

  it("refuses a directory that group or others can enter", () => {
    const dir = join(base(), "open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(() => prepareEndpoint(join(dir, "d.sock"))).toThrow(/private directory/);
  });

  it("refuses a shared directory such as the temp root itself", () => {
    expect(() => prepareEndpoint(join(tmpdir(), "d.sock"))).toThrow(/private directory/);
  });

  it("refuses a parent that is a symlink", () => {
    const root = base();
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "link"));
    expect(() => prepareEndpoint(join(root, "link", "d.sock"))).toThrow(/private directory/);
  });

  it("refuses to delete a regular file sitting at the endpoint", () => {
    const dir = join(base(), "p");
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "d.sock");
    writeFileSync(file, "precious");
    expect(() => prepareEndpoint(file)).toThrow(/not a socket/);
    expect(existsSync(file)).toBe(true);
  });

  it("removes a stale socket left behind by a killed process", async () => {
    const dir = join(base(), "stale");
    mkdirSync(dir, { mode: 0o700 });
    const sock = join(dir, "d.sock");
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(process.argv[1], () => console.log("up"))`,
      sock,
    ]);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(sock)).toBe(true);
    prepareEndpoint(sock);
    expect(existsSync(sock)).toBe(false);
  });
});

describe.skipIf(isWindows)("disposeEndpoint (POSIX)", () => {
  it("removes the socket and the empty audit-* directory", () => {
    const endpoint = generateEndpoint();
    prepareEndpoint(endpoint);
    writeFileSync(endpoint, "");
    disposeEndpoint(endpoint);
    expect(existsSync(dirname(endpoint))).toBe(false);
  });

  it("leaves a directory it did not name itself, and never throws", () => {
    const dir = mkdtempSync(join(realpathSync(makeTmp()), "mine-"));
    const file = join(dir, "d.sock");
    writeFileSync(file, "");
    disposeEndpoint(file);
    expect(existsSync(dir)).toBe(true);
    expect(() => disposeEndpoint(join(dir, "nothing-here.sock"))).not.toThrow();
  });
});
