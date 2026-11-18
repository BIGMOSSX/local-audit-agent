import type { EngineSummaryData } from "@audit/audit-core";
import { describe, expect, it } from "vitest";
import { degradationOf } from "./degradation";
import { finishedRun, MODEL_MISSING, OK_ENGINE, runningRun } from "./test-support/audit";

const SKIPPED_TASK: EngineSummaryData = {
  id: "quality",
  applicable: true,
  tasks: [
    { id: "lint", status: "ok" },
    { id: "tests", status: "skipped" },
  ],
};
const FAILED_TASK: EngineSummaryData = {
  id: "quality",
  applicable: true,
  tasks: [
    { id: "lint", status: "ok" },
    { id: "tests", status: "failed" },
  ],
};

describe("degradationOf", () => {
  it("is null for a complete run and for one still running", () => {
    expect(degradationOf(finishedRun({ engines: [OK_ENGINE] }))).toBeNull();
    expect(degradationOf(runningRun())).toBeNull();
  });

  it("names a cancelled and a failed run, and both can be rechecked", () => {
    expect(degradationOf(finishedRun({ status: "cancelled" }))).toMatchObject({
      kind: "cancelled",
      gate: "review",
    });
    expect(degradationOf(finishedRun({ status: "failed", engines: [] }))).toMatchObject({
      kind: "failed",
    });
  });

  it("says nothing ran when no check ran, whatever the not-done list says", () => {
    const run = finishedRun({ engines: [{ id: "quality", applicable: true, tasks: [] }] });
    expect(degradationOf(run)).toMatchObject({ kind: "nothing-ran", gate: "none" });
  });

  it("counts skipped and failed checks from the summary, not from text", () => {
    expect(degradationOf(finishedRun({ engines: [SKIPPED_TASK] }))).toMatchObject({
      kind: "some-skipped",
      skipped: 1,
      failed: 0,
    });
    expect(degradationOf(finishedRun({ engines: [FAILED_TASK] }))).toMatchObject({
      kind: "some-skipped",
      skipped: 0,
      failed: 1,
    });
  });

  it("is partial when everything that ran was fine but something was not done", () => {
    const run = finishedRun({ engines: [OK_ENGINE], notDone: [MODEL_MISSING] });
    expect(degradationOf(run)).toMatchObject({ kind: "partial", gate: "review" });
  });

  it("keeps a blocked gate when blockers exist in a partial run", () => {
    const run = finishedRun({ engines: [OK_ENGINE], notDone: [MODEL_MISSING] });
    const blocked = {
      ...run,
      summary: run.summary && { ...run.summary, gate: "blocked" as const },
    };
    expect(degradationOf(blocked)).toMatchObject({ kind: "partial", gate: "blocked" });
  });
});
