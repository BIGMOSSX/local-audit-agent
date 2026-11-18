import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/sandbox/env";
import {
  copyRegularFile,
  createSandbox,
  isSecretLikeName,
  listProjectFiles,
  makeWritableTree,
  SandboxError,
} from "../src/sandbox/workspace";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);
const isWindows = process.platform === "win32";

function project(files: Record<string, string>): string {
  const dir = join(realpathSync.native(makeTmp()), "proj");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("listProjectFiles", () => {
  it("returns sorted repo-relative POSIX paths and skips excluded directories", async () => {
    const dir = project({
      "src/b.ts": "b",
      "src/a.ts": "a",
      "package.json": "{}",
      ".claude/settings.json": "{}",
      ".agentic-qe/x": "x",
      ".git/HEAD": "ref",
      "node_modules/dep/index.js": "x",
      "deep/.claude/y": "y",
    });
    expect(await listProjectFiles(dir)).toEqual(["package.json", "src/a.ts", "src/b.ts"]);
  });
  it.skipIf(isWindows)("never follows symlinks", async () => {
    const dir = project({ "a.ts": "a" });
    symlinkSync("/etc", join(dir, "etc-link"));
    symlinkSync(join(dir, "a.ts"), join(dir, "a-link.ts"));
    expect(await listProjectFiles(dir)).toEqual(["a.ts"]);
  });
  it("R13: never lists secret-like files (so ProjectContext.files cannot name them)", async () => {
    const dir = project({
      "src/a.ts": "a",
      ".env": "K=v",
      ".env.production": "K=v",
      "config/.env.local": "K=v",
      id_rsa: "KEY",
      "id_ed25519.pub": "k",
      "deploy/server.PEM": "p",
      "tls/site.key": "k",
      ".npmrc": "//registry:_authToken=x",
      ".netrc": "machine x",
      "credentials.json": "{}",
      "src/environment.ts": "ok",
      "src/monkey.ts": "ok",
    });
    expect(await listProjectFiles(dir)).toEqual([
      "src/a.ts",
      "src/environment.ts",
      "src/monkey.ts",
    ]);
  });
  it("R13: never lists build output, at any depth", async () => {
    const dir = project({
      "src/a.ts": "a",
      "target/debug/x": "x",
      "dist/y.js": "y",
      ".venv/lib/z.py": "z",
      "coverage/lcov.info": "c",
      "pkg/__pycache__/p.pyc": "p",
      "pkg/dist/q.js": "q",
      ".next/cache/n": "n",
    });
    expect(await listProjectFiles(dir)).toEqual(["src/a.ts"]);
  });
  it("R13 (deferred): does not parse .gitignore yet — a gitignored non-secret file is still listed", async () => {
    const dir = project({ ".gitignore": "generated.ts\n", "generated.ts": "g" });
    expect(await listProjectFiles(dir)).toEqual([".gitignore", "generated.ts"]);
  });
  it("handles Unicode and spaces", async () => {
    const dir = project({ "目录 x/é.ts": "x" });
    expect(await listProjectFiles(dir)).toEqual(["目录 x/é.ts"]);
  });
  it("R13+: directories are subject to the secret-like and credential-store exclusions", async () => {
    const dir = project({
      "src/a.ts": "a",
      ".env/x": "K=v",
      "config/.env.d/y": "K=v",
      "credentials/z": "z",
      ".ssh/id": "k",
      ".AWS/credentials": "k",
      ".docker/config.json": "{}",
      "deep/.kube/config": "k",
      ".gnupg/pubring": "k",
      "secrets/s": "s",
    });
    expect(await listProjectFiles(dir)).toEqual(["src/a.ts"]);
  });
  it("R13+: extended secret-like file names, backup suffixes and Windows trailing dots/spaces", async () => {
    const dir = project({
      "src/a.ts": "a",
      ".git-credentials": "x",
      "secrets.yaml": "x",
      secrets: "x",
      "service-account-prod.json": "{}",
      "AuthKey_ABC.p8": "x",
      "vault.kdbx": "x",
      "server.key.bak": "x",
      "server.pem.orig": "x",
      "id_rsa.old": "x",
      "cert.p12~": "x",
      ".env.bak": "x",
      "src/secrets-manager.ts": "ok",
      "src/backup.bak": "ok",
    });
    expect(await listProjectFiles(dir)).toEqual([
      "src/a.ts",
      "src/backup.bak",
      "src/secrets-manager.ts",
    ]);
  });
  it("isSecretLikeName strips trailing dots and spaces before matching", () => {
    for (const n of [
      ".env.",
      ".env ",
      "server.key. ",
      "credentials.json.",
      "server.key.bak.",
      "id_rsa ",
    ]) {
      expect(isSecretLikeName(n)).toBe(true);
    }
    expect(isSecretLikeName("app.ts.")).toBe(false);
  });
  it.skipIf(isWindows || process.getuid?.() === 0)(
    "skips an unreadable subdirectory instead of failing",
    async () => {
      const dir = project({ "ok/a.ts": "a", "locked/b.ts": "b", "top.ts": "t" });
      chmodSync(join(dir, "locked"), 0o000);
      try {
        expect(await listProjectFiles(dir)).toEqual(["ok/a.ts", "top.ts"]);
        const sb = await createSandbox(dir);
        try {
          expect(existsSync(join(sb.projectDir, "ok/a.ts"))).toBe(true);
          expect(existsSync(join(sb.projectDir, "locked"))).toBe(false);
        } finally {
          await sb.cleanup();
        }
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }
    },
  );
  it("only ever throws SandboxError: a missing project root is io", async () => {
    const missing = join(realpathSync.native(makeTmp()), "nope");
    const err = await listProjectFiles(missing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err).toMatchObject({ code: "io" });
    await expect(createSandbox(missing)).rejects.toBeInstanceOf(SandboxError);
    await expect(createSandbox(missing)).rejects.toMatchObject({ code: "io" });
  });
  it("counts directories toward the entry cap", async () => {
    const dir = project({});
    for (const d of ["d1", "d2", "d3", "d4"]) mkdirSync(join(dir, d));
    await expect(listProjectFiles(dir, { maxFiles: 3 })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(await listProjectFiles(dir, { maxFiles: 4 })).toEqual([]);
  });
  it("throws too_large past the file cap", async () => {
    const dir = project({ a: "1", b: "2", c: "3" });
    await expect(listProjectFiles(dir, { maxFiles: 2 })).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("createSandbox", () => {
  it("creates every directory the child environment points at, all inside the sandbox", async () => {
    const dir = project({ "a.ts": "a" });
    const sb = await createSandbox(dir);
    try {
      const env = buildChildEnv(sb, {}, {});
      const keys = [
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
      ];
      for (const k of keys) {
        const p = env[k] as string;
        expect(statSync(p).isDirectory()).toBe(true);
        expect(realpathSync.native(p).startsWith(`${sb.home}${sep}`)).toBe(true);
        if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o700);
      }
      for (const k of ["TMPDIR", "HOME"])
        expect(statSync(env[k] as string).isDirectory()).toBe(true);
    } finally {
      await sb.cleanup();
    }
  });
  it("counts files over the per-file cap instead of dropping them silently", async () => {
    const dir = project({ "small.ts": "ok", "big.ts": "x".repeat(50), "big2.ts": "y".repeat(60) });
    const sb = await createSandbox(dir, { maxFileBytes: 10 });
    try {
      expect(sb.skippedLarge).toBe(2);
      expect(sb.fileCount).toBe(1);
      expect(existsSync(join(sb.projectDir, "big.ts"))).toBe(false);
    } finally {
      await sb.cleanup();
    }
    const whole = await createSandbox(dir);
    try {
      expect(whole.skippedLarge).toBe(0);
    } finally {
      await whole.cleanup();
    }
  });
  it("copies files but not .claude/.agentic-qe, and the copy is a different directory", async () => {
    const dir = project({ "src/a.ts": "hello", ".claude/x": "secret", ".agentic-qe/y": "y" });
    const sb = await createSandbox(dir);
    try {
      expect(sb.projectDir).not.toBe(dir);
      expect(readFileSync(join(sb.projectDir, "src/a.ts"), "utf8")).toBe("hello");
      expect(existsSync(join(sb.projectDir, ".claude"))).toBe(false);
      expect(existsSync(join(sb.projectDir, ".agentic-qe"))).toBe(false);
    } finally {
      await sb.cleanup();
    }
  });
  it("R13: the copy contains no secret-like files or build output", async () => {
    const dir = project({
      "src/a.ts": "a",
      ".env": "K=v",
      "config/.env.local": "K=v",
      id_rsa: "KEY",
      "target/debug/x": "x",
      "dist/y.js": "y",
      "coverage/c": "c",
    });
    const sb = await createSandbox(dir);
    try {
      for (const p of [".env", "config/.env.local", "id_rsa", "target", "dist", "coverage"]) {
        expect(existsSync(join(sb.projectDir, p))).toBe(false);
      }
      expect(readFileSync(join(sb.projectDir, "src/a.ts"), "utf8")).toBe("a");
    } finally {
      await sb.cleanup();
    }
  });
  it.skipIf(isWindows || process.getuid?.() === 0)("the copy is read-only", async () => {
    const dir = project({ "a.ts": "a" });
    const sb = await createSandbox(dir);
    try {
      expect(() => writeFileSync(join(sb.projectDir, "a.ts"), "changed")).toThrow();
      expect(() => writeFileSync(join(sb.projectDir, "new.ts"), "n")).toThrow();
    } finally {
      await sb.cleanup();
    }
  });
  it("home, cwd and tmp are inside the sandbox root and separate from the project copy", async () => {
    const sb = await createSandbox(project({ "a.ts": "a" }));
    try {
      for (const p of [sb.home, sb.cwd, sb.tmp, sb.projectDir])
        expect(p.startsWith(sb.root)).toBe(true);
      expect(new Set([sb.home, sb.cwd, sb.tmp, sb.projectDir]).size).toBe(4);
      writeFileSync(join(sb.home, "w.txt"), "ok");
      writeFileSync(join(sb.cwd, "w.txt"), "ok");
    } finally {
      await sb.cleanup();
    }
  });
  it("cleanup removes everything (even the read-only copy) and is idempotent", async () => {
    const sb = await createSandbox(project({ "a/b.ts": "x" }));
    await sb.cleanup();
    expect(existsSync(sb.root)).toBe(false);
    await expect(sb.cleanup()).resolves.toBeUndefined();
  });
  it.skipIf(isWindows)("cleanup never chmods through a symlink planted by the engine", async () => {
    const outside = join(realpathSync.native(makeTmp()), "victim");
    mkdirSync(outside);
    writeFileSync(join(outside, "f.txt"), "keep");
    chmodSync(join(outside, "f.txt"), 0o444);
    chmodSync(outside, 0o555);
    const sb = await createSandbox(project({ "a.ts": "a" }));
    symlinkSync(outside, join(sb.tmp, "dir-link"));
    symlinkSync(join(outside, "f.txt"), join(sb.tmp, "file-link"));
    await sb.cleanup();
    try {
      expect(existsSync(sb.root)).toBe(false);
      expect(statSync(outside).mode & 0o777).toBe(0o555);
      expect(statSync(join(outside, "f.txt")).mode & 0o777).toBe(0o444);
    } finally {
      chmodSync(outside, 0o755);
    }
  });
  it("cleans up after itself when the size cap is exceeded (no audit-sb-* directory remains)", async () => {
    const dir = project({ a: "1", b: "2", c: "3" });
    const scratch = realpathSync.native(makeTmp());
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = scratch;
    try {
      expect(tmpdir()).toBe(scratch);
      await expect(createSandbox(dir, { maxFiles: 2 })).rejects.toMatchObject({
        code: "too_large",
      });
      expect(readdirSync(scratch).filter((n) => n.startsWith("audit-sb-"))).toEqual([]);
      // Control: a successful sandbox does leave its directory until cleanup() runs.
      const sb = await createSandbox(dir);
      expect(readdirSync(scratch).filter((n) => n.startsWith("audit-sb-"))).toHaveLength(1);
      await sb.cleanup();
      expect(readdirSync(scratch).filter((n) => n.startsWith("audit-sb-"))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it("re-enforces the total-bytes budget on the bytes actually copied", async () => {
    const dir = project({ "a.txt": "x".repeat(100) });
    const dest = join(dir, "..", "out");
    const tight = { remaining: 50 };
    await expect(copyRegularFile(join(dir, "a.txt"), dest, 1024, tight)).rejects.toMatchObject({
      code: "too_large",
    });
    expect(existsSync(dest)).toBe(false);
    const roomy = { remaining: 150 };
    await copyRegularFile(join(dir, "a.txt"), dest, 1024, roomy);
    expect(roomy.remaining).toBe(50);
  });
  it("reports the bytes actually copied", async () => {
    const sb = await createSandbox(project({ "a.txt": "12345", "b/c.txt": "123" }));
    try {
      expect(sb.bytes).toBe(8);
      expect(sb.fileCount).toBe(2);
    } finally {
      await sb.cleanup();
    }
  });
  it.skipIf(isWindows)(
    "makeWritableTree leaves file and directory symlink targets untouched, at depth",
    async () => {
      const outside = join(realpathSync.native(makeTmp()), "victim");
      mkdirSync(join(outside, "sub"), { recursive: true });
      writeFileSync(join(outside, "f.txt"), "keep");
      chmodSync(join(outside, "f.txt"), 0o444);
      chmodSync(join(outside, "sub"), 0o555);
      chmodSync(outside, 0o555);
      const tree = join(realpathSync.native(makeTmp()), "tree");
      mkdirSync(join(tree, "inner"), { recursive: true });
      writeFileSync(join(tree, "inner", "ro.txt"), "x");
      chmodSync(join(tree, "inner", "ro.txt"), 0o444);
      symlinkSync(outside, join(tree, "dir-link"));
      symlinkSync(join(outside, "f.txt"), join(tree, "inner", "file-link"));
      symlinkSync(join(outside, "sub"), join(tree, "inner", "sub-link"));
      chmodSync(join(tree, "inner"), 0o555);
      try {
        await makeWritableTree(tree);
        expect(statSync(join(tree, "inner")).mode & 0o777).toBe(0o700);
        expect(statSync(join(tree, "inner", "ro.txt")).mode & 0o777).toBe(0o600);
        expect(statSync(outside).mode & 0o777).toBe(0o555);
        expect(statSync(join(outside, "sub")).mode & 0o777).toBe(0o555);
        expect(statSync(join(outside, "f.txt")).mode & 0o777).toBe(0o444);
      } finally {
        chmodSync(join(outside, "sub"), 0o755);
        chmodSync(outside, 0o755);
      }
    },
  );

  it.skipIf(isWindows)(
    "TOCTOU: copyRegularFile refuses a path that became a symlink after the walk",
    async () => {
      const dir = project({ "a.ts": "real", "secret.txt": "TOPSECRET" });
      const dest = join(dir, "..", "out.ts");
      const target = join(dir, "a.ts");
      // Simulate the swap: the walk saw a regular file, then the path was replaced by a symlink.
      const { rmSync } = await import("node:fs");
      rmSync(target);
      symlinkSync(join(dir, "secret.txt"), target);
      await expect(copyRegularFile(target, dest, 1024)).rejects.toMatchObject({ code: "io" });
      expect(existsSync(dest)).toBe(false);
    },
  );
  it("TOCTOU: copyRegularFile refuses a directory and a file that grew past the cap", async () => {
    const dir = project({ "big.txt": "x".repeat(100), "d/f": "f" });
    await expect(
      copyRegularFile(join(dir, "d"), join(dir, "..", "o1"), 1024),
    ).rejects.toMatchObject({ code: "io" });
    await expect(
      copyRegularFile(join(dir, "big.txt"), join(dir, "..", "o2"), 10),
    ).rejects.toMatchObject({ code: "io" });
  });
  it("skips (does not fail on) a single file over the per-file cap", async () => {
    const dir = project({ "big.bin": "x".repeat(2048), "ok.ts": "ok" });
    const sb = await createSandbox(dir, { maxFileBytes: 1024 });
    try {
      expect(existsSync(join(sb.projectDir, "big.bin"))).toBe(false);
      expect(existsSync(join(sb.projectDir, "ok.ts"))).toBe(true);
    } finally {
      await sb.cleanup();
    }
  });
});
