import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `gen` is deliberately not skipped: apps/web/app/gen and packages/*/src/gen must still be scanned.
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "target", ".git"]);
const ALLOWED_PERMISSIONS = new Set([
  "core:default",
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "dialog:allow-open",
]);
const DIALOG_CRATE = "tauri-plugin-dialog";
const DIALOG_PACKAGE = "@tauri-apps/plugin-dialog";

export const FORBIDDEN_CJK = [
  "大白话",
  "白话",
  "白話",
  "自研模型",
  "自研大模型",
  "自研的模型",
  "智谱",
  "豆包",
];
// Case-insensitive plain substrings (no word boundary) for names that occur inside longer words.
export const FORBIDDEN_SUBSTRINGS = ["ChatGPT"];
const FORBIDDEN_NAMES = [
  "Semgrep",
  "Trivy",
  "Gitleaks",
  "OSV",
  "Snyk",
  "SonarQube",
  "CodeQL",
  "Bandit",
  "Grype",
  "Syft",
  "TruffleHog",
  "OpenAI",
  "Anthropic",
  "Claude",
  "GPT",
  "Gemini",
  "DeepSeek",
  "Qwen",
  "Kimi",
  "Llama",
  "Mistral",
  "Ollama",
  "LM Studio",
  "B.AI",
  "Understand Anything",
  "Agentic QE",
  "agentic-qe",
  "reverse-skill",
  "Playwright",
  "GLM",
  "MiniMax",
  "vLLM",
];
// Whole-word and case-SENSITIVE: the lowercase forms are ordinary words or CSS
// (`cursor: pointer`, a haiku, an opus), so only the capitalised product spelling is flagged.
const FORBIDDEN_CASED_NAMES = ["Sonnet", "Haiku", "Opus", "Codex", "Copilot", "Cursor"];
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (n, flags) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(n)}(?![A-Za-z0-9])`, flags);
export const NAME_PATTERNS = [
  ...FORBIDDEN_NAMES.map((n) => ({ label: n, re: wholeWord(n, "i") })),
  ...FORBIDDEN_CASED_NAMES.map((n) => ({ label: n, re: wholeWord(n, "") })),
];

// A readdir error on the scan root throws (callers report it as a violation, never a silent pass);
// errors in subdirectories (for example one removed mid-scan) are ignored.
function* walk(dir, isRoot = true) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isRoot) throw error;
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name), false);
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

// Every file under a scan root. A missing or unreadable root, and an empty result, are violations.
function collect(root, relDir, violations) {
  try {
    const files = [...walk(join(root, relDir))];
    if (files.length === 0) violations.push(`${relDir} has no files to scan`);
    return files;
  } catch {
    violations.push(`${relDir} is missing or unreadable`);
    return [];
  }
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

// Rust source with `mod tests { ... }` blocks (with or without #[cfg(test)]) blanked out, lines preserved.
function stripRustTestModules(text) {
  let out = text;
  const start = /(?:#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*)?(?:pub\s+)?\bmod\s+tests\s*\{/g;
  for (let m = start.exec(out); m; m = start.exec(out)) {
    const close = matchingBrace(out, m.index + m[0].length - 1);
    if (close === -1) break;
    out =
      out.slice(0, m.index) +
      out.slice(m.index, close + 1).replace(/[^\n]/g, " ") +
      out.slice(close + 1);
    start.lastIndex = close + 1;
  }
  return out;
}

const read = (root, rel) => {
  const file = join(root, rel);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const rel = (root, file) => relative(root, file).split("\\").join("/");
const quoted = (text) => [...text.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
const duplicates = (list) => list.filter((item, i) => list.indexOf(item) !== i);
const isTestPath = (path) =>
  /(^|\/)(test|tests|__tests__)\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);
// The website is stricter: only files that are tests by name, or under __tests__, are exempt.
const isWebTestPath = (path) =>
  /(^|\/)__tests__\//.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path);

const TS_METHODS = "packages/audit-core/src/methods.ts";
const RS_METHODS = "apps/desktop/src-tauri/src/allowlist.rs";
const TAURI_DIR = "apps/desktop/src-tauri";

function checkAllowlistParity(root) {
  const violations = [];
  const ts = read(root, TS_METHODS);
  const rs = read(root, RS_METHODS);
  if (ts === null) violations.push(`${TS_METHODS} is missing`);
  if (rs === null) violations.push(`${RS_METHODS} is missing`);
  if (ts === null || rs === null) return violations;

  const tsMatch = ts.match(/IPC_METHODS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const rsMatch = rs.match(/ALLOWED_METHODS:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/);
  if (!tsMatch) violations.push(`could not read the IPC_METHODS array in ${TS_METHODS}`);
  if (!rsMatch) violations.push(`could not read the ALLOWED_METHODS array in ${RS_METHODS}`);
  if (!tsMatch || !rsMatch) return violations;

  const tsList = quoted(tsMatch[1]);
  const rsList = quoted(rsMatch[2]);
  for (const d of duplicates(tsList)) violations.push(`duplicate method in ${TS_METHODS}: ${d}`);
  for (const d of duplicates(rsList)) violations.push(`duplicate method in ${RS_METHODS}: ${d}`);
  for (const m of rsList)
    if (!tsList.includes(m))
      violations.push(`${m} is allowed in Rust but missing from IPC_METHODS`);
  for (const m of tsList)
    if (!rsList.includes(m))
      violations.push(`${m} is in IPC_METHODS but missing from the Rust allowlist`);
  if (Number(rsMatch[1]) !== rsList.length) {
    violations.push(
      `the Rust array declares length ${rsMatch[1]} but lists ${rsList.length} methods`,
    );
  }
  for (const m of new Set([...tsList, ...rsList])) {
    if (/^shell/.test(m) || /\.exec$/.test(m))
      violations.push(`${m}: arbitrary command execution must never be exposed`);
  }
  violations.push(...checkAllowlistFile(rs));
  return violations;
}

// The allowlist file holds exactly one [&str; N] array and is_allowed is a plain membership test.
function checkAllowlistFile(rs) {
  const violations = [];
  const arrays = rs.match(/\[\s*&\s*(?:'static\s+)?str\s*;[^\]]*\]/g) ?? [];
  if (arrays.length !== 1) {
    violations.push(
      `${RS_METHODS} must hold only one [&str; N] array (ALLOWED_METHODS), found ${arrays.length}`,
    );
  }
  const fns = [...rs.matchAll(/\bfn\s+is_allowed\b/g)];
  if (fns.length !== 1) {
    violations.push(`${RS_METHODS} must define is_allowed exactly once, found ${fns.length}`);
    return violations;
  }
  const open = rs.indexOf("{", fns[0].index);
  const close = open === -1 ? -1 : matchingBrace(rs, open);
  if (close === -1) {
    violations.push(`could not read the body of is_allowed in ${RS_METHODS}`);
    return violations;
  }
  const body = rs.slice(open + 1, close);
  if (body.replace(/\s+/g, "") !== "ALLOWED_METHODS.contains(&method)") {
    violations.push(
      `is_allowed in ${RS_METHODS} must be exactly ALLOWED_METHODS.contains(&method), found: ${body.trim()}`,
    );
  }
  return violations;
}

function updaterScanFiles(root, violations) {
  const files = [];
  for (const file of collect(root, "apps/desktop", violations)) {
    const path = rel(root, file);
    const name = basename(file);
    const inTauri = path.startsWith(`${TAURI_DIR}/`);
    if (
      name === "Cargo.toml" ||
      name === "package.json" ||
      TAURI_CONFIG_NAME.test(name) ||
      (inTauri && path.includes("/capabilities/") && name.endsWith(".json")) ||
      (inTauri && path.includes("/src/") && name.endsWith(".rs"))
    ) {
      files.push(file);
    }
  }
  return files;
}

// tauri.conf.json (also tauri.<platform>.conf.json), the JSON5 spelling, and Tauri.toml.
const TAURI_CONFIG_NAME = /^(?:tauri(?:\..+)?\.conf\.json5?|tauri\.toml)$/i;

const missingConf = (root) =>
  ["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"].some((n) =>
    existsSync(join(root, TAURI_DIR, n)),
  )
    ? []
    : [`${TAURI_DIR}/tauri.conf.json is missing`];

function checkNoUpdater(root) {
  const violations = [...missingConf(root)];
  for (const file of updaterScanFiles(root, violations)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/updater/i.test(line))
        violations.push(`${rel(root, file)}:${i + 1}: the updater must stay disabled`);
    });
  }
  return violations;
}

function checkCapabilities(root) {
  const dir = join(root, TAURI_DIR, "capabilities");
  // Tauri loads capability files recursively, so every nested file is checked too.
  const files = existsSync(dir)
    ? [...walk(dir)]
        .map((f) => relative(dir, f).split("\\").join("/"))
        .filter((f) => /\.(json5?|toml)$/.test(f))
    : [];
  if (files.length === 0)
    return [`${TAURI_DIR}/capabilities has no capability file`, ...missingConf(root)];
  const violations = [...missingConf(root)];
  for (const name of files) {
    const path = `${TAURI_DIR}/capabilities/${name}`;
    if (!name.endsWith(".json")) {
      violations.push(`${path}: only .json capability files are allowed`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      violations.push(`${path} is not valid JSON`);
      continue;
    }
    if (data.remote !== undefined) violations.push(`${path} defines a remote block`);
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    for (const permission of permissions) {
      const id = typeof permission === "string" ? permission : permission?.identifier;
      if (!ALLOWED_PERMISSIONS.has(id))
        violations.push(`${path} grants ${id ?? JSON.stringify(permission)}`);
    }
  }
  for (const name of readdirSync(join(root, TAURI_DIR), { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() && (TAURI_CONFIG_NAME.test(e.name) || /^tauri(\..+)?\.conf\.toml$/.test(e.name)),
    )
    .map((e) => e.name)) {
    const path = `${TAURI_DIR}/${name}`;
    const text = readFileSync(join(root, TAURI_DIR, name), "utf8");
    let inline = /capabilities/.test(text);
    if (name.endsWith(".json")) {
      try {
        inline = JSON.parse(text)?.app?.security?.capabilities !== undefined;
      } catch {
        violations.push(`${path} is not valid JSON`);
        continue;
      }
    }
    if (inline)
      violations.push(`${path} declares inline capabilities; use capabilities/*.json only`);
  }
  return violations;
}

function checkPlugins(root) {
  const violations = [];
  const cargo = read(root, `${TAURI_DIR}/Cargo.toml`);
  if (cargo === null) violations.push(`${TAURI_DIR}/Cargo.toml is missing`);
  else {
    for (const crate of new Set(cargo.match(/tauri-plugin-[a-z0-9_-]+/g) ?? [])) {
      if (crate !== DIALOG_CRATE)
        violations.push(`Cargo.toml uses ${crate}; only ${DIALOG_CRATE} is allowed`);
    }
  }
  const pkgText = read(root, "apps/desktop/package.json");
  if (pkgText === null) violations.push("apps/desktop/package.json is missing");
  else {
    for (const pkg of new Set(pkgText.match(/@tauri-apps\/plugin-[a-z0-9-]+/g) ?? [])) {
      if (pkg !== DIALOG_PACKAGE)
        violations.push(`package.json uses ${pkg}; only ${DIALOG_PACKAGE} is allowed`);
    }
  }
  return violations;
}

// Rust source with comments and string/char-literal contents blanked out (lines preserved), so a
// call that is only mentioned in a comment or a string does not count, and a `'('` / `')'` char
// literal cannot desync the balanced-paren scan. One left-to-right pass, so a quote that is part of
// another token (`'"'`, `"//"`, `"'"`) is never mistaken for the start of one. A char literal is one
// character or one escape between quotes; lifetimes (`&'a str`, `'static`, `<'a>`) have no closing
// quote one character later, so they never match and stay untouched. The `u` flag makes an astral
// character (`'😀'`, two UTF-16 units) one character; blanking below still works per UTF-16 unit, so offsets hold.
const RUST_TOKEN =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.))'/gu;
function stripRustCommentsAndStrings(text) {
  return text.replace(RUST_TOKEN, (m) => {
    const blank = (inner) => inner.replace(/[^\n]/g, " ");
    if (m.startsWith("/")) return blank(m);
    return `${m[0]}${blank(m.slice(1, -1))}${m[0]}`;
  });
}

function fnBody(text, name) {
  const m = new RegExp(`\\bfn\\s+${name}\\b`).exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index);
  const close = open === -1 ? -1 : matchingBrace(text, open);
  return close === -1 ? null : text.slice(open + 1, close);
}

// Index of the `)` matching the `(` at `open`, or -1. The text is already comment/string-stripped.
function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

// The two accepted gate statements. Each is a sticky head ending at the call's `(`, then a balanced
// scan to the matching `)`, then a tail that must follow that `)` IMMEDIATELY:
//  - check_method(..)?;   a `?` right after the call: `.or(Ok(()))?;` or a discarded Result gates nothing
//  - if !is_allowed(..) { return   the block opens right after the condition and its first statement
//                                  is the return, so no extra condition or nested `if` weakens it
// The lookbehinds keep a match from starting mid-identifier, after `.` (a method call on something
// else) or after `else` (a conditional branch).
const GATE_FORMS = [
  { kind: "check_method", head: /(?<![\w.])check_method\s*\(/y, tail: /\s*\?\s*;/y },
  {
    kind: "is_allowed",
    head: /(?<![\w.])(?<!\belse\s+)if\s*!\s*(?:\w+::)*is_allowed\s*\(/y,
    tail: /\s*\{\s*return\b/y,
  },
];

function matchesGateAt(body, i, { head, tail }) {
  head.lastIndex = i;
  if (!head.test(body)) return false;
  const close = matchingParen(body, head.lastIndex - 1);
  if (close === -1) return false;
  tail.lastIndex = close + 1;
  return tail.test(body);
}

// Earliest gate statement at brace depth 0 of the (comment/string-stripped) function body, or null.
function findTopLevelGate(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (depth === 0) {
      for (const form of GATE_FORMS) {
        if (matchesGateAt(body, i, form)) return { index: i, kind: form.kind };
      }
    }
    if (body[i] === "{") depth += 1;
    else if (body[i] === "}") depth -= 1;
  }
  return null;
}

// ipc_call must consult the allowlist before touching the sidecar, via a top-level statement:
// `check_method(..)?;` (check_method must itself call is_allowed) or an early return on `!is_allowed(..)`.
function checkIpcGate(root) {
  const text = read(root, `${TAURI_DIR}/src/lib.rs`);
  if (text === null) return [`${TAURI_DIR}/src/lib.rs is missing`];
  const code = stripRustTestModules(stripRustCommentsAndStrings(text));
  const body = fnBody(code, "ipc_call");
  if (body === null) return [`could not find ipc_call in ${TAURI_DIR}/src/lib.rs`];
  const gate = findTopLevelGate(body);
  if (!gate) {
    return [
      "ipc_call in lib.rs must start with a top level `check_method(..)?;` (or an early return on `!is_allowed(..)`) before forwarding a request",
    ];
  }
  const violations = [];
  if (gate.kind === "check_method") {
    const gateBody = fnBody(code, "check_method");
    if (gateBody === null || !/\bis_allowed\s*\(/.test(gateBody)) {
      violations.push("check_method in lib.rs must call is_allowed (ipc_call relies on it)");
    }
  }
  const forward = /\.call\s*\(/.exec(body);
  if (forward && forward.index < gate.index) {
    violations.push("ipc_call forwards to the sidecar before the allowlist check");
  }
  return violations;
}

function checkRustSurface(root) {
  const srcDir = join(root, TAURI_DIR, "src");
  if (!existsSync(srcDir)) return [`${TAURI_DIR}/src is missing`];
  const violations = [];
  let commands = 0;
  const handlers = [];
  for (const file of walk(srcDir)) {
    if (!file.endsWith(".rs")) continue;
    const path = rel(root, file);
    const text = readFileSync(file, "utf8");
    // #[tauri::command], #[::tauri::command], #[tauri :: command], #[command] (after `use tauri::command`)
    // and cfg_attr(..., tauri::command) all count as a command.
    commands += (text.match(/#\[\s*(?:::)?(?:tauri\s*::\s*)?command\b/g) ?? []).length;
    commands += (text.match(/cfg_attr\s*\([^\]]*\bcommand\b/g) ?? []).length;
    for (const m of text.matchAll(/generate_handler\s*!\s*[[({]([\s\S]*?)[\])}]/g)) {
      handlers.push({
        path,
        names: m[1]
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
      });
    }
    if (basename(file) === "sidecar.rs") continue;
    text.split("\n").forEach((line, i) => {
      if (/\bstd::process\b|\bCommand::new\b|\badd_capability\b/.test(line)) {
        violations.push(
          `${path}:${i + 1}: process spawning and runtime capabilities belong only in sidecar.rs`,
        );
      }
    });
  }
  if (commands !== 1)
    violations.push(`expected exactly one #[tauri::command] (ipc_call), found ${commands}`);
  if (handlers.length !== 1) {
    violations.push(
      `expected exactly one generate_handler![ipc_call], found ${handlers.length} generate_handler! macros`,
    );
  }
  violations.push(...checkIpcGate(root));
  for (const { path, names } of handlers) {
    if (names.length !== 1 || names[0] !== "ipc_call") {
      violations.push(
        `${path}: generate_handler! must list exactly ipc_call, found [${names.join(", ")}]`,
      );
    }
  }
  return violations;
}

function checkNoShellExec(root) {
  const violations = [];
  let scanned = 0;
  const flag = (path, text) =>
    text.split("\n").forEach((line, i) => {
      if (line.includes("shell.exec"))
        violations.push(`${path}:${i + 1}: shell.exec must never appear in runtime code`);
    });
  for (const top of ["apps", "packages"]) {
    for (const file of collect(root, top, violations)) {
      const path = rel(root, file);
      if (path.startsWith(`${TAURI_DIR}/src/`) && path.endsWith(".rs")) {
        // Non-test Rust only: `mod tests { ... }` blocks are blanked out; tests/ is not under src/.
        scanned++;
        flag(path, stripRustTestModules(readFileSync(file, "utf8")));
        continue;
      }
      if (!/^(apps|packages)\/[^/]+\/(src|app)\//.test(path)) continue;
      if (!/\.[cm]?[jt]sx?$/.test(path) || isTestPath(path)) continue;
      scanned++;
      flag(path, readFileSync(file, "utf8"));
    }
  }
  if (scanned === 0)
    violations.push("no runtime sources found under apps/*/{src,app} or packages/*/src");
  return violations;
}

const WEB_SHARED_ROOTS = ["packages/ui/src", "packages/design-tokens/src"];
const DESKTOP_UI_ROOTS = ["apps/desktop/src"];

function checkWebCopy(root) {
  const violations = [];
  // The website also renders these shared packages, so their sources are held to the same copy rules.
  // The desktop UI (spec 35.4) is held to the same rules; the Rust shell under src-tauri is not.
  const roots = [
    "apps/web",
    ...WEB_SHARED_ROOTS.filter((r) => existsSync(join(root, r))),
    ...DESKTOP_UI_ROOTS.filter((r) => existsSync(join(root, r))),
  ];
  const files = roots.flatMap((r) => collect(root, r, violations));
  for (const file of files) {
    const path = rel(root, file);
    if (
      isWebTestPath(path) ||
      !/\.(?:[cm]?[jt]sx?|mdx?|css|html|svg|ya?ml|txt|json5?|toml)$/.test(path)
    )
      continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const term of FORBIDDEN_CJK) {
          if (line.includes(term)) violations.push(`${path}:${i + 1}: forbidden wording "${term}"`);
        }
        for (const term of FORBIDDEN_SUBSTRINGS) {
          if (line.toLowerCase().includes(term.toLowerCase()))
            violations.push(`${path}:${i + 1}: names a tool or vendor ("${term}")`);
        }
        for (const { label, re } of NAME_PATTERNS) {
          if (re.test(line))
            violations.push(`${path}:${i + 1}: names a tool or vendor ("${label}")`);
        }
      });
  }
  return violations;
}

const CHECKS = [
  ["allowlist-parity", checkAllowlistParity],
  ["no-updater", checkNoUpdater],
  ["capabilities", checkCapabilities],
  ["plugins", checkPlugins],
  ["rust-surface", checkRustSurface],
  ["no-shell-exec", checkNoShellExec],
  ["web-copy", checkWebCopy],
];

export function runChecks(root) {
  if (!existsSync(root)) {
    return CHECKS.map(([name]) => ({ name, violations: [`root ${root} does not exist`] }));
  }
  return CHECKS.map(([name, check]) => {
    try {
      return { name, violations: check(root) };
    } catch (error) {
      return {
        name,
        violations: [`check crashed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  let failed = false;
  for (const { name, violations } of runChecks(root)) {
    if (violations.length === 0) {
      console.log(`ok    ${name}`);
    } else {
      failed = true;
      console.log(`FAIL  ${name}`);
      for (const v of violations) console.log(`        ${v}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
