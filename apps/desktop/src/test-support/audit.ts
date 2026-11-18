import {
  type AuditRun,
  type EngineSummaryData,
  type Finding,
  type NotDone,
  type Project,
  summarize,
} from "@audit/audit-core";
import { vi } from "vitest";
import type { AuditClient } from "../ipc";

export function makeProject(id: string, name: string, over: Partial<Project> = {}): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    ecosystems: [],
    packageManager: null,
    isMonorepo: false,
    isGitRepo: false,
    addedAt: 1,
    lastOpenedAt: 1,
    ...over,
  };
}

let counter = 0;
export function makeFinding(over: Partial<Finding> = {}): Finding {
  counter += 1;
  return {
    id: counter.toString(16).padStart(32, "0"),
    engine: "quality",
    ruleId: "quality.example",
    title: `问题 ${counter}`,
    severity: "medium",
    confidence: "high",
    category: "quality",
    source: "static-analysis",
    file: "src/app.ts",
    line: 12,
    message: "说明文字",
    evidence: [],
    ...over,
  };
}

export const OK_ENGINE: EngineSummaryData = {
  id: "quality",
  applicable: true,
  tasks: [{ id: "lint", status: "ok" }],
};

export const MODEL_MISSING: NotDone = {
  what: "读懂项目、生成测试、安全深度分析",
  reason: "需要连接 AI 模型",
};

export function runningRun(over: Partial<AuditRun> = {}): AuditRun {
  return {
    id: "run-1",
    projectId: "p1",
    status: "running",
    startedAt: 1_700_000_000_000,
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
    ...over,
  };
}

interface FinishedOptions {
  id?: string;
  projectId?: string;
  status?: "completed" | "cancelled" | "failed";
  completeness?: "complete" | "partial";
  notDone?: NotDone[];
  engines?: EngineSummaryData[];
  findings?: Finding[];
  stale?: boolean | null;
  /** 8 lowercase hex, or null for a run that has no stored stamp. */
  fingerprint?: string | null;
  finishedAt?: number;
}

/** A finished run whose summary is computed by the real `summarize`, so tests cannot drift from it. */
export function finishedRun(o: FinishedOptions = {}): AuditRun {
  const status = o.status ?? "completed";
  const notDone = o.notDone ?? [];
  const completeness =
    o.completeness ?? (notDone.length > 0 || status !== "completed" ? "partial" : "complete");
  const engines = o.engines ?? [OK_ENGINE];
  const findings = o.findings ?? [];
  return {
    id: o.id ?? "run-1",
    projectId: o.projectId ?? "p1",
    status,
    startedAt: 1_700_000_000_000,
    finishedAt: o.finishedAt ?? 1_700_000_060_000,
    stage: null,
    progress: null,
    completeness,
    notDone,
    engines,
    findingCount: findings.length,
    summary: summarize({ status, completeness, notDone, engines, findings }),
    stale: o.stale ?? null,
    fingerprint: o.fingerprint === undefined ? "0a1b2c3d" : o.fingerprint,
  };
}

export type FakeAudit = AuditClient & {
  run: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  findings: ReturnType<typeof vi.fn>;
};

export function fakeAudit(over: Partial<AuditClient> = {}): FakeAudit {
  return {
    run: vi.fn(async () => runningRun()),
    cancel: vi.fn(async () => finishedRun({ status: "cancelled" })),
    history: vi.fn(async () => []),
    findings: vi.fn(async () => []),
    ...over,
  } as FakeAudit;
}
