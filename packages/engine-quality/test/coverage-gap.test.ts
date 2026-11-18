import { describe, expect, it } from "vitest";
import { findUntestedFiles } from "../src/coverage-gap";

describe("findUntestedFiles", () => {
  it("flags source files without a matching test and ignores tests, configs, dts, dist", () => {
    const files = [
      "src/a.ts",
      "src/a.test.ts",
      "src/b.ts",
      "src/c.tsx",
      "src/__tests__/c.test.tsx",
      "src/types.d.ts",
      "vitest.config.ts",
      "dist/x.js",
      "node_modules/y/index.js",
      "pkg/mod.py",
      "pkg/test_mod.py",
      "pkg/other.py",
      "cmd/main.go",
      "cmd/main_test.go",
      "cmd/util.go",
      "lib/z.rs",
    ];
    expect(findUntestedFiles(files)).toEqual(["cmd/util.go", "pkg/other.py", "src/b.ts"]);
  });
  it("returns nothing for a project with no source files", () => {
    expect(findUntestedFiles(["README.md", "package.json"])).toEqual([]);
  });
  it("treats a test directory match by base name across folders", () => {
    expect(findUntestedFiles(["src/deep/a.ts", "test/a.test.ts"])).toEqual([]);
  });

  it("normalizes Windows separators for matching and returns POSIX paths", () => {
    expect(
      findUntestedFiles(["src\\a.ts", "src\\a.test.ts", "src\\b.ts", "node_modules\\x\\i.js"]),
    ).toEqual(["src/b.ts"]);
  });
  it("matches test directories case-sensitively (only the well-known lower-case names)", () => {
    expect(findUntestedFiles(["src/a.ts", "Test/a.ts"])).toEqual(["Test/a.ts", "src/a.ts"]);
  });
  it("handles Unicode names, including different normalization forms", () => {
    const nfc = "src/café.ts";
    const nfdTest = "src/café.test.ts";
    expect(findUntestedFiles([nfc, nfdTest, "src/日本語.ts"])).toEqual(["src/日本語.ts"]);
  });
  it("is deterministic regardless of input order and ignores duplicates", () => {
    const a = ["src/z.ts", "src/b.ts", "src/b.ts", "src/m.py"];
    expect(findUntestedFiles(a)).toEqual(findUntestedFiles([...a].reverse()));
    expect(findUntestedFiles(a)).toEqual(["src/b.ts", "src/m.py", "src/z.ts"]);
  });
  it("tolerates non-string entries without throwing", () => {
    expect(
      findUntestedFiles(["src/a.ts", 5 as unknown as string, null as unknown as string]),
    ).toEqual(["src/a.ts"]);
  });
  it("is linear: 100k entries finish quickly", () => {
    const files: string[] = [];
    for (let i = 0; i < 50_000; i++)
      files.push(`src/m${i}/f${i}.ts`, `test/f${i % 2 === 0 ? i : -i}.test.ts`);
    const t = Date.now();
    const out = findUntestedFiles(files);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(out.length).toBe(25_000);
  });

  describe("review round 1", () => {
    it("files in test folders count as tests only by name; helpers and fixtures are neither", () => {
      expect(findUntestedFiles(["test/helpers/util.ts", "src/util.ts"])).toEqual(["src/util.ts"]);
      expect(findUntestedFiles(["tests/fixtures/a.ts", "src/a.ts"])).toEqual(["src/a.ts"]);
      expect(findUntestedFiles(["spec/support/b.js", "src/b.js"])).toEqual(["src/b.js"]);
      // a helper in a test folder is not itself reported as missing a test
      expect(findUntestedFiles(["test/helpers/util.ts"])).toEqual([]);
    });
    it("generic stems (index, main, mod, __init__) are covered only by a test in the same folder", () => {
      expect(findUntestedFiles(["src/a/index.ts", "src/b/index.test.ts"])).toEqual([
        "src/a/index.ts",
      ]);
      expect(findUntestedFiles(["src/a/index.ts", "test/index.test.ts"])).toEqual([
        "src/a/index.ts",
      ]);
      expect(findUntestedFiles(["src/a/index.ts", "src/a/index.test.ts"])).toEqual([]);
      expect(findUntestedFiles(["src/a/index.ts", "src/a/__tests__/index.test.ts"])).toEqual([]);
      expect(findUntestedFiles(["cmd/main.go", "other/main_test.go"])).toEqual(["cmd/main.go"]);
      expect(findUntestedFiles(["pkg/mod.py", "other/test_mod.py"])).toEqual(["pkg/mod.py"]);
      expect(findUntestedFiles(["main.ts", "main.test.ts"])).toEqual([]);
    });
    it("ordinary stems still match across folders", () => {
      expect(findUntestedFiles(["src/deep/a.ts", "test/a.test.ts"])).toEqual([]);
    });
    it("ignores __init__.py, __main__.py, dotfile configs, stories, mocks, fixtures, e2e and cypress", () => {
      expect(
        findUntestedFiles([
          "pkg/__init__.py",
          "pkg/__main__.py",
          ".eslintrc.js",
          "web/.babelrc.cjs",
          "ui/Button.stories.tsx",
          "src/__mocks__/fs.ts",
          "src/__fixtures__/data.ts",
          "e2e/flow.ts",
          "cypress/support/commands.ts",
          "types/x.d.mts",
          "types/y.d.cts",
        ]),
      ).toEqual([]);
    });
    it("recognises e2e-spec and .cy. test names", () => {
      expect(findUntestedFiles(["src/app.ts", "src/app.e2e-spec.ts"])).toEqual([]);
      expect(findUntestedFiles(["src/login.ts", "cypress/e2e/login.cy.ts"])).toEqual([]);
    });
    it("treats .mts and .cts like .ts", () => {
      expect(findUntestedFiles(["src/a.mts", "src/b.cts", "src/c.mts", "src/c.test.mts"])).toEqual([
        "src/a.mts",
        "src/b.cts",
      ]);
    });
  });
});
