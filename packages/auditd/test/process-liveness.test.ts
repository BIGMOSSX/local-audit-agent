import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isProcessLive } from "./helpers";

describe.skipIf(process.platform === "win32")("isProcessLive", () => {
  it("is false for a pid that does not exist", () => {
    expect(isProcessLive(2 ** 22 + 12345, () => "S")).toBe(false);
  });
  it("is true for a running process in any non-zombie state", () => {
    for (const state of ["S", "R", "S+", "Ss", "D", "T", "U", "I"])
      expect(isProcessLive(process.pid, () => state)).toBe(true);
  });
  it("is false for a zombie, with or without ps flag letters", () => {
    for (const state of ["Z", "Z+", "Zs", "Z<"])
      expect(isProcessLive(process.pid, () => state)).toBe(false);
  });
  it("is false when ps no longer lists the pid (reaped between the two probes)", () => {
    expect(isProcessLive(process.pid, () => "")).toBe(false);
  });
  it("sees a real running child as alive and the same child as dead once killed", async () => {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = c.pid as number;
    expect(isProcessLive(pid)).toBe(true);
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill("SIGKILL");
    await exited;
    expect(isProcessLive(pid)).toBe(false);
  });
});
