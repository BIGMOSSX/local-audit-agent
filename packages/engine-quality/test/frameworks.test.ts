import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTestFrameworks } from "../src/frameworks";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function proj(files: Record<string, string>): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "eq-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return { root, files: Object.keys(files) };
}
const names = (p: { root: string; files: string[] }) =>
  detectTestFrameworks(p.root, p.files).map((f) => f.name);

describe("detectTestFrameworks", () => {
  it("node: from devDependencies and from the test script", () => {
    expect(names(proj({ "package.json": '{"devDependencies":{"vitest":"5"}}' }))).toEqual([
      "vitest",
    ]);
    expect(names(proj({ "package.json": '{"scripts":{"test":"jest --ci"}}' }))).toEqual(["jest"]);
  });
  it("node: several frameworks are reported sorted", () => {
    expect(
      names(proj({ "package.json": '{"devDependencies":{"mocha":"1","@playwright/test":"1"}}' })),
    ).toEqual(["mocha", "playwright"]);
  });
  it("python: pytest via conftest, pytest.ini, pyproject or requirements", () => {
    expect(names(proj({ "conftest.py": "" }))).toEqual(["pytest"]);
    expect(names(proj({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))).toEqual(["pytest"]);
    expect(names(proj({ "requirements-dev.txt": "pytest>=8\n" }))).toEqual(["pytest"]);
  });
  it("go: any _test.go file; rust: Cargo.toml", () => {
    expect(names(proj({ "a_test.go": "" }))).toEqual(["go-test"]);
    expect(names(proj({ "Cargo.toml": "" }))).toEqual(["cargo-test"]);
  });
  it("java: junit in pom or gradle", () => {
    expect(names(proj({ "pom.xml": "<artifactId>junit-jupiter</artifactId>" }))).toEqual(["junit"]);
  });
  it("never throws on hostile package.json (invalid, oversized, a directory)", () => {
    expect(names(proj({ "package.json": "{ not json" }))).toEqual([]);
    expect(
      names(
        proj({
          "package.json": `{"pad":"${"x".repeat(1024 * 1024 + 1)}","devDependencies":{"jest":"1"}}`,
        }),
      ),
    ).toEqual([]);
    const p = proj({ "x.txt": "" });
    mkdirSync(join(p.root, "package.json"));
    expect(detectTestFrameworks(p.root, ["package.json"])).toEqual([]);
  });
  it("returns nothing for an empty project", () => {
    expect(names(proj({ "README.md": "" }))).toEqual([]);
  });

  describe("hostile package.json shapes", () => {
    const pkg = (text: string) => names(proj({ "package.json": text }));
    it("tolerates a BOM", () => {
      expect(pkg('\uFEFF{"devDependencies":{"jest":"1"}}')).toEqual(["jest"]);
    });
    it("non-object JSON and wrong-typed fields yield nothing", () => {
      for (const t of ["null", "[]", '"jest"', "42", "true", "", "   "]) expect(pkg(t)).toEqual([]);
      expect(pkg('{"dependencies":"jest","devDependencies":["jest"],"scripts":["jest"]}')).toEqual(
        [],
      );
      expect(pkg('{"scripts":{"test":{"a":"jest"}}}')).toEqual([]);
      expect(pkg('{"scripts":{"test":["jest"]}}')).toEqual([]);
      expect(pkg('{"scripts":"jest"}')).toEqual([]);
    });
    it("__proto__ / constructor keys do not pollute or confuse detection", () => {
      expect(
        pkg(
          '{"__proto__":{"devDependencies":{"jest":"1"}},"devDependencies":{"__proto__":{"vitest":"1"}}}',
        ),
      ).toEqual([]);
      expect(pkg('{"devDependencies":{"constructor":"1","vitest":"5"}}')).toEqual(["vitest"]);
      expect(({} as Record<string, unknown>).devDependencies).toBeUndefined();
    });
    it("deeply nested JSON does not throw", () => {
      expect(pkg(`${"[".repeat(200_000)}${"]".repeat(200_000)}`)).toEqual([]);
    });
    it("test script match is word-bounded", () => {
      expect(pkg('{"scripts":{"test":"nojest run"}}')).toEqual([]);
      expect(pkg('{"scripts":{"test":"npx jest && echo"}}')).toEqual(["jest"]);
    });
  });

  describe("filesystem hazards (only regular files inside the project dir are read)", () => {
    it.skipIf(process.platform === "win32")(
      "ignores a package.json that is a symlink to a file outside",
      () => {
        const outside = proj({ "real.json": '{"devDependencies":{"jest":"1"}}' });
        const p = proj({ "x.txt": "" });
        symlinkSync(join(outside.root, "real.json"), join(p.root, "package.json"));
        expect(detectTestFrameworks(p.root, ["package.json"])).toEqual([]);
      },
    );
    it.skipIf(process.platform === "win32")(
      "does not hang on or read a FIFO named package.json",
      () => {
        const p = proj({ "x.txt": "" });
        execFileSync("mkfifo", [join(p.root, "package.json")]);
        expect(detectTestFrameworks(p.root, ["package.json"])).toEqual([]);
      },
    );
    it("rejects traversal, absolute, NUL and drive paths in the file list instead of reading them", () => {
      const outside = proj({ "package.json": '{"devDependencies":{"jest":"1"}}' });
      const p = proj({ "x.txt": "" });
      const evil = [
        "../package.json",
        `${outside.root}/package.json`,
        "package.json\0",
        "C:package.json",
        "./package.json",
      ];
      expect(detectTestFrameworks(p.root, evil)).toEqual([]);
    });
    it("a missing project directory yields nothing", () => {
      expect(
        detectTestFrameworks(join(tmpdir(), "eq-does-not-exist-xyz"), ["package.json"]),
      ).toEqual([]);
    });
  });

  it("accepts Windows separators in the list (matching only) and ignores nested package.json", () => {
    const p = proj({
      "package.json": '{"devDependencies":{"jest":"1"}}',
      "sub/package.json": '{"devDependencies":{"mocha":"1"}}',
    });
    expect(
      detectTestFrameworks(p.root, ["package.json", "sub\\package.json", "sub\\a_test.go"]).map(
        (f) => f.name,
      ),
    ).toEqual(["go-test", "jest"]);
  });
  it("aborting between manifest reads stops promptly without throwing", () => {
    const p = proj({
      "requirements-a.txt": "flask\n",
      "requirements-b.txt": "pytest\n",
    });
    expect(names(p)).toEqual(["pytest"]); // the control: unaborted, the second manifest is read
    // `aborted` flips to true after two checks: before the first read, then the loop's first check.
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 2;
      },
    } as unknown as AbortSignal;
    expect(() => detectTestFrameworks(p.root, p.files, signal)).not.toThrow();
    expect(detectTestFrameworks(p.root, p.files, signal)).toEqual([]);
  });
  it("stops reading when the signal is aborted", () => {
    const p = proj({ "package.json": '{"devDependencies":{"jest":"1"}}' });
    const ac = new AbortController();
    ac.abort();
    expect(detectTestFrameworks(p.root, p.files, ac.signal)).toEqual([]);
  });
  it("is linear on 100k files", () => {
    const p = proj({ "package.json": '{"devDependencies":{"jest":"1"}}' });
    const many = [...p.files];
    for (let i = 0; i < 100_000; i++) many.push(`src/f${i}.ts`);
    const t = Date.now();
    expect(detectTestFrameworks(p.root, many).map((f) => f.name)).toEqual(["jest"]);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
