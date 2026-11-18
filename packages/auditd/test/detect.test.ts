import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/detect";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Fresh real directory named `name` under a temp root; returns its real path. */
function project(name: string, files: Record<string, string> = {}): string {
  const dir = join(realpathSync.native(makeTmp()), name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

describe("detectProject: identity", () => {
  it("handles spaces, parentheses and Unicode in the path", async () => {
    const dir = project("AI软件安全审计项目开发 (副本) é", { "package.json": "{}" });
    const result = await detectProject(dir);
    expect(result.path).toBe(dir);
    expect(result.name).toBe("AI软件安全审计项目开发 (副本) é");
    expect(result.ecosystems).toEqual(["node"]);
  });

  it("accepts a trailing slash", async () => {
    const dir = project("p");
    expect((await detectProject(`${dir}/`)).path).toBe(dir);
  });

  it.skipIf(isWindows)("reports one project for a symlink and its target", async () => {
    const dir = project("real", { "package.json": "{}" });
    const link = join(realpathSync(makeTmp()), "alias");
    symlinkSync(dir, link);
    const viaLink = await detectProject(link);
    expect(viaLink.path).toBe(dir);
    expect(viaLink).toEqual(await detectProject(dir));
  });
});

describe("detectProject: ecosystems", () => {
  it("an empty folder is valid and recognises nothing", async () => {
    expect(await detectProject(project("empty"))).toEqual({
      path: expect.any(String),
      name: "empty",
      ecosystems: [],
      packageManager: null,
      isMonorepo: false,
      isGitRepo: false,
    });
  });

  it.each([
    ["python", "pyproject.toml"],
    ["python", "requirements.txt"],
    ["python", "setup.py"],
    ["python", "Pipfile"],
    ["rust", "Cargo.toml"],
    ["go", "go.mod"],
    ["java", "pom.xml"],
    ["java", "build.gradle"],
    ["java", "build.gradle.kts"],
    ["java", "settings.gradle"],
    ["java", "settings.gradle.kts"],
    ["dotnet", "App.sln"],
    ["dotnet", "App.csproj"],
    ["dotnet", "App.fsproj"],
    ["ruby", "Gemfile"],
    ["php", "composer.json"],
  ])("%s is recognised from %s", async (ecosystem, marker) => {
    expect((await detectProject(project("p", { [marker]: "" }))).ecosystems).toEqual([ecosystem]);
  });

  it("lists several ecosystems in the fixed order regardless of file order", async () => {
    const dir = project("poly", {
      "go.mod": "",
      "Cargo.toml": "",
      "pyproject.toml": "",
      "package.json": "{}",
    });
    expect((await detectProject(dir)).ecosystems).toEqual(["node", "python", "rust", "go"]);
  });

  it("does not look inside sub-folders", async () => {
    const dir = project("outer");
    mkdirSync(join(dir, "inner"));
    writeFileSync(join(dir, "inner", "package.json"), "{}");
    expect((await detectProject(dir)).ecosystems).toEqual([]);
  });
});

describe("detectProject: package manager", () => {
  it.each([
    ["pnpm", ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]],
    ["yarn", ["package-lock.json", "yarn.lock"]],
    ["bun", ["package-lock.json", "bun.lock"]],
    ["bun", ["bun.lockb"]],
    ["npm", ["package-lock.json"]],
    ["npm", ["npm-shrinkwrap.json"]],
    [null, []],
  ] as const)("%s from lockfiles %j", async (expected, locks) => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (const lock of locks) files[lock] = "";
    expect((await detectProject(project("p", files))).packageManager).toBe(expected);
  });

  it("the packageManager field beats lockfiles", async () => {
    const dir = project("p", {
      "package.json": '{"packageManager":"yarn@4.1.0"}',
      "pnpm-lock.yaml": "",
    });
    expect((await detectProject(dir)).packageManager).toBe("yarn");
  });

  it.each(['{"packageManager":"deno@2"}', '{"packageManager":7}', '{"packageManager":""}'])(
    "ignores an unusable packageManager field %s and falls back to lockfiles",
    async (json) => {
      const dir = project("p", { "package.json": json, "package-lock.json": "" });
      expect((await detectProject(dir)).packageManager).toBe("npm");
    },
  );

  it("is null when there is no node project, even with a stray lockfile", async () => {
    expect((await detectProject(project("p", { "yarn.lock": "" }))).packageManager).toBeNull();
  });
});

