import { constants, type Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeLocations } from "./env";

export class SandboxError extends Error {
  constructor(
    readonly code: "too_large" | "io",
    message: string,
  ) {
    super(message);
  }
}

export interface SandboxLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}
const DEFAULT_LIMITS: SandboxLimits = {
  maxFiles: 20_000,
  maxBytes: 200 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
};
// R13: directories never copied or listed, at any depth (lower-case compare).
const EXCLUDED_DIRS = new Set([
  ".claude",
  ".agentic-qe",
  ".git",
  ".ua",
  ".idea",
  ".vscode",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".gradle",
  // Credential stores that live in a home directory but are often checked into or copied under a project.
  ".ssh",
  ".aws",
  ".docker",
  ".kube",
  ".gnupg",
]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".p8", ".kdbx"];
const SECRET_NAMES = new Set([".npmrc", ".netrc", ".pypirc", ".htpasswd", ".git-credentials"]);
const BACKUP_SUFFIXES = [".bak", ".orig", ".old", "~"];

function stripTrailingDotsAndSpaces(n: string): string {
  return n.replace(/[. ]+$/, "");
}

function matchesSecretPattern(n: string): boolean {
  return (
    n.startsWith(".env") ||
    n.startsWith("credentials") ||
    n === "secrets" ||
    n.startsWith("secrets.") ||
    /^service-account.*\.json$/.test(n) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) ||
    SECRET_NAMES.has(n) ||
    SECRET_SUFFIXES.some((s) => n.endsWith(s))
  );
}

/**
 * Names are compared case-insensitively with trailing dots/spaces removed (Windows ignores them), and
 * editor/backup suffixes are peeled off so `server.key.bak` is as secret as `server.key`.
 */
export function isSecretLikeName(name: string): boolean {
  let n = stripTrailingDotsAndSpaces(name.toLowerCase());
  for (;;) {
    if (matchesSecretPattern(n)) return true;
    const suffix = BACKUP_SUFFIXES.find((s) => n.endsWith(s));
    if (suffix === undefined) return false;
    n = stripTrailingDotsAndSpaces(n.slice(0, -suffix.length));
  }
}

// Directories get the secret-name check too: a directory called `.env` or `credentials` is as sensitive as a file.
function excluded(name: string, isDir: boolean): boolean {
  if (isDir && EXCLUDED_DIRS.has(stripTrailingDotsAndSpaces(name.toLowerCase()))) return true;
  return isSecretLikeName(name);
}

function ioError(): SandboxError {
  return new SandboxError("io", "The project could not be copied.");
}

/** Anything thrown by the sandbox layer is a SandboxError; unknown failures become `io`. */
function asSandboxError(err: unknown): SandboxError {
  return err instanceof SandboxError ? err : ioError();
}

/**
 * Copies one regular file without following a symlink swapped in after the directory walk.
 * `budget`, when given, is the remaining total-byte allowance: the bytes actually read are charged to it
 * and SandboxError("too_large") is thrown if they exceed it.
 */
export async function copyRegularFile(
  src: string,
  dest: string,
  maxBytes: number,
  budget?: { remaining: number },
): Promise<void> {
  try {
    if (!(await lstat(src)).isFile()) throw new Error("not a regular file");
    const fh = await open(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > maxBytes)
        throw new Error("not a regular file or grew past the cap");
      const data = await fh.readFile();
      if (data.length > maxBytes) throw new Error("grew past the cap while reading");
      if (budget !== undefined) {
        if (data.length > budget.remaining) {
          throw new SandboxError("too_large", "The project is too large to analyse in isolation.");
        }
        budget.remaining -= data.length;
      }
      await writeFile(dest, data, { mode: 0o600 });
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof SandboxError && err.code === "too_large") throw err;
    throw new SandboxError("io", "The project changed while it was being copied.");
  }
}

interface Entry {
  rel: string;
  abs: string;
  size: number;
}

async function readEntries(abs: string, isRoot: boolean): Promise<Dirent[] | null> {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // An unreadable subdirectory (common with Docker volumes) is skipped; an unreadable root is an error.
    if (!isRoot && (code === "EACCES" || code === "EPERM")) return null;
    throw ioError();
  }
}

async function walk(
  root: string,
  limits: SandboxLimits,
): Promise<{ files: Entry[]; dirs: string[]; skippedLarge: number }> {
  const files: Entry[] = [];
  const dirs: string[] = [];
  let bytes = 0;
  let skippedLarge = 0;
  const tooLarge = () =>
    new SandboxError("too_large", "The project is too large to analyse in isolation.");
  async function visit(abs: string, rel: string): Promise<void> {
    const entries = await readEntries(abs, rel === "");
    if (entries === null) return;
    if (rel !== "") {
      dirs.push(rel);
      // Directories count toward the entry cap so a tree of empty directories cannot exhaust the disk or stack.
      if (files.length + dirs.length > limits.maxFiles) throw tooLarge();
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || excluded(e.name, e.isDirectory())) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await visit(childAbs, childRel);
      } else if (e.isFile()) {
        const size = (await lstat(childAbs)).size;
        if (size > limits.maxFileBytes) {
          // Not copied and not listed, so no engine will see it: counted so the run can say so.
          skippedLarge += 1;
          continue;
        }
        bytes += size;
        if (files.length + dirs.length + 1 > limits.maxFiles || bytes > limits.maxBytes) {
          throw tooLarge();
        }
        files.push({ rel: childRel, abs: childAbs, size });
      }
    }
  }
  try {
    await visit(root, "");
  } catch (err) {
    throw asSandboxError(err);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, dirs, skippedLarge };
}

