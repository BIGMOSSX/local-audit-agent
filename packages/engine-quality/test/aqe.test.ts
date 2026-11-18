import { FindingSchema } from "@audit/audit-core";
import { describe, expect, it } from "vitest";
import {
  AqeCoverageRowSchema,
  AqeCoverageSchema,
  extractAqeCoverage,
  mapAqeCoverage,
  toRepoRelative,
  unwrapToolText,
} from "../src/aqe";
import { fingerprint } from "../src/fingerprint";
import { CAPTURED_DIR, innerOf, loadResponse, loadResult, retarget, wrap } from "./aqe-fixtures";

const MEASURED_DIR = CAPTURED_DIR; // "/tmp/aqe-contract-WAPKVx/project2"
const FORBIDDEN = /agentic|aqe|coverage_analyze|sublinear/i;

const doc = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  wrap({
    success: true,
    data: { coverageByFile: rows, measured: true, estimated: false, ...extra },
  });
const row = (file: string, lineCoverage: unknown) => ({
  file,
  lineCoverage,
  branchCoverage: null,
  functionCoverage: null,
});

describe("captured fixtures", () => {
  it("measured and estimated documents parse with AqeCoverageSchema", () => {
    for (const name of ["measured", "estimated"] as const) {
      const parsed = AqeCoverageSchema.safeParse(innerOf(loadResult(name)));
      expect(parsed.success, name).toBe(true);
    }
    const m = AqeCoverageSchema.parse(innerOf(loadResult("measured")));
    expect(m.data.measured).toBe(true);
    expect(m.data.estimated).toBe(false);
    expect(m.data.coverageByFile).toHaveLength(60);
    const e = AqeCoverageSchema.parse(innerOf(loadResult("estimated")));
    expect(e.data.measured).toBe(false);
    expect(e.data.estimated).toBe(true);
  });
  it("the unwrap accepts both the MCP result and the full JSON-RPC response", () => {
    expect(unwrapToolText(loadResult("measured"))).toEqual(innerOf(loadResult("measured")));
    expect(unwrapToolText(loadResponse("measured"))).toEqual(innerOf(loadResult("measured")));
  });
  it("row schema: the three percentages may be null, lineCoverage must be present", () => {
    expect(AqeCoverageRowSchema.safeParse(row("/a/b.ts", null)).success).toBe(true);
    expect(AqeCoverageRowSchema.safeParse({ file: "/a", branchCoverage: 1 }).success).toBe(false);
    expect(AqeCoverageRowSchema.safeParse(row("/a", "12")).success).toBe(false);
  });
});

