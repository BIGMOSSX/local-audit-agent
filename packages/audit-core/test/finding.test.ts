import { describe, expect, it } from "vitest";
import {
  EvidenceSchema,
  FINDING_TEXT_FIELDS,
  FINDING_TEXT_LIST_FIELDS,
  FindingSchema,
  mapFindingText,
  RepoPathSchema,
} from "../src/finding";

const base = {
  id: "0123456789abcdef0123456789abcdef",
  engine: "quality",
  ruleId: "quality.missing-test",
  title: "No test found for src/a.ts",
  severity: "low",
  confidence: "low",
  category: "testing",
  source: "heuristic",
  file: "src/a.ts",
  message: "No test file matches src/a.ts.",
  evidence: [],
} as const;

describe("RepoPathSchema", () => {
  it.each(["a.ts", "src/a/b.ts", "dir with space/é.ts"])("accepts %s", (p) => {
    expect(RepoPathSchema.safeParse(p).success).toBe(true);
  });
  it.each([
    "a\u0001b",
    "a\u001Fb",
    "a\u007Fb",
    "a\u0080b",
    "a\u009Fb",
    "a\u202Eb",
    "a\u2066b",
    "a\u2069b",
    "a\u202Ab",
  ])("rejects control/bidi characters in %j", (p) => {
    expect(RepoPathSchema.safeParse(p).success).toBe(false);
  });
  it.each(["", "/etc/passwd", "../x", "a/../b", "a\\b", "C:/x", "a\0b", "./a"])(
    "rejects %j",
    (p) => {
      expect(RepoPathSchema.safeParse(p).success).toBe(false);
    },
  );
});

describe("FindingSchema", () => {
  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(base).success).toBe(true);
  });
  it("is strict: unknown keys are rejected", () => {
    expect(FindingSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("requires a 32-hex id", () => {
    expect(FindingSchema.safeParse({ ...base, id: "nope" }).success).toBe(false);
  });
  it("§55: a scanner finding needs evidence", () => {
    expect(FindingSchema.safeParse({ ...base, source: "scanner", evidence: [] }).success).toBe(
      false,
    );
    const ev = { kind: "code", file: "src/a.ts", startLine: 1, text: "x" };
    expect(FindingSchema.safeParse({ ...base, source: "scanner", evidence: [ev] }).success).toBe(
      true,
    );
  });
  it("§55: ai-reasoning can never claim high confidence", () => {
    const r = FindingSchema.safeParse({ ...base, source: "ai-reasoning", confidence: "high" });
    expect(r.success).toBe(false);
  });
  it("caps evidence text and evidence count", () => {
    expect(EvidenceSchema.safeParse({ kind: "log", text: "x".repeat(2001) }).success).toBe(false);
    const many = Array.from({ length: 21 }, () => ({ kind: "log", text: "x" }));
    expect(FindingSchema.safeParse({ ...base, evidence: many }).success).toBe(false);
  });
  it("R12: accepts the spec categories secret/performance/data/release and optional verifyAfterFix", () => {
    for (const category of ["secret", "performance", "data", "release"]) {
      expect(FindingSchema.safeParse({ ...base, category }).success).toBe(true);
    }
    expect(FindingSchema.safeParse({ ...base, verifyAfterFix: ["pnpm test"] }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...base, verifyAfterFix: Array(11).fill("x") }).success).toBe(
      false,
    );
  });
  it("evidence line numbers are positive and ordered", () => {
    expect(EvidenceSchema.safeParse({ kind: "code", startLine: 0, text: "x" }).success).toBe(false);
    expect(
      EvidenceSchema.safeParse({ kind: "code", startLine: 5, endLine: 2, text: "x" }).success,
    ).toBe(false);
  });
});

describe("mapFindingText covers exactly the free-text fields of FindingSchema", () => {
  // Free text accepts any string; ids, rule ids, engine names and repo paths reject this one
  // (not a hex id, not kebab/dotted, contains a backslash). Enums are not strings at all.
  const PROBE = "Hello World!\\";
  type Def = { type: string; innerType?: Node; element?: Node; shape?: Record<string, Node> };
  type Node = {
    _zod: { def: Def };
    safeParse(v: unknown): { success: boolean };
    shape?: Record<string, Node>;
  };
  const unwrap = (n: Node): Node =>
    n._zod.def.type === "optional" ? unwrap(n._zod.def.innerType as Node) : n;
  const takesProbe = (n: Node) => n.safeParse(PROBE).success;

  it("the exported field lists match what the schema's string fields accept", () => {
    const shape = (FindingSchema as unknown as { shape: Record<string, Node> }).shape;
    const texts: string[] = [];
    const lists: string[] = [];
    let evidenceText = false;
    for (const [key, raw] of Object.entries(shape)) {
      const node = unwrap(raw);
      const type = node._zod.def.type;
      if (type === "string" && takesProbe(node)) texts.push(key);
      if (type === "array") {
        const element = unwrap(node._zod.def.element as Node);
        if (element._zod.def.type === "string" && takesProbe(element)) lists.push(key);
        if (element._zod.def.type === "object" && element.shape?.text) {
          const evShape = element.shape;
          for (const [k, v] of Object.entries(evShape)) {
            const t = unwrap(v);
            if (t._zod.def.type === "string" && takesProbe(t)) {
              expect(k).toBe("text");
              evidenceText = true;
            }
          }
        }
      }
    }
    expect(texts.sort()).toEqual([...FINDING_TEXT_FIELDS].sort());
    expect(lists.sort()).toEqual([...FINDING_TEXT_LIST_FIELDS].sort());
    expect(evidenceText).toBe(true);
  });
  it("transforms every text position and nothing else", () => {
    const f = {
      id: "0".repeat(32),
      engine: "fake",
      ruleId: "fake.rule",
      title: "t",
      severity: "info",
      confidence: "low",
      category: "quality",
      source: "scanner",
      file: "a.ts",
      line: 3,
      message: "m",
      evidence: [{ kind: "log", file: "b.ts", text: "e" }],
      remediation: "r",
      verifyAfterFix: ["v"],
    };
    const seen: string[] = [];
    const out = mapFindingText(f, (text, field) => {
      seen.push(field);
      return `<${text}>`;
    }) as typeof f;
    expect(seen.sort()).toEqual([
      "evidence.text",
      "message",
      "remediation",
      "title",
      "verifyAfterFix",
    ]);
    expect(out).toEqual({
      ...f,
      title: "<t>",
      message: "<m>",
      remediation: "<r>",
      verifyAfterFix: ["<v>"],
      evidence: [{ kind: "log", file: "b.ts", text: "<e>" }],
    });
    expect(mapFindingText(5, (t) => t)).toBe(5);
    expect(mapFindingText(null, (t) => t)).toBe(null);
  });
});