describe("detectProject: monorepo and git", () => {
  it.each(["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"])(
    "%s marks a monorepo",
    async (file) => {
      expect(
        (await detectProject(project("p", { "package.json": "{}", [file]: "" }))).isMonorepo,
      ).toBe(true);
    },
  );

  it.each([
    ['{"workspaces":["packages/*"]}', true],
    ['{"workspaces":{"packages":["packages/*"]}}', true],
    ['{"workspaces":[]}', false],
    ['{"workspaces":"packages/*"}', false],
    ['{"workspaces":{"packages":"x"}}', false],
    ['{"workspaces":null}', false],
    ["{}", false],
  ])("package.json %s → isMonorepo %s", async (json, expected) => {
    expect((await detectProject(project("p", { "package.json": json }))).isMonorepo).toBe(expected);
  });

  it("recognises .git as a directory and as a file (worktree)", async () => {
    const withDir = project("a");
    mkdirSync(join(withDir, ".git"));
    const withFile = project("b", { ".git": "gitdir: /elsewhere" });
    expect((await detectProject(withDir)).isGitRepo).toBe(true);
    expect((await detectProject(withFile)).isGitRepo).toBe(true);
    expect((await detectProject(project("c"))).isGitRepo).toBe(false);
  });
});

describe("detectProject: hostile or broken package.json never throws", () => {
  const degraded = { ecosystems: ["node"], packageManager: "npm", isMonorepo: false };

  it.each([
    ["invalid JSON", "{ not json"],
    ["empty file", ""],
    ["a JSON array", "[1,2]"],
    ["JSON null", "null"],
    ["a JSON string", '"hello"'],
  ])("%s", async (_label, content) => {
    const dir = project("p", { "package.json": content, "package-lock.json": "" });
    expect(await detectProject(dir)).toMatchObject(degraded);
  });

  it("tolerates a UTF-8 BOM", async () => {
    const dir = project("p", { "package.json": '\uFEFF{"workspaces":["a"]}' });
    expect((await detectProject(dir)).isMonorepo).toBe(true);
  });

  it("ignores a package.json larger than 1 MiB", async () => {
    const big = `{"workspaces":["a"],"pad":"${"x".repeat(1024 * 1024)}"}`;
    const result = await detectProject(
      project("p", { "package.json": big, "package-lock.json": "" }),
    );
    expect(result).toMatchObject(degraded);
  });

  it("copes with package.json being a directory", async () => {
    const dir = project("p", { "package-lock.json": "" });
    mkdirSync(join(dir, "package.json"));
    expect(await detectProject(dir)).toMatchObject(degraded);
  });

  it.skipIf(isWindows)("copes with package.json being a FIFO (never blocks)", async () => {
    const dir = project("p", { "package-lock.json": "" });
    execFileSync("mkfifo", [join(dir, "package.json")]);
    expect(await detectProject(dir)).toMatchObject(degraded);
  });
});

describe("detectProject: paths that are not projects", () => {
  const invalid = { code: "invalid_path" };

  it("rejects a folder that does not exist", async () => {
    await expect(detectProject(join(realpathSync(makeTmp()), "missing"))).rejects.toMatchObject(
      invalid,
    );
  });

  it("rejects a regular file", async () => {
    const file = join(project("p", { "notes.txt": "hi" }), "notes.txt");
    await expect(detectProject(file)).rejects.toMatchObject(invalid);
  });

  it.each(["", "relative/path", "./here", "~/Work"])("rejects %j", async (input) => {
    await expect(detectProject(input)).rejects.toMatchObject(invalid);
  });

  it.each([
    "\\\\host\\share",
    "\\\\host\\share\\repo",
    "//host/share",
    "//host/share/repo",
    "\\\\?\\UNC\\host\\share",
    "\\\\.\\pipe\\x",
    "/\\host/share",
    "\\//host/share",
  ])("rejects the network-style path %j before touching the filesystem", async (input) => {
    await expect(detectProject(input)).rejects.toMatchObject(invalid);
    await expect(detectProject(input)).rejects.toThrow(/Network folders are not supported/);
  });

  it("rejects a NUL byte and non-string input", async () => {
    await expect(detectProject("/tmp/a\0b")).rejects.toMatchObject(invalid);
    await expect(detectProject(undefined as unknown as string)).rejects.toMatchObject(invalid);
  });

  it.skipIf(isWindows)("rejects a dangling symlink", async () => {
    const link = join(realpathSync(makeTmp()), "dangling");
    symlinkSync(join(realpathSync(makeTmp()), "gone"), link);
    await expect(detectProject(link)).rejects.toMatchObject(invalid);
  });

  it.skipIf(isWindows || isRoot)("rejects a folder it is not allowed to read", async () => {
    const dir = project("locked");
    chmodSync(dir, 0o000);
    try {
      await expect(detectProject(dir)).rejects.toMatchObject(invalid);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("the error message is plain English and names the problem, not internals", async () => {
    await expect(detectProject("relative/path")).rejects.toThrow(/absolute/i);
    await expect(detectProject(join(realpathSync(makeTmp()), "missing"))).rejects.toThrow(
      /does not exist/i,
    );
  });
});
