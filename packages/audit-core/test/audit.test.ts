import { describe, expect, it } from "vitest";
import {
  AuditCancelParamsSchema,
  AuditHistoryParamsSchema,
  AuditRunParamsSchema,
  AuditRunSchema,
  FINDINGS_PAGE_MAX,
  FindingDetailParamsSchema,
  FindingListParamsSchema,
  MAX_RUNS_PER_PROJECT,
  MAX_STORED_FINDINGS,
} from "../src/audit";
import { IpcErrorCodeSchema } from "../src/errors";

const running = {
  id: "r1",
  projectId: "p1",
  status: "running",
  startedAt: 1,
  finishedAt: null,
  stage: "reading",
  progress: null,
  completeness: null,
  notDone: [],
  engines: [],
  findingCount: 0,
  summary: null,
  stale: null,
  fingerprint: null,
};
const summary = {
  gate: "ready",
  counts: { must: 0, should: 0, later: 0 },
  checked: 1,
  skipped: 0,
  failed: 0,
  needed: 0,
  afterFix: "ready",
};
const reviewSummary = { ...summary, gate: "review" };
const done = {
  ...running,
  status: "completed",
  finishedAt: 2,
  stage: null,
  completeness: "complete",
  summary,
};

describe("audit params", () => {
  it("are strict: the renderer cannot smuggle userCode or any other field", () => {
    expect(AuditRunParamsSchema.safeParse({ projectId: "p" }).success).toBe(true);
    for (const extra of [{ userCode: true }, { allowed: true }, { changedFiles: ["a"] }]) {
      expect(AuditRunParamsSchema.safeParse({ projectId: "p", ...extra }).success).toBe(false);
    }
    expect(AuditRunParamsSchema.safeParse({}).success).toBe(false);
    expect(AuditRunParamsSchema.safeParse({ projectId: "" }).success).toBe(false);
    expect(AuditCancelParamsSchema.safeParse({ runId: "r", x: 1 }).success).toBe(false);
    expect(FindingListParamsSchema.safeParse({ runId: "r", x: 1 }).success).toBe(false);
    expect(FindingDetailParamsSchema.safeParse({ runId: "r" }).success).toBe(false);
    expect(FindingDetailParamsSchema.safeParse({ runId: "r", id: "f" }).success).toBe(true);
  });

  it("bounds the history limit to 1..MAX_RUNS_PER_PROJECT", () => {
    const ok = (limit: unknown) =>
      AuditHistoryParamsSchema.safeParse({ projectId: "p", limit }).success;
    expect(ok(1)).toBe(true);
    expect(ok(MAX_RUNS_PER_PROJECT)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(MAX_RUNS_PER_PROJECT + 1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(AuditHistoryParamsSchema.safeParse({ projectId: "p" }).success).toBe(true);
  });

  it("pages finding.list: offset >= 0, limit 1..FINDINGS_PAGE_MAX", () => {
    const ok = (extra: object) =>
      FindingListParamsSchema.safeParse({ runId: "r", ...extra }).success;
    expect(ok({})).toBe(true);
    expect(ok({ offset: 0, limit: FINDINGS_PAGE_MAX })).toBe(true);
    expect(ok({ offset: -1 })).toBe(false);
    expect(ok({ limit: 0 })).toBe(false);
    expect(ok({ limit: FINDINGS_PAGE_MAX + 1 })).toBe(false);
    expect(ok({ offset: 1.5 })).toBe(false);
  });

  it("keeps the documented caps", () => {
    expect(MAX_STORED_FINDINGS).toBe(2000);
    expect(MAX_RUNS_PER_PROJECT).toBe(50);
  });
});

describe("AuditRunSchema", () => {
  it("accepts a running and a finished run", () => {
    expect(AuditRunSchema.safeParse(running).success).toBe(true);
    expect(AuditRunSchema.safeParse(done).success).toBe(true);
    expect(
      AuditRunSchema.safeParse({
        ...running,
        stage: "checking",
        progress: { engine: "quality", done: 1, total: 3 },
      }).success,
    ).toBe(true);
  });

  it("rejects a finishedAt or completeness on a running run", () => {
    expect(AuditRunSchema.safeParse({ ...running, finishedAt: 2 }).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...running, completeness: "complete" }).success).toBe(false);
  });

  it("requires finishedAt and completeness on a finished run", () => {
    for (const status of ["completed", "cancelled", "failed"]) {
      expect(AuditRunSchema.safeParse({ ...done, status, finishedAt: null }).success).toBe(false);
      expect(AuditRunSchema.safeParse({ ...done, status, completeness: null }).success).toBe(false);
    }
  });

  it("never lets a cancelled or failed run claim to be complete", () => {
    for (const status of ["cancelled", "failed"]) {
      expect(AuditRunSchema.safeParse({ ...done, status }).success).toBe(false);
      expect(
        AuditRunSchema.safeParse({
          ...done,
          status,
          completeness: "partial",
          summary: reviewSummary,
        }).success,
      ).toBe(true);
    }
  });

  it("never lets a run with something not done claim to be complete", () => {
    const notDone = [{ what: "x", reason: "y" }];
    expect(AuditRunSchema.safeParse({ ...done, notDone }).success).toBe(false);
    expect(
      AuditRunSchema.safeParse({
        ...done,
        notDone,
        completeness: "partial",
        summary: reviewSummary,
      }).success,
    ).toBe(true);
  });

  it("rejects a progress that is not a real fraction", () => {
    const bad = (progress: unknown) =>
      AuditRunSchema.safeParse({ ...running, stage: "checking", progress }).success;
    expect(bad({ engine: "q", done: 4, total: 3 })).toBe(false);
    expect(bad({ engine: "q", done: -1, total: 3 })).toBe(false);
    expect(bad({ engine: "q", done: 0, total: 0 })).toBe(false);
  });

  it("is strict", () => {
    expect(AuditRunSchema.safeParse({ ...running, extra: 1 }).success).toBe(false);
  });

  it("carries a fingerprint: null or 8 lowercase hex, and never while running", () => {
    for (const fingerprint of [null, "0123abcd", "ffffffff"]) {
      expect(AuditRunSchema.safeParse({ ...done, fingerprint }).success).toBe(true);
    }
    for (const fingerprint of ["0123abc", "0123abcde", "0123ABCD", "0123abcg", "", " 0123abc"]) {
      expect(AuditRunSchema.safeParse({ ...done, fingerprint }).success).toBe(false);
    }
    expect(AuditRunSchema.safeParse({ ...running, fingerprint: null }).success).toBe(true);
    expect(AuditRunSchema.safeParse({ ...running, fingerprint: "0123abcd" }).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...done, fingerprint: undefined }).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...done, fingerprint: null, extra: 1 }).success).toBe(false);
  });

  it("has no summary or staleness while running, and always has a summary once finished", () => {
    expect(AuditRunSchema.safeParse({ ...running, summary }).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...running, stale: true }).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...done, summary: null }).success).toBe(false);
    for (const stale of [null, true, false]) {
      expect(AuditRunSchema.safeParse({ ...done, stale }).success).toBe(true);
    }
  });

  it("rejects a summary that says ready for a run that is not complete", () => {
    const partial = { ...done, completeness: "partial", notDone: [{ what: "x", reason: "y" }] };
    expect(AuditRunSchema.safeParse(partial).success).toBe(false);
    expect(AuditRunSchema.safeParse({ ...partial, summary: reviewSummary }).success).toBe(true);
  });
});

describe("error codes", () => {
  it("has a busy code for 'another audit is running'", () => {
    expect(IpcErrorCodeSchema.options).toContain("busy");
  });
});