export async function listProjectFiles(
  root: string,
  limits: Partial<SandboxLimits> = {},
): Promise<string[]> {
  return (await walk(root, { ...DEFAULT_LIMITS, ...limits })).files.map((f) => f.rel);
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly tmp: string;
  readonly projectDir: string;
  readonly fileCount: number;
  readonly bytes: number;
  /** Regular files over the per-file cap that were left out of the copy. */
  readonly skippedLarge: number;
  cleanup(): Promise<void>;
}

/**
 * Sets `mode` on a path without following a symlink at the final component. On POSIX the mode is applied
 * through a descriptor opened with O_NOFOLLOW (and O_DIRECTORY for directories) and the descriptor's type is
 * re-checked, so a path swapped for a symlink/other type between readdir and chmod is skipped
 * (ELOOP/ENOTDIR/ENOENT/type mismatch). An entry the owner cannot open (mode 000) falls back to
 * lstat + chmod. Windows has no O_NOFOLLOW; there the walk's Dirent type is the only guard and plain chmod
 * is used. Residual: an intermediate path component swapped for a symlink is not detected.
 */
async function chmodNoFollow(p: string, mode: number, kind: "file" | "dir"): Promise<boolean> {
  const typeOk = (st: { isFile(): boolean; isDirectory(): boolean }) =>
    kind === "dir" ? st.isDirectory() : st.isFile();
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    return chmod(p, mode).then(
      () => true,
      () => false,
    );
  }
  try {
    const fh = await open(
      p,
      constants.O_RDONLY | noFollow | (kind === "dir" ? (constants.O_DIRECTORY ?? 0) : 0),
    );
    try {
      if (!typeOk(await fh.stat())) return false;
      await fh.chmod(mode);
      return true;
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EACCES") return false;
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !typeOk(st)) return false;
      await chmod(p, mode);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Restores owner write permission across a sandbox tree so it can be removed. Cleanup assumes the engine
 * process group is already dead; the descriptor-based chmod is defence in depth against a symlink planted
 * in the writable home/cwd/tmp (it must never be followed to a user file or directory).
 */
export async function makeWritableTree(dir: string): Promise<void> {
  if (!(await chmodNoFollow(dir, 0o700, "dir"))) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await makeWritableTree(p);
    else if (e.isFile()) await chmodNoFollow(p, 0o600, "file");
  }
}

export async function createSandbox(
  projectDir: string,
  limits: Partial<SandboxLimits> = {},
): Promise<Sandbox> {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  let made: string;
  try {
    made = await mkdtemp(join(tmpdir(), "audit-sb-"));
  } catch {
    throw ioError();
  }
  let root: string;
  try {
    // Resolved so engines see the same path a symlink-resolving server reports (matched by exact prefix).
    root = await realpath(made);
  } catch {
    await rm(made, { recursive: true, force: true }).catch(() => undefined);
    throw ioError();
  }
  const cleanup = async () => {
    await makeWritableTree(root);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const [home, cwd, tmp, copy] = ["home", "cwd", "tmp", "project"].map((n) => join(root, n)) as [
      string,
      string,
      string,
      string,
    ];
    for (const d of [home, cwd, tmp, copy]) await mkdir(d, { recursive: true, mode: 0o700 });
    // The child's HOME-relative variables point here: they must exist so a tool does not fall back to
    // creating them elsewhere or fail on a missing directory.
    for (const d of Object.values(homeLocations(home))) {
      await mkdir(d, { recursive: true, mode: 0o700 });
    }
    const { files, dirs, skippedLarge } = await walk(projectDir, merged);
    for (const d of dirs) await mkdir(join(copy, d), { recursive: true });
    // The walk-time sizes were already capped; re-enforce the total on the bytes actually copied.
    const budget = { remaining: merged.maxBytes };
    for (const f of files) {
      await copyRegularFile(f.abs, join(copy, f.rel), merged.maxFileBytes, budget);
    }
    for (const f of files) await chmod(join(copy, f.rel), 0o444);
    for (const d of [...dirs].sort((a, b) => b.length - a.length))
      await chmod(join(copy, d), 0o555);
    await chmod(copy, 0o555);
    return {
      root,
      home,
      cwd,
      tmp,
      projectDir: copy,
      fileCount: files.length,
      bytes: merged.maxBytes - budget.remaining,
      skippedLarge,
      cleanup,
    };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw asSandboxError(err);
  }
}
