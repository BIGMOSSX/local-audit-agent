import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { RepoPathSchema } from "@audit/audit-core";
import { toPosix } from "./paths";

export interface FrameworkInfo {
  readonly name: string;
  readonly evidence: string;
}

const MAX_BYTES = 1024 * 1024;
const MAX_SCRIPT_CHARS = 20_000;
const MAX_MANIFESTS = 20;
const RELEVANT =
  /(^|\/)conftest\.py$|_test\.go$|^(package\.json|Cargo\.toml|pytest\.ini|pyproject\.toml|Pipfile|setup\.cfg|pom\.xml|build\.gradle(\.kts)?|requirements[^/]*\.txt)$/;

/**
 * Reads a small regular file below `root`. Returns null for anything else: unsafe relative path,
 * a symlink anywhere on the way, a FIFO/device/directory, oversize, or any I/O error. Never throws.
 */
function readSmall(root: string, rel: string): string | null {
  if (!RepoPathSchema.safeParse(rel).success) return null;
  let fd: number | null = null;
  try {
    const full = join(root, ...rel.split("/"));
    if (!lstatSync(full).isFile()) return null;
    // A symlink in any component (or in `rel` itself) changes the resolved path.
    if (realpathSync(full) !== join(realpathSync(root), ...rel.split("/"))) return null;
    fd = openSync(
      full,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString("utf8", 0, got).replace(/^\uFEFF/, "");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing useful to do
      }
    }
  }
}

const NODE_FRAMEWORKS: readonly [string, string][] = [
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["mocha", "mocha"],
  ["ava", "ava"],
  ["playwright", "@playwright/test"],
  ["cypress", "cypress"],
];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function node(root: string, files: ReadonlySet<string>): FrameworkInfo[] {
  if (!files.has("package.json")) return [];
  const text = readSmall(root, "package.json");
  if (text === null) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isPlain(pkg)) return [];
  // Only own, plain-object fields are read; parsed objects are never merged or spread.
  const own = (o: Record<string, unknown>, k: string): unknown =>
    Object.hasOwn(o, k) ? o[k] : undefined;
  const deps = new Set<string>();
  for (const group of [own(pkg, "dependencies"), own(pkg, "devDependencies")]) {
    if (isPlain(group)) for (const k of Object.keys(group)) deps.add(k);
  }
  const scripts = own(pkg, "scripts");
  const script = isPlain(scripts) ? own(scripts, "test") : undefined;
  const scriptText = typeof script === "string" ? script.slice(0, MAX_SCRIPT_CHARS) : "";
  const out: FrameworkInfo[] = [];
  for (const [name, dep] of NODE_FRAMEWORKS) {
    if (deps.has(dep)) out.push({ name, evidence: `package.json dependency ${dep}` });
    else if (new RegExp(`(^|[\\s;&|])${name}(\\s|$)`).test(scriptText)) {
      out.push({ name, evidence: "package.json scripts.test" });
    }
  }
  return out;
}

function python(
  root: string,
  files: ReadonlySet<string>,
  sorted: readonly string[],
  signal?: AbortSignal,
): FrameworkInfo[] {
  if (
    files.has("pytest.ini") ||
    sorted.some((f) => f === "conftest.py" || f.endsWith("/conftest.py"))
  ) {
    return [{ name: "pytest", evidence: "conftest.py / pytest.ini" }];
  }
  const manifests = sorted
    .filter(
      (x) =>
        x === "pyproject.toml" ||
        /^requirements[^/]*\.txt$/.test(x) ||
        x === "Pipfile" ||
        x === "setup.cfg",
    )
    .slice(0, MAX_MANIFESTS);
  for (const f of manifests) {
    if (signal?.aborted) return [];
    if (/pytest/i.test(readSmall(root, f) ?? "")) return [{ name: "pytest", evidence: f }];
  }
  return [];
}

function others(
  root: string,
  files: ReadonlySet<string>,
  sorted: readonly string[],
  signal?: AbortSignal,
): FrameworkInfo[] {
  const out: FrameworkInfo[] = [];
  if (sorted.some((f) => f.endsWith("_test.go")))
    out.push({ name: "go-test", evidence: "*_test.go" });
  if (files.has("Cargo.toml")) out.push({ name: "cargo-test", evidence: "Cargo.toml" });
  for (const f of sorted.filter((x) => x === "pom.xml" || /^build\.gradle(\.kts)?$/.test(x))) {
    if (signal?.aborted) break;
    if (/junit/i.test(readSmall(root, f) ?? "")) {
      out.push({ name: "junit", evidence: f });
      break;
    }
  }
  return out;
}

/**
 * Detects test frameworks from well-known manifests. `rootDir` must be the sandbox copy. Entries of
 * `files` that are not clean repo-relative paths are ignored; `\` is treated as `/` for matching.
 * Never throws; stops reading when `signal` is aborted.
 */
export function detectTestFrameworks(
  rootDir: string,
  files: readonly string[],
  signal?: AbortSignal,
): FrameworkInfo[] {
  if (signal?.aborted) return [];
  const clean = new Set<string>();
  for (const f of files) {
    if (typeof f !== "string" || f.length > 1024) continue;
    const p = toPosix(f);
    // Cheap name filter first so a very large list is not schema-validated entry by entry.
    if (RELEVANT.test(p) && RepoPathSchema.safeParse(p).success) clean.add(p);
  }
  const sorted = [...clean].sort();
  const found = [
    ...node(rootDir, clean),
    ...python(rootDir, clean, sorted, signal),
    ...others(rootDir, clean, sorted, signal),
  ];
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