describe("mapAqeCoverage on the measured fixture", () => {
  const raw = loadResult("measured");
  const rows = AqeCoverageSchema.parse(innerOf(raw)).data.coverageByFile;
  const below = rows.filter((r) => r.lineCoverage !== null && r.lineCoverage < 50);
  const findings = mapAqeCoverage(raw, MEASURED_DIR);

  it("maps files below 50% line coverage, capped at 25, as schema-valid findings", () => {
    expect(below.length).toBeGreaterThan(25); // the fixture really exercises the cap
    expect(findings).toHaveLength(Math.min(25, below.length));
    for (const f of findings) {
      expect(FindingSchema.safeParse(f).success).toBe(true);
      expect(f).toMatchObject({
        engine: "quality",
        ruleId: "quality.low-coverage",
        source: "static-analysis",
        category: "testing",
        severity: "medium",
      });
      expect(f.file).toMatch(/^src\/mod\d\d\.ts$/);
      expect(f.id).toBe(fingerprint(["quality", "quality.low-coverage", f.file ?? ""]));
      expect(f.evidence[0]?.text).toContain("0.0%");
    }
  });
  it("is sorted lowest coverage first, then by path, and deterministic", () => {
    const files = findings.map((f) => f.file);
    expect(files).toEqual([...files].sort());
    expect(mapAqeCoverage(raw, MEASURED_DIR)).toEqual(findings);
    expect(mapAqeCoverage(loadResponse("measured"), `${MEASURED_DIR}/`)).toEqual(findings);
  });
  it("66.7% files (>= 50) are not reported; files outside the project are dropped", () => {
    expect(
      findings.some((f) => rows.find((r) => r.file.endsWith(f.file ?? "?"))?.lineCoverage === 66.7),
    ).toBe(false);
    expect(mapAqeCoverage(raw, "/somewhere/else")).toEqual([]);
  });
  it("no upstream names reach any finding string", () => {
    expect(JSON.stringify(findings)).not.toMatch(FORBIDDEN);
  });
  it("severity: below 25 medium, 25..49.9 low; the percentage is rounded to one decimal", () => {
    const out = mapAqeCoverage(
      doc([
        row(`${MEASURED_DIR}/a.ts`, 24.96),
        row(`${MEASURED_DIR}/b.ts`, 25),
        row(`${MEASURED_DIR}/c.ts`, 49.94),
        row(`${MEASURED_DIR}/d.ts`, 50),
      ]),
      MEASURED_DIR,
    );
    expect(out.map((f) => [f.file, f.severity])).toEqual([
      ["a.ts", "medium"],
      ["b.ts", "low"],
      ["c.ts", "low"],
    ]);
    expect(out[0]?.evidence[0]?.text).toContain("25.0%");
    expect(out[2]?.evidence[0]?.text).toContain("49.9%");
  });
});

describe("estimated or unusable output", () => {
  it("an estimate yields no findings and is classified not-measured", () => {
    const est = loadResult("estimated");
    expect(mapAqeCoverage(est, "/tmp/aqe-contract-WAPKVx/project")).toEqual([]);
    expect(extractAqeCoverage(est, "/tmp/aqe-contract-WAPKVx/project").kind).toBe("not-measured");
  });
  it("measured and estimated both true, or both false, is never treated as measured", () => {
    for (const [m, e] of [
      [true, true],
      [false, false],
      [false, true],
    ] as const) {
      const r = wrap({
        success: true,
        data: { coverageByFile: [row(`${MEASURED_DIR}/a.ts`, 0)], measured: m, estimated: e },
      });
      expect(mapAqeCoverage(r, MEASURED_DIR)).toEqual([]);
    }
  });
});

describe("rows that cannot be tied to the project", () => {
  it("all usable rows outside projectDir is 'unmapped'; one mapped row makes it 'measured'", () => {
    const outside = doc([row("/elsewhere/a.ts", 0), row("D:\\x\\b.ts", 0)]);
    expect(extractAqeCoverage(outside, MEASURED_DIR).kind).toBe("unmapped");
    expect(mapAqeCoverage(outside, MEASURED_DIR)).toEqual([]);
    const mixed = doc([row("/elsewhere/a.ts", 0), row(`${MEASURED_DIR}/ok.ts`, 0)]);
    expect(extractAqeCoverage(mixed, MEASURED_DIR).kind).toBe("measured");
    expect(mapAqeCoverage(mixed, MEASURED_DIR).map((f) => f.file)).toEqual(["ok.ts"]);
    // no usable rows at all is an empty measurement, not a path problem
    expect(extractAqeCoverage(doc([]), MEASURED_DIR)).toEqual({ kind: "measured", rows: [] });
    expect(extractAqeCoverage(doc([row("/elsewhere/a.ts", null)]), MEASURED_DIR).kind).toBe(
      "measured",
    );
  });
});

