import { describe, expect, it } from "vitest";
import type { EngineSummaryData } from "../src/audit";
import type { Finding } from "../src/finding";
import { bucketOf, RunSummarySchema, summarize } from "../src/gate";

type Sev = Finding["severity"];
type Conf = Finding["confidence"];
type Cat = Finding["category"];
type Src = Finding["source"];

let n = 0;
function f(severity: Sev, confidence: Conf, category: Cat, source: Src = "static-analysis") {
  n += 1;
  return {
    id: n.toString(16).padStart(32, "0"),
    engine: "quality",
    ruleId: "r.test",
    title: "t",
    severity,
    confidence,
    category,
    source,
    message: "m",
    evidence: [],
  } satisfies Finding;
}

const okEngine: EngineSummaryData[] = [
  { id: "quality", applicable: true, tasks: [{ id: "a", status: "ok" }] },
];

function input(over: Partial<Parameters<typeof summarize>[0]> = {}) {
  return {
    status: "completed" as const,
    completeness: "complete" as const,
    notDone: [],
    engines: okEngine,
    findings: [] as Finding[],
    ...over,
  };
}

describe("bucketOf", () => {
  const rows: [Sev, Conf, Cat, Src, "must" | "should" | "later"][] = [
    ["critical", "high", "security", "static-analysis", "must"],
    ["critical", "medium", "quality", "static-analysis", "must"],
    ["critical", "low", "security", "static-analysis", "should"],
    ["high", "high", "secret", "scanner", "must"],
    ["high", "medium", "secret", "scanner", "should"],
    ["high", "high", "security", "scanner", "should"],
    ["medium", "high", "quality", "static-analysis", "should"],
    ["low", "high", "security", "static-analysis", "later"],
    ["info", "low", "quality", "heuristic", "later"],
    ["critical", "medium", "security", "ai-reasoning", "should"],
    ["high", "medium", "secret", "ai-reasoning", "should"],
  ];
  it.each(rows)("%s/%s/%s/%s → %s", (severity, confidence, category, source, bucket) => {
    expect(bucketOf({ severity, confidence, category, source })).toBe(bucket);
  });
});

describe("summarize", () => {
  const skipped: EngineSummaryData[] = [
    {
      id: "quality",
      applicable: true,
      tasks: [
        { id: "a", status: "ok" },
        { id: "b", status: "skipped" },
      ],
    },
  ];
  const failed: EngineSummaryData[] = [
    {
      id: "quality",
      applicable: true,
      tasks: [
        { id: "a", status: "ok" },
        { id: "b", status: "failed" },
      ],
    },
  ];
  const partial = { completeness: "partial" as const, notDone: [{ what: "x", reason: "y" }] };
  const rows: [string, Parameters<typeof summarize>[0], string, string, number][] = [
    ["nothing ran is none", input({ engines: [], ...partial }), "none", "none", 0],
    [
      "failed run with no tasks",
      input({ status: "failed", engines: [], ...partial }),
      "none",
      "none",
      0,
    ],
    ["all ok, complete", input(), "ready", "ready", 0],
    [
      "all ok, complete, one medium",
      input({ findings: [f("medium", "high", "quality")] }),
      "ready",
      "ready",
      0,
    ],
    ["all ok, partial", input(partial), "review", "review", 0],
    ["a skipped task", input({ engines: skipped }), "review", "review", 0],
    ["a failed task", input({ engines: failed }), "review", "review", 0],
    [
      "complete, one high",
      input({ findings: [f("high", "high", "security")] }),
      "review",
      "ready",
      1,
    ],
    [
      "complete, one must and two high",
      input({
        findings: [
          f("critical", "high", "security"),
          f("high", "high", "security"),
          f("high", "medium", "quality"),
        ],
      }),
      "blocked",
      "ready",
      3,
    ],
    [
      "partial, one must",
      input({ ...partial, findings: [f("critical", "high", "security")] }),
      "blocked",
      "review",
      1,
    ],
    [
      "cancelled with ok tasks and no findings",
      input({ status: "cancelled", ...partial }),
      "review",
      "review",
      0,
    ],
    [
      "cancelled with one must",
      input({ status: "cancelled", ...partial, findings: [f("critical", "high", "secret")] }),
      "blocked",
      "review",
      1,
    ],
    [
      "complete, one ai-reasoning critical",
      input({ findings: [f("critical", "medium", "security", "ai-reasoning")] }),
      "review",
      "ready",
      1,
    ],
  ];
  it.each(rows)("%s", (_name, inp, gate, afterFix, needed) => {
    const s = summarize(inp);
    expect({ gate: s.gate, afterFix: s.afterFix, needed: s.needed }).toEqual({
      gate,
      afterFix,
      needed,
    });
    expect(RunSummarySchema.safeParse(s).success).toBe(true);
  });

  it("counts buckets and tasks", () => {
    const findings = [
      f("critical", "high", "security"),
      f("medium", "high", "quality"),
      f("low", "high", "quality"),
      f("info", "low", "quality"),
    ];
    const s = summarize(input({ findings, engines: skipped }));
    expect(s.counts).toEqual({ must: 1, should: 1, later: 2 });
    expect(s).toMatchObject({ checked: 1, skipped: 1, failed: 0 });
  });

  it("does not mutate its input", () => {
    const inp = input({ findings: [f("high", "high", "security")] });
    const copy = structuredClone(inp);
    summarize(inp);
    expect(inp).toEqual(copy);
  });

  it("is strict: an unknown key is rejected", () => {
    const s = summarize(input());
    expect(RunSummarySchema.safeParse({ ...s, extra: 1 }).success).toBe(false);
  });
});
