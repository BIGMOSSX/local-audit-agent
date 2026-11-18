import { describe, expect, it } from "vitest";
import { gatesOf, SKIPPED_GATES } from "./gates";
import { runningRun } from "./test-support/audit";

const states = (rows: ReturnType<typeof gatesOf>) => rows.map((r) => r.state);
const checking = (engine: string, done = 3, total = 8) =>
  runningRun({ stage: "checking", progress: { engine, done, total } });

describe("gates this version cannot do", () => {
  it("lists 读懂项目 (needs a model) and 试运行测试 (project code is never run), and nothing else", () => {
    expect(Object.keys(SKIPPED_GATES).sort()).toEqual(["run", "understand"]);
    expect(SKIPPED_GATES.understand).toBe("model");
    expect(SKIPPED_GATES.run).toBe("run");
  });
});

describe("gatesOf — running", () => {
  it("lists the four gates in order", () => {
    expect(gatesOf(runningRun()).map((r) => r.id)).toEqual([
      "understand",
      "run",
      "scan",
      "conclude",
    ]);
  });

  it("understand and run are skipped in every stage, with their reason, and never current or passed", () => {
    for (const run of [
      runningRun({ stage: "reading" }),
      checking("quality"),
      checking("code-intelligence"),
      runningRun({ stage: "checking", progress: null }),
      runningRun({ stage: "concluding" }),
      runningRun({ stage: null }),
    ]) {
      const rows = gatesOf(run);
      expect(rows[0]?.state).toBe("skipped");
      expect(rows[0]?.skipReason).toBe("model");
      expect(rows[1]?.state).toBe("skipped");
      expect(rows[1]?.skipReason).toBe("run");
      expect(rows[0]?.progress).toBeNull();
      expect(rows[1]?.progress).toBeNull();
    }
  });

  it("reading: scan is current without a number, nothing is claimed done", () => {
    const rows = gatesOf(runningRun({ stage: "reading" }));
    expect(states(rows)).toEqual(["skipped", "skipped", "current", "waiting"]);
    expect(rows[2]?.indeterminate).toBe(true);
  });

  it("progress of the quality engine counts toward scan, not toward 试运行测试", () => {
    const rows = gatesOf(checking("quality"));
    expect(states(rows)).toEqual(["skipped", "skipped", "current", "waiting"]);
    expect(rows[2]?.progress).toEqual({ done: 3, total: 8 });
    expect(rows[1]?.progress).toBeNull();
  });

  it("progress of the code-intelligence engine counts toward scan, not toward 读懂项目", () => {
    const rows = gatesOf(checking("code-intelligence"));
    expect(states(rows)).toEqual(["skipped", "skipped", "current", "waiting"]);
    expect(rows[2]?.progress).toEqual({ done: 3, total: 8 });
  });

  it("an unknown engine id also maps to scan", () => {
    const rows = gatesOf(checking("zzz", 1, 2));
    expect(states(rows)).toEqual(["skipped", "skipped", "current", "waiting"]);
  });

  it("checking without progress: scan is current and indeterminate (no fabricated number)", () => {
    const rows = gatesOf(runningRun({ stage: "checking", progress: null }));
    expect(states(rows)).toEqual(["skipped", "skipped", "current", "waiting"]);
    expect(rows[2]?.progress).toBeNull();
    expect(rows[2]?.indeterminate).toBe(true);
  });

  it("concluding: scan has been passed, conclude is current", () => {
    expect(states(gatesOf(runningRun({ stage: "concluding" })))).toEqual([
      "skipped",
      "skipped",
      "passed",
      "current",
    ]);
  });

  it("never reports `done` while running", () => {
    for (const stage of ["reading", "checking", "concluding", null] as const) {
      expect(states(gatesOf(runningRun({ stage }))).includes("done" as never)).toBe(false);
    }
  });
});