describe("hostile shapes never throw", () => {
  const dirpath = (p: string) => `${MEASURED_DIR}/${p}`;
  it("non-JSON text, success:false, wrong top-level types, missing fields", () => {
    const cases: unknown[] = [
      undefined,
      null,
      5,
      "x",
      [],
      {},
      { content: [] },
      { content: [{}] },
      { content: "x" },
      { content: [{ type: "text", text: "not json {" }] },
      { content: [{ type: "text", text: 5 }] },
      { content: [{ type: "image", text: "{}" }] },
      {
        isError: true,
        content: [
          {
            type: "text",
            text: '{"success":true,"data":{"coverageByFile":[],"measured":true,"estimated":false}}',
          },
        ],
      },
      wrap({ success: false, data: { coverageByFile: [], measured: true, estimated: false } }),
      wrap(null),
      wrap([]),
      wrap({ success: true }),
      wrap({ success: true, data: null }),
      wrap({ success: true, data: { coverageByFile: "x", measured: true, estimated: false } }),
      wrap({ success: true, data: { coverageByFile: [], measured: "yes", estimated: false } }),
      wrap({ success: true, data: { coverageByFile: [] } }),
    ];
    for (const c of cases) expect(mapAqeCoverage(c, MEASURED_DIR)).toEqual([]);
    expect(extractAqeCoverage(wrap({ success: false }), MEASURED_DIR).kind).toBe("unreadable");
  });
  it("bad rows are skipped, good rows survive", () => {
    const out = mapAqeCoverage(
      doc([
        null,
        5,
        "x",
        {},
        { file: 5, lineCoverage: 0 },
        { file: dirpath("a.ts") },
        row(dirpath("b.ts"), "0"),
        row(dirpath("ok.ts"), 10),
      ]),
      MEASURED_DIR,
    );
    expect(out.map((f) => f.file)).toEqual(["ok.ts"]);
  });
  it("NaN, Infinity, negative, > 100 and null percentages yield nothing", () => {
    // JSON cannot carry NaN/Infinity: they arrive as null or a string; 1e999 parses to Infinity.
    const text = `{"success":true,"data":{"coverageByFile":[{"file":"${dirpath("a.ts")}","lineCoverage":1e999},{"file":"${dirpath("b.ts")}","lineCoverage":-1e999}],"measured":true,"estimated":false}}`;
    expect(mapAqeCoverage({ content: [{ type: "text", text }] }, MEASURED_DIR)).toEqual([]);
    const out = mapAqeCoverage(
      doc([
        row(dirpath("n.ts"), null),
        row(dirpath("neg.ts"), -5),
        row(dirpath("big.ts"), 120),
        row(dirpath("nan.ts"), "NaN"),
        row(dirpath("ok.ts"), 0),
      ]),
      MEASURED_DIR,
    );
    expect(out.map((f) => f.file)).toEqual(["ok.ts"]);
  });
  it("10 000 rows: only the first 5000 are scanned and findings are capped at 25", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => row(dirpath(`f${i}.ts`), 0));
    expect(mapAqeCoverage(doc(rows), MEASURED_DIR)).toHaveLength(25);
    const late = [
      ...Array.from({ length: 5000 }, (_, i) => row(dirpath(`g${i}.ts`), 90)),
      row(dirpath("late.ts"), 0),
    ];
    expect(mapAqeCoverage(doc(late), MEASURED_DIR)).toEqual([]);
  });
  it("paths outside the project, traversal, relative and odd paths are dropped", () => {
    const bad = [
      "/etc/passwd",
      "/tmp/aqe-contract-WAPKVx/project22/src/a.ts", // sibling sharing a prefix
      dirpath("../project3/a.ts"),
      dirpath("src/../../x.ts"),
      "src/a.ts",
      "../a.ts",
      "",
      dirpath(""),
      dirpath("a\0b.ts"),
      dirpath("sp\u200bace.ts"),
      dirpath("lr\u200em.ts"),
      dirpath("c\u0007trl.ts"),
      dirpath("bidi\u202e.ts"),
      dirpath("a//b.ts"),
      dirpath("./a.ts"),
      `${MEASURED_DIR}`,
    ];
    expect(mapAqeCoverage(doc(bad.map((p) => row(p, 0))), MEASURED_DIR)).toEqual([]);
  });
  it("Windows-style backslash paths under a Windows-style project dir", () => {
    const win = "C:\\Users\\me\\proj";
    const out = mapAqeCoverage(
      doc([
        row("C:\\Users\\me\\proj\\src\\a.ts", 3),
        row("C:\\Users\\me\\proj\\..\\other\\b.ts", 3),
        row("C:\\Users\\me\\other\\c.ts", 3),
        row("D:\\proj\\d.ts", 3),
      ]),
      `${win}\\`,
    );
    expect(out.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(toRepoRelative("/p/src/a.ts", "/p/")).toBe("src/a.ts");
    expect(toRepoRelative("/p/src/a.ts", "")).toBeNull();
    expect(toRepoRelative("/p", "/p")).toBeNull();
  });
  it("control and zero-width characters in a path never reach a finding; unicode names are fine", () => {
    const out = mapAqeCoverage(
      doc([row(dirpath("日本語/café.ts"), 1), row(dirpath("bad\nname.ts"), 1)]),
      MEASURED_DIR,
    );
    expect(out.map((f) => f.file)).toEqual(["日本語/café.ts"]);
    for (const f of out) expect(FindingSchema.safeParse(f).success).toBe(true);
  });
  it("very long file names still produce a schema-valid finding", () => {
    const long = `${"d".repeat(200)}/${"e".repeat(700)}.ts`;
    const out = mapAqeCoverage(doc([row(dirpath(long), 1)]), MEASURED_DIR);
    expect(out).toHaveLength(1);
    expect(FindingSchema.safeParse(out[0]).success).toBe(true);
  });
  it("huge text is refused before parsing", () => {
    const huge = { content: [{ type: "text", text: `{"pad":"${"x".repeat(5 * 1024 * 1024)}"}` }] };
    expect(unwrapToolText(huge)).toBeNull();
    expect(mapAqeCoverage(huge, MEASURED_DIR)).toEqual([]);
  });
  it("deeply nested JSON text does not throw", () => {
    const text = `${"[".repeat(500_000)}${"]".repeat(500_000)}`;
    expect(mapAqeCoverage({ content: [{ type: "text", text }] }, MEASURED_DIR)).toEqual([]);
  });
  it("__proto__ keys and duplicate rows are harmless; duplicates keep the lowest figure", () => {
    const text = `{"__proto__":{"measured":false},"success":true,"data":{"coverageByFile":[{"file":"${dirpath("a.ts")}","lineCoverage":40,"__proto__":{"x":1}},{"file":"${dirpath("a.ts")}","lineCoverage":10}],"measured":true,"estimated":false}}`;
    const out = mapAqeCoverage({ content: [{ type: "text", text }] }, MEASURED_DIR);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence[0]?.text).toContain("10.0%");
    expect(({} as Record<string, unknown>).measured).toBeUndefined();
  });
  it("a hostile projectDir argument never throws", () => {
    for (const d of ["", "/", "\\", "\0", "a".repeat(100_000), 5 as unknown as string])
      expect(() => mapAqeCoverage(doc([row("/a.ts", 0)]), d)).not.toThrow();
  });
});

