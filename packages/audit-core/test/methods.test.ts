import { describe, expect, it } from "vitest";
import { IPC_METHODS, isIpcMethod } from "../src/index";

describe("IPC allowlist", () => {
  it("is exactly the spec §83 list plus project.list", () => {
    expect([...IPC_METHODS]).toEqual([
      "project.open",
      "project.list",
      "project.status",
      "audit.plan",
      "audit.run",
      "audit.cancel",
      "audit.history",
      "finding.list",
      "finding.detail",
      "finding.suppress",
      "agent.chat",
      "agent.cancel",
      "tools.list",
      "tools.install",
      "tools.remove",
      "models.list",
      "models.configure",
    ]);
  });

  it.each([
    "shell.exec",
    "project.open ",
    "PROJECT.OPEN",
    "__proto__",
    "constructor",
    "",
    "project",
  ])("rejects %j", (name) => {
    expect(isIpcMethod(name)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isIpcMethod(undefined)).toBe(false);
    expect(isIpcMethod(null)).toBe(false);
    expect(isIpcMethod(42)).toBe(false);
  });

  it("accepts every listed method", () => {
    for (const m of IPC_METHODS) expect(isIpcMethod(m)).toBe(true);
  });
});
