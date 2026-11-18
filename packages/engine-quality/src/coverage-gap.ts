import { toPosix } from "./paths";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/;
const IGNORED_DIR = /(^|\/)(node_modules|dist|build|coverage|vendor|__pycache__|\.next|target)\//;
// Test-only and tooling folders: never reported as missing a test, and nothing in them is a test
// unless its file name says so.
const NON_SOURCE_DIR = /(^|\/)(tests?|__tests__|spec|__mocks__|__fixtures__|e2e|cypress)\//;
const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["test", "tests", "__tests__", "spec"]);
// File names so common that a test in another folder says nothing about this one.
const GENERIC_STEMS: ReadonlySet<string> = new Set(["index", "main", "mod", "__init__"]);

function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
function stem(file: string): string {
  return file.replace(/\.(test|spec|e2e-spec|cy)(?=\.)/, "").replace(/\.[^.]+$/, "");
}
// A test is recognised by its name only; living in a test folder is not enough.
function isTestFile(path: string): boolean {
  const b = base(path);
  return (
    /\.(test|spec|e2e-spec|cy)\.[a-z]+$/.test(b) ||
    /^test_.+\.py$/.test(b) ||
    /_test\.(py|go)$/.test(b)
  );
}
// NFC so a name typed on one OS matches its test written on another (macOS stores NFD).
function testedStem(path: string): string {
  return stem(base(path))
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .normalize("NFC");
}
// The folder a test is "about": a test inside a test sibling folder (`x/__tests__/a.test.ts`) covers `x/`.
function coveredDir(testPath: string): string {
  const d = dir(testPath);
  const last = d.slice(d.lastIndexOf("/") + 1);
  return TEST_DIR_NAMES.has(last) ? dir(d) : d;
}
function isCandidate(path: string): boolean {
  const b = base(path);
  if (!SOURCE.test(b) || IGNORED_DIR.test(path) || NON_SOURCE_DIR.test(path)) return false;
  if (b.startsWith(".")) return false; // dotfile tool configs such as .eslintrc.js
  if (/\.d\.[mc]?ts$/.test(b) || /\.config\.[a-z]+$/.test(b) || /\.stories\.[a-z]+$/.test(b)) {
    return false;
  }
  return !/^(setup|conftest|__init__|__main__)\./.test(b);
}

/**
 * Heuristic by file name only; Rust is skipped because its tests are usually inline. Windows
 * separators are accepted for matching; the result is sorted, de-duplicated POSIX paths.
 */
export function findUntestedFiles(files: readonly string[]): string[] {
  const posix = new Set<string>();
  for (const f of files) if (typeof f === "string") posix.add(toPosix(f));
  const tested = new Set<string>();
  const testedGeneric = new Set<string>();
  const candidates: string[] = [];
  for (const f of posix) {
    if (isTestFile(f)) {
      const s = testedStem(f);
      if (GENERIC_STEMS.has(s)) testedGeneric.add(`${coveredDir(f)}\0${s}`);
      else tested.add(s);
    } else if (isCandidate(f)) candidates.push(f);
  }
  return candidates
    .filter((f) => {
      const s = stem(base(f)).normalize("NFC");
      return GENERIC_STEMS.has(s) ? !testedGeneric.has(`${dir(f)}\0${s}`) : !tested.has(s);
    })
    .sort();
}