// Pure string logic: these run on every OS, so Linux CI proves the Windows spellings.
describe("toRepoRelative: Windows spellings", () => {
  const dirs = ["C:\\x\\y", "C:/x/y", "C:\\x\\y\\", "c:\\x/y", "\\\\?\\C:\\x\\y"];
  const spellings = [
    "C:\\x\\y\\src\\a.ts",
    "C:/x/y/src/a.ts",
    "c:\\x\\y\\src\\a.ts",
    "C:\\x/y\\src/a.ts",
    "\\\\?\\C:\\x\\y\\src\\a.ts",
    "C:\\X\\Y\\src\\a.ts",
  ];
  it("every spelling of the file under every spelling of the directory maps to the same path", () => {
    for (const d of dirs)
      for (const f of spellings) expect(toRepoRelative(f, d), `${f} in ${d}`).toBe("src/a.ts");
  });
  it("keeps the engine's spelling of the part below the directory", () => {
    expect(toRepoRelative("C:\\x\\y\\Src\\A.ts", "C:\\x\\y")).toBe("Src/A.ts");
  });
  it("drops what is outside, including a sibling that merely shares the prefix", () => {
    for (const f of [
      "C:\\x\\yy\\a.ts",
      "D:\\x\\y\\a.ts",
      "C:\\x\\y",
      "C:\\x\\y\\",
      "C:\\x\\y\\..\\z\\a.ts",
      "C:\\x\\y\\src\\..\\..\\a.ts",
      "\\\\other\\share\\a.ts",
      "src/a.ts",
      "/x/y/src/a.ts",
    ])
      expect(toRepoRelative(f, "C:\\x\\y"), f).toBeNull();
  });
  it("UNC project directories work, case-insensitively", () => {
    expect(toRepoRelative("\\\\srv\\share\\p\\a.ts", "\\\\srv\\share\\p")).toBe("a.ts");
    expect(toRepoRelative("//SRV/Share/p/a.ts", "\\\\srv\\share\\p")).toBe("a.ts");
    expect(toRepoRelative("\\\\?\\UNC\\srv\\share\\p\\a.ts", "\\\\srv\\share\\p")).toBe("a.ts");
  });
  it("a drive root works as the project directory", () => {
    expect(toRepoRelative("C:\\a.ts", "C:\\")).toBe("a.ts");
  });
  it("POSIX directories stay case-sensitive", () => {
    expect(toRepoRelative("/P/src/a.ts", "/p")).toBeNull();
    expect(toRepoRelative("/p/src/a.ts", "/p")).toBe("src/a.ts");
  });
  it("a hidden-character name is dropped on a Windows path as well", () => {
    expect(toRepoRelative("C:\\x\\y\\a\u200b.ts", "C:\\x\\y")).toBeNull();
  });
});

describe("mapAqeCoverage with a Windows projectDir", () => {
  const winDir = "D:\\a\\proj\\sandbox";
  it("maps backslash, slash and re-cased spellings of rows under it, drops the rest", () => {
    const raw = doc([
      row("D:\\a\\proj\\sandbox\\src\\one.ts", 0),
      row("D:/a/proj/sandbox/src/two.ts", 10),
      row("d:\\A\\proj\\sandbox\\src\\three.ts", 20),
      row("D:\\a\\proj\\other\\src\\four.ts", 0),
    ]);
    const files = mapAqeCoverage(raw, winDir)
      .map((f) => f.file)
      .sort();
    expect(files).toEqual(["src/one.ts", "src/three.ts", "src/two.ts"]);
  });
  it("all rows outside a Windows projectDir is 'unmapped'", () => {
    expect(extractAqeCoverage(doc([row("E:\\q\\a.ts", 0)]), winDir).kind).toBe("unmapped");
  });
});

describe("retarget (test helper)", () => {
  it("re-roots the captured paths at a Windows directory without breaking the JSON", () => {
    const winDir = "D:\\a\\proj\\sandbox";
    for (const name of ["measured", "estimated"] as const) {
      const out = retarget(loadResult(name), winDir);
      const inner = innerOf(out);
      expect(JSON.stringify(inner)).not.toContain("aqe-contract");
      expect(JSON.stringify(inner)).toContain("D:\\\\a\\\\proj\\\\sandbox");
    }
    const rows = innerOf(retarget(loadResult("measured"), winDir)).data.coverageByFile as {
      file: string;
    }[];
    expect(rows[0]?.file).toBe("D:\\a\\proj\\sandbox/src/mod00.ts");
    expect(mapAqeCoverage(retarget(loadResult("measured"), winDir), winDir).length).toBe(25);
  });
});
