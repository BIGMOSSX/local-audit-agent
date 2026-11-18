import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChecks } from "./check-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = join(HERE, "..");
const SCRIPT = join(HERE, "check-policy.mjs");

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "policy-"));
  baseline();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function methodsTs(methods) {
  return `export const IPC_METHODS = [\n${methods.map((m) => `  "${m}",`).join("\n")}\n] as const;\n`;
}
const IS_ALLOWED_RS =
  "\npub fn is_allowed(method: &str) -> bool {\n    ALLOWED_METHODS.contains(&method)\n}\n";
function allowlistRs(methods, declared = methods.length) {
  return `pub const ALLOWED_METHODS: [&str; ${declared}] = [\n${methods.map((m) => `    "${m}",`).join("\n")}\n];\n${IS_ALLOWED_RS}`;
}

const LIB_RS = "apps/desktop/src-tauri/src/lib.rs";
const ALLOWLIST_RS = "apps/desktop/src-tauri/src/allowlist.rs";
const IPC_CALL_GATED =
  "#[tauri::command]\nasync fn ipc_call(method: String) -> R {\n    check_method(&method)?;\n    sidecar.call(&method)\n}\n" +
  "fn check_method(method: &str) -> Result<(), F> {\n    if allowlist::is_allowed(method) { Ok(()) } else { Err(F) }\n}\n";
const LIB_BASELINE = `${IPC_CALL_GATED}pub fn run() { builder.invoke_handler(tauri::generate_handler![ipc_call]); }\n`;

function baseline() {
  const methods = ["project.open", "project.list"];
  put("packages/audit-core/src/methods.ts", methodsTs(methods));
  put("apps/desktop/src-tauri/src/allowlist.rs", allowlistRs(methods));
  put(LIB_RS, LIB_BASELINE);
  put(
    "apps/desktop/src-tauri/src/sidecar.rs",
    'use std::process::Command;\nfn spawn() { Command::new("node"); }\n',
  );
  put(
    "apps/desktop/src-tauri/Cargo.toml",
    '[package]\nname = "x"\n\n[dependencies]\ntauri = "2"\ntauri-plugin-dialog = "2"\nserde = "1"\n\n[build-dependencies]\ntauri-build = "2"\n',
  );
  put(
    "apps/desktop/src-tauri/tauri.conf.json",
    '{ "productName": "x", "bundle": { "active": false } }',
  );
  put(
    "apps/desktop/src-tauri/capabilities/default.json",
    JSON.stringify({
      identifier: "default",
      windows: ["main"],
      permissions: ["core:default", "dialog:allow-open"],
    }),
  );
  put(
    "apps/desktop/package.json",
    JSON.stringify({ dependencies: { "@tauri-apps/api": "2", "@tauri-apps/plugin-dialog": "2" } }),
  );
  put(
    "apps/web/app/page.tsx",
    "export default function P() { return <p>Local Audit Agent</p>; }\n",
  );
}

const failing = () => runChecks(root).filter((c) => c.violations.length > 0);
const failed = (name) => runChecks(root).find((c) => c.name === name).violations;

describe("baseline", () => {
  it("passes on a clean fixture and reports all seven checks", () => {
    expect(failing()).toEqual([]);
    expect(runChecks(root).map((c) => c.name)).toEqual([
      "allowlist-parity",
      "no-updater",
      "capabilities",
      "plugins",
      "rust-surface",
      "no-shell-exec",
      "web-copy",
    ]);
  });

  it("passes on the real repository", () => {
    expect(runChecks(REAL_ROOT).filter((c) => c.violations.length > 0)).toEqual([]);
  });
});

describe("allowlist-parity", () => {
  it("flags a method only Rust allows", () => {
    put(
      "apps/desktop/src-tauri/src/allowlist.rs",
      allowlistRs(["project.open", "project.list", "audit.run"]),
    );
    expect(failed("allowlist-parity").join("\n")).toContain("audit.run");
  });

  it("flags a method only TypeScript lists", () => {
    put(
      "packages/audit-core/src/methods.ts",
      methodsTs(["project.open", "project.list", "audit.run"]),
    );
    expect(failed("allowlist-parity").join("\n")).toContain("audit.run");
  });

  it("flags a wrong length annotation", () => {
    put(
      "apps/desktop/src-tauri/src/allowlist.rs",
      allowlistRs(["project.open", "project.list"], 3),
    );
    expect(failed("allowlist-parity").join("\n")).toMatch(/length|declared/i);
  });

  it("flags duplicates", () => {
    put("apps/desktop/src-tauri/src/allowlist.rs", allowlistRs(["project.open", "project.open"]));
    expect(failed("allowlist-parity").join("\n")).toMatch(/duplicate/i);
  });

  it.each(["shell.exec", "shell", "process.exec"])(
    "flags a command-execution method %s",
    (method) => {
      put(
        "packages/audit-core/src/methods.ts",
        methodsTs(["project.open", "project.list", method]),
      );
      put(
        "apps/desktop/src-tauri/src/allowlist.rs",
        allowlistRs(["project.open", "project.list", method]),
      );
      expect(failed("allowlist-parity").join("\n")).toContain(method);
    },
  );

  it("flags a missing Rust file instead of passing", () => {
    rmSync(join(root, "apps/desktop/src-tauri/src/allowlist.rs"));
    expect(failed("allowlist-parity").join("\n")).toContain("allowlist.rs");
  });

  it("flags an unreadable TypeScript list instead of passing", () => {
    put("packages/audit-core/src/methods.ts", "export const IPC_METHODS = 5;\n");
    expect(failed("allowlist-parity").length).toBeGreaterThan(0);
  });
});

describe("no-updater", () => {
  it("flags the updater crate in Cargo.toml", () => {
    put("apps/desktop/src-tauri/Cargo.toml", '[dependencies]\ntauri-plugin-updater = "2"\n');
    expect(failed("no-updater").join("\n")).toContain("Cargo.toml");
  });

  it("flags an updater block in tauri.conf.json (any case)", () => {
    put(
      "apps/desktop/src-tauri/tauri.conf.json",
      '{ "plugins": { "Updater": { "endpoints": [] } } }',
    );
    expect(failed("no-updater").join("\n")).toContain("tauri.conf.json");
  });

  it("flags updater artifacts in the bundle config", () => {
    put(
      "apps/desktop/src-tauri/tauri.conf.json",
      '{ "bundle": { "createUpdaterArtifacts": true } }',
    );
    expect(failed("no-updater").length).toBe(1);
  });

  it("flags an updater permission and an updater use in Rust", () => {
    put(
      "apps/desktop/src-tauri/capabilities/default.json",
      JSON.stringify({ windows: ["main"], permissions: ["core:default", "updater:default"] }),
    );
    put("apps/desktop/src-tauri/src/lib.rs", "use tauri_plugin_updater::Builder;\n");
    expect(failed("no-updater").length).toBe(2);
  });

  it("flags the updater npm package", () => {
    put(
      "apps/desktop/package.json",
      JSON.stringify({ dependencies: { "@tauri-apps/plugin-updater": "2" } }),
    );
    expect(failed("no-updater").join("\n")).toContain("package.json");
  });
});

describe("capabilities", () => {
  it.each([
    "shell:allow-execute",
    "fs:default",
    "opener:default",
    "core:window:allow-close",
    "dialog:allow-save",
    "core:event:allow-emit",
    "core:event:default",
    "core:webview:allow-internal-toggle-devtools",
  ])("flags the extra permission %s", (permission) => {
    put(
      "apps/desktop/src-tauri/capabilities/default.json",
      JSON.stringify({
        windows: ["main"],
        permissions: ["core:default", "dialog:allow-open", permission],
      }),
    );
    expect(failed("capabilities").join("\n")).toContain(permission);
  });

  it.each([
    ["dialog:allow-open"],
    ["core:default"],
    ["core:default", "dialog:allow-open"],
    ["core:event:allow-listen", "core:event:allow-unlisten", "dialog:allow-open"],
  ])("accepts the subset %j of the allowed permissions", (...permissions) => {
    put(
      "apps/desktop/src-tauri/capabilities/default.json",
      JSON.stringify({ windows: ["main"], permissions }),
    );
    expect(failed("capabilities")).toEqual([]);
  });

  it.each(["dialog:default", "dialog:allow-save", "dialog:allow-message"])(
    "flags a broader dialog permission %s in place of dialog:allow-open",
    (permission) => {
      put(
        "apps/desktop/src-tauri/capabilities/default.json",
        JSON.stringify({ windows: ["main"], permissions: [permission] }),
      );
      expect(failed("capabilities").join("\n")).toContain(permission);
    },
  );

  it("flags the object form of a permission", () => {
    put(
      "apps/desktop/src-tauri/capabilities/default.json",
      JSON.stringify({
        windows: ["main"],
        permissions: [{ identifier: "fs:default", allow: [{ path: "$HOME/**" }] }],
      }),
    );
    expect(failed("capabilities").join("\n")).toContain("fs:default");
  });

  it("flags a remote block", () => {
    put(
      "apps/desktop/src-tauri/capabilities/default.json",
      JSON.stringify({
        windows: ["main"],
        remote: { urls: ["https://*"] },
        permissions: ["core:default"],
      }),
    );
    expect(failed("capabilities").join("\n")).toMatch(/remote/);
  });

  it.each(["extra.toml", "extra.json5"])(
    "rejects a capability file in an unchecked format (%s)",
    (name) => {
      put(`apps/desktop/src-tauri/capabilities/${name}`, 'permissions = ["shell:allow-execute"]\n');
      expect(failed("capabilities").join("\n")).toContain(name);
    },
  );

  it("flags inline capabilities in the Tauri config", () => {
    put(
      "apps/desktop/src-tauri/tauri.conf.json",
      JSON.stringify({
        app: {
          security: {
            capabilities: [{ identifier: "x", windows: ["main"], permissions: ["fs:default"] }],
          },
        },
      }),
    );
    expect(failed("capabilities").join("\n")).toContain("inline capabilities");
  });

  it("flags a permission granted by a nested capability file", () => {
    put(
      "apps/desktop/src-tauri/capabilities/extra/win.json",
      JSON.stringify({ windows: ["w"], permissions: ["core:window:allow-create"] }),
    );
    const out = failed("capabilities").join("\n");
    expect(out).toContain("capabilities/extra/win.json");
    expect(out).toContain("core:window:allow-create");
  });

  it("flags an unchecked format and invalid JSON in a nested directory", () => {
    put("apps/desktop/src-tauri/capabilities/a/b/x.toml", "permissions = []\n");
    put("apps/desktop/src-tauri/capabilities/a/b/y.json", "{ not json");
    const out = failed("capabilities").join("\n");
    expect(out).toContain("a/b/x.toml");
    expect(out).toContain("a/b/y.json");
  });

  it("accepts a nested capability file with only permitted permissions", () => {
    put(
      "apps/desktop/src-tauri/capabilities/extra/win.json",
      JSON.stringify({ windows: ["w"], permissions: ["core:default"] }),
    );
    expect(failed("capabilities")).toEqual([]);
  });

  it("flags invalid JSON and a missing capabilities directory", () => {
    put("apps/desktop/src-tauri/capabilities/default.json", "{ not json");
    expect(failed("capabilities").join("\n")).toMatch(/default\.json/);
    rmSync(join(root, "apps/desktop/src-tauri/capabilities"), { recursive: true });
    expect(failed("capabilities").join("\n")).toMatch(/capabilities/);
  });
});

describe("plugins", () => {
  it("flags another Tauri plugin crate", () => {
    put(
      "apps/desktop/src-tauri/Cargo.toml",
      '[dependencies]\ntauri-plugin-dialog = "2"\ntauri-plugin-shell = "2"\n',
    );
    expect(failed("plugins").join("\n")).toContain("tauri-plugin-shell");
  });

  it("flags a crate given in table form", () => {
    put("apps/desktop/src-tauri/Cargo.toml", '[dependencies.tauri-plugin-fs]\nversion = "2"\n');
    expect(failed("plugins").join("\n")).toContain("tauri-plugin-fs");
  });

  it("flags another Tauri plugin npm package", () => {
    put(
      "apps/desktop/package.json",
      JSON.stringify({
        dependencies: { "@tauri-apps/plugin-dialog": "2" },
        devDependencies: { "@tauri-apps/plugin-opener": "2" },
      }),
    );
    expect(failed("plugins").join("\n")).toContain("@tauri-apps/plugin-opener");
  });
});

describe("rust-surface", () => {
  it("flags a second Tauri command", () => {
    put(
      "apps/desktop/src-tauri/src/lib.rs",
      "#[tauri::command]\nfn ipc_call() {}\n#[tauri::command]\nfn run_thing() {}\n",
    );
    expect(failed("rust-surface").join("\n")).toContain("found 2");
  });

  it("flags a missing command", () => {
    put("apps/desktop/src-tauri/src/lib.rs", "pub fn run() {}\n");
    expect(failed("rust-surface").join("\n")).toContain("found 0");
  });

  it.each(['std::process::Command::new("sh");', 'Command::new("sh");', "app.add_capability(x);"])(
    "flags %s outside sidecar.rs",
    (code) => {
      put("apps/desktop/src-tauri/src/extra.rs", `fn f() { ${code} }\n`);
      expect(failed("rust-surface").join("\n")).toContain("extra.rs:1");
    },
  );

  it("flags a missing source directory instead of passing", () => {
    rmSync(join(root, "apps/desktop/src-tauri/src"), { recursive: true });
    expect(failed("rust-surface").length).toBeGreaterThan(0);
  });
});

describe("no-shell-exec", () => {
  it("flags shell.exec in runtime source", () => {
    put("packages/auditd/src/x.ts", 'export const m = "shell.exec";\n');
    expect(failed("no-shell-exec").join("\n")).toContain("packages/auditd/src/x.ts");
  });

  it("flags it in an app source too", () => {
    put("apps/desktop/src/x.tsx", "// shell.exec\n");
    expect(failed("no-shell-exec").length).toBe(1);
  });

  it.each([
    "packages/auditd/test/x.ts",
    "packages/auditd/src/x.test.ts",
    "apps/desktop/src-tauri/tests/x.rs",
  ])("ignores %s", (rel) => {
    put(rel, 'const x = "shell.exec";\n');
    expect(failed("no-shell-exec")).toEqual([]);
  });
});

describe("rust-surface: command attribute spellings and the handler list", () => {
  it.each([
    ["use tauri::command; #[command]", "use tauri::command;\n#[command]\nfn x() {}\n"],
    ["#[::tauri::command]", "#[::tauri::command]\nfn x() {}\n"],
    ["#[tauri :: command]", "#[tauri :: command]\nfn x() {}\n"],
    [
      '#[ tauri::command(rename_all = "snake_case") ]',
      '#[ tauri::command(rename_all = "snake_case") ]\nfn x() {}\n',
    ],
    ["cfg_attr(..., tauri::command)", '#[cfg_attr(feature = "x", tauri::command)]\nfn x() {}\n'],
  ])("counts %s as a second command", (_label, code) => {
    put("apps/desktop/src-tauri/src/extra.rs", code);
    expect(failed("rust-surface").join("\n")).toContain("found 2");
  });

  it("flags a missing generate_handler! macro", () => {
    put(LIB_RS, IPC_CALL_GATED);
    expect(failed("rust-surface").join("\n")).toContain("generate_handler");
  });

  it("flags a handler list that names anything besides ipc_call", () => {
    put(LIB_RS, `${IPC_CALL_GATED}fn r() { tauri::generate_handler![ipc_call, run_thing]; }\n`);
    expect(failed("rust-surface").join("\n")).toContain("run_thing");
  });

  it("flags a handler list that leaves ipc_call out", () => {
    put(LIB_RS, `${IPC_CALL_GATED}fn r() { tauri::generate_handler![]; }\n`);
    expect(failed("rust-surface").join("\n")).toContain("generate_handler");
  });

  it("flags a second generate_handler! macro even when it lists ipc_call", () => {
    put(LIB_RS, `${LIB_BASELINE}fn r2() { tauri::generate_handler![ipc_call]; }\n`);
    expect(failed("rust-surface").join("\n")).toContain("generate_handler");
  });

  it("accepts a multi-line handler list with a trailing comma", () => {
    put(LIB_RS, `${IPC_CALL_GATED}fn r() { generate_handler![\n  ipc_call,\n]; }\n`);
    expect(failed("rust-surface")).toEqual([]);
  });
});

describe("rust-surface: ipc_call must go through the allowlist gate", () => {
  const withRun = (body) =>
    `${body}pub fn run() { builder.invoke_handler(tauri::generate_handler![ipc_call]); }\n`;

  it("accepts a gate function that wraps is_allowed", () => {
    expect(failed("rust-surface")).toEqual([]);
  });

  it("accepts ipc_call calling is_allowed directly", () => {
    put(
      LIB_RS,
      withRun(
        "#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    if !allowlist::is_allowed(&m) { return Err(F); }\n    sidecar.call(&m)\n}\n",
      ),
    );
    expect(failed("rust-surface")).toEqual([]);
  });

  it("flags an ipc_call that never consults the allowlist", () => {
    put(
      LIB_RS,
      withRun("#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    sidecar.call(&m)\n}\n"),
    );
    expect(failed("rust-surface").join("\n")).toContain("is_allowed");
  });

  it("flags a gate function that no longer calls is_allowed", () => {
    put(
      LIB_RS,
      withRun(
        "#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    check_method(&m)?;\n    sidecar.call(&m)\n}\nfn check_method(m: &str) -> Result<(), F> { Ok(()) }\n",
      ),
    );
    expect(failed("rust-surface").join("\n")).toContain("check_method");
  });

  it("does not accept the gate named only in a comment or string", () => {
    put(
      LIB_RS,
      withRun(
        '#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    // is_allowed(&m) check_method(&m)\n    let _s = "is_allowed(";\n    sidecar.call(&m)\n}\n',
      ),
    );
    expect(failed("rust-surface").join("\n")).toContain("is_allowed");
  });

  it("flags a sidecar call that happens before the gate", () => {
    put(
      LIB_RS,
      withRun(
        "#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    let r = sidecar.call(&m);\n    check_method(&m)?;\n    r\n}\nfn check_method(m: &str) -> Result<(), F> { if is_allowed(m) { Ok(()) } else { Err(F) } }\n",
      ),
    );
    expect(failed("rust-surface").join("\n")).toMatch(/before/);
  });

  const IPC = (body) =>
    `#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n${body}\n    sidecar.call(&m)\n}\n` +
    "fn check_method(m: &str) -> Result<(), F> { if allowlist::is_allowed(m) { Ok(()) } else { Err(F) } }\n";

  it("rejects a check_method call whose Result is ignored", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m);")));
    expect(failed("rust-surface").join("\n")).toContain("check_method");
  });

  it("rejects a gate hidden inside a conditional block", () => {
    put(LIB_RS, withRun(IPC("    if false { check_method(&m)?; }")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects a gate inside a closure", () => {
    put(LIB_RS, withRun(IPC("    let _g = || { check_method(&m) };")));
    expect(failed("rust-surface").length).toBeGreaterThan(0);
  });

  it("rejects a gate that is only an else-if branch", () => {
    put(
      LIB_RS,
      withRun(IPC("    if x { y(); } else if !allowlist::is_allowed(&m) { return Err(F); }")),
    );
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects an identifier that merely ends in check_method", () => {
    put(LIB_RS, withRun(IPC("    my_check_method(&m)?;")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects check_method(..).or(Ok(()))? which swallows the error", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m).or(Ok(()))?;")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects check_method(..).or_else(..)? which swallows the error", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m).or_else(|_| Ok::<(), F>(()))?;")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("accepts check_method with nested parentheses in its argument", () => {
    put(LIB_RS, withRun(IPC('    check_method(&format!("{}", m))?;')));
    expect(failed("rust-surface")).toEqual([]);
  });

  it("rejects an !is_allowed early return weakened by a trailing condition", () => {
    put(LIB_RS, withRun(IPC("    if !allowlist::is_allowed(&m) && (false) { return Err(F); }")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects an !is_allowed block whose return is nested in another if", () => {
    put(LIB_RS, withRun(IPC("    if !allowlist::is_allowed(&m) { if false { return Err(F); } }")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects an !is_allowed block whose return is only inside a closure", () => {
    put(LIB_RS, withRun(IPC("    if !allowlist::is_allowed(&m) { let _f = || { return 1; }; }")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects the char-literal paren probe: check_method(&m.x('(')).or(if ')' == 'a' ..)?", () => {
    put(
      LIB_RS,
      withRun(IPC("    check_method(&m.x('(')).or(if ')' == 'a' { Ok(()) } else { Ok(()) })?;")),
    );
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("rejects the char-literal paren probe: !is_allowed(&m.x('(')) && (')' == 'a')", () => {
    put(
      LIB_RS,
      withRun(IPC("    if !allowlist::is_allowed(&m.x('(')) && (')' == 'a') { return Err(F); }")),
    );
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("accepts a legitimate char literal in the gate argument", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m.replace(')', \"\"))?;")));
    expect(failed("rust-surface")).toEqual([]);
  });

  it("is not fooled by quote and escape char literals", () => {
    put(
      LIB_RS,
      withRun(IPC("    let _q = ('\"', '\\'', '\\\\', '\\u{28}');\n    check_method(&m)?;")),
    );
    expect(failed("rust-surface")).toEqual([]);
  });

  it("an astral char literal is one token, so a '(' after it does not desync the paren scan", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m.x('😀','('))?;")));
    expect(failed("rust-surface")).toEqual([]);
    put(LIB_RS, withRun(IPC("    check_method(&m.x('😀','(')).or(Ok(()))?;")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("leaves lifetimes alone", () => {
    put(
      LIB_RS,
      "#[tauri::command]\nasync fn ipc_call<'a>(m: &'a str, n: &'static str) -> R<'a> {\n    let _x: Vec<&'a str> = Vec::<&'static str>::new();\n    check_method(&m)?;\n    sidecar.call(&m)\n}\n" +
        "fn check_method<'a>(m: &'a str) -> Result<(), F> { if allowlist::is_allowed(m) { Ok(()) } else { Err(F) } }\n" +
        "pub fn run() { builder.invoke_handler(tauri::generate_handler![ipc_call]); }\n",
    );
    expect(failed("rust-surface")).toEqual([]);
  });

  it("still rejects a gate that only follows a lifetime-heavy preamble with a swallowed error", () => {
    put(
      LIB_RS,
      "#[tauri::command]\nasync fn ipc_call<'a>(m: &'a str) -> R {\n    check_method(&m).or(Ok(()))?;\n    sidecar.call(&m)\n}\n" +
        "fn check_method<'a>(m: &'a str) -> Result<(), F> { if allowlist::is_allowed(m) { Ok(()) } else { Err(F) } }\n" +
        "pub fn run() { builder.invoke_handler(tauri::generate_handler![ipc_call]); }\n",
    );
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("accepts check_method(..)? at the top level", () => {
    put(LIB_RS, withRun(IPC("    check_method(&m)?;")));
    expect(failed("rust-surface")).toEqual([]);
  });

  it("accepts a top-level gate that follows a block which already closed", () => {
    put(LIB_RS, withRun(IPC("    { let _a = 1; }\n    check_method(&m)?;")));
    expect(failed("rust-surface")).toEqual([]);
  });

  it("accepts an explicit early-return on !is_allowed", () => {
    put(LIB_RS, withRun(IPC("    if !allowlist::is_allowed(&m) { return Err(F); }")));
    expect(failed("rust-surface")).toEqual([]);
  });

  it("does not count a // commented-out gate", () => {
    put(LIB_RS, withRun(IPC("    // check_method(&m)?;")));
    expect(failed("rust-surface").join("\n")).toContain("top level");
  });

  it("still rejects forwarding before the gate", () => {
    put(
      LIB_RS,
      withRun(
        "#[tauri::command]\nasync fn ipc_call(m: String) -> R {\n    sidecar.call(&m);\n    check_method(&m)?;\n}\nfn check_method(m: &str) -> Result<(), F> { allowlist::is_allowed(m); Ok(()) }\n",
      ),
    );
    expect(failed("rust-surface").join("\n")).toContain("before the allowlist check");
  });

  it("flags a lib.rs with no ipc_call definition", () => {
    put(LIB_RS, "pub fn run() { builder.invoke_handler(tauri::generate_handler![ipc_call]); }\n");
    put("apps/desktop/src-tauri/src/other.rs", "#[tauri::command]\nfn ipc_call() {}\n");
    expect(failed("rust-surface").join("\n")).toContain("ipc_call");
  });
});

describe("silent passes: a missing dependent input is a violation", () => {
  it("web-copy: apps/web absent", () => {
    rmSync(join(root, "apps/web"), { recursive: true });
    expect(failed("web-copy").join("\n")).toContain("apps/web");
  });

  it("web-copy: apps/web has no files", () => {
    rmSync(join(root, "apps/web"), { recursive: true });
    mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
    expect(failed("web-copy").join("\n")).toContain("apps/web");
  });

  it("web-copy: an unreadable scan root (a file, not a directory) is not swallowed", () => {
    rmSync(join(root, "apps/web"), { recursive: true });
    put("apps/web", "not a directory");
    expect(failed("web-copy").join("\n")).toContain("apps/web");
  });

  it("no-shell-exec: no runtime sources at all", () => {
    rmSync(join(root, "apps/web"), { recursive: true });
    rmSync(join(root, "packages"), { recursive: true });
    expect(failed("no-shell-exec").length).toBeGreaterThan(0);
  });

  it("no-shell-exec: apps and packages directories absent", () => {
    rmSync(join(root, "apps"), { recursive: true });
    rmSync(join(root, "packages"), { recursive: true });
    expect(failed("no-shell-exec").length).toBeGreaterThan(0);
  });

  it("no-updater: apps/desktop absent", () => {
    rmSync(join(root, "apps/desktop"), { recursive: true });
    expect(failed("no-updater").length).toBeGreaterThan(0);
  });

  it("no-updater and capabilities: tauri.conf.json missing", () => {
    rmSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"));
    expect(failed("no-updater").join("\n")).toContain("tauri.conf.json");
    expect(failed("capabilities").join("\n")).toContain("tauri.conf.json");
  });

  it("capabilities: does not crash when the whole src-tauri directory is gone", () => {
    rmSync(join(root, "apps/desktop/src-tauri"), { recursive: true });
    expect(failed("capabilities").length).toBeGreaterThan(0);
  });

  it("runChecks on a nonexistent root fails every check", () => {
    const results = runChecks(join(root, "nope"));
    expect(results.length).toBe(7);
    for (const c of results) expect(c.violations.length).toBeGreaterThan(0);
  });
});

describe("allowlist-parity: is_allowed and the allowlist file", () => {
  const withBody = (body) =>
    `${allowlistRs(["project.open", "project.list"]).split("\npub fn is_allowed")[0]}\npub fn is_allowed(method: &str) -> bool {\n${body}\n}\n`;

  it.each([
    "true",
    'ALLOWED_METHODS.contains(&method) || method == "shell.exec"',
    'method.starts_with("shell") || ALLOWED_METHODS.contains(&method)',
    "ALLOWED_METHODS.contains(&method) || true",
    "ALLOWED_METHODS.iter().any(|m| m.starts_with(method))",
  ])("flags an is_allowed body of %s", (body) => {
    put(ALLOWLIST_RS, withBody(body));
    expect(failed("allowlist-parity").join("\n")).toContain("is_allowed");
  });

  it("tolerates formatting differences in the is_allowed body", () => {
    put(ALLOWLIST_RS, withBody("  ALLOWED_METHODS\n        .contains( &method )  "));
    expect(failed("allowlist-parity")).toEqual([]);
  });

  it("flags a missing is_allowed function", () => {
    put(ALLOWLIST_RS, allowlistRs(["project.open", "project.list"]).replace(IS_ALLOWED_RS, ""));
    expect(failed("allowlist-parity").join("\n")).toContain("is_allowed");
  });

  it("flags a second is_allowed function", () => {
    put(ALLOWLIST_RS, `${allowlistRs(["project.open", "project.list"])}${IS_ALLOWED_RS}`);
    expect(failed("allowlist-parity").join("\n")).toContain("is_allowed");
  });

  it("flags a second [&str; N] const next to ALLOWED_METHODS", () => {
    put(
      ALLOWLIST_RS,
      `${allowlistRs(["project.open", "project.list"])}pub const EXTRA: [&str; 1] = ["x"];\n`,
    );
    expect(failed("allowlist-parity").join("\n")).toMatch(/second|extra|only one/i);
  });
});

describe("no-shell-exec: Rust sources (outside tests/ and outside `mod tests` blocks)", () => {
  it("flags shell.exec in non-test Rust source", () => {
    put("apps/desktop/src-tauri/src/extra.rs", 'fn f() { let _ = "shell.exec"; }\n');
    expect(failed("no-shell-exec").join("\n")).toContain("extra.rs:1");
  });

  it("flags shell.exec in a Rust comment too", () => {
    put(LIB_RS, `${LIB_BASELINE}// shell.exec\n`);
    expect(failed("no-shell-exec").join("\n")).toContain("lib.rs");
  });

  it("ignores shell.exec inside a #[cfg(test)] mod tests block", () => {
    put(
      ALLOWLIST_RS,
      `${allowlistRs(["project.open", "project.list"])}\n#[cfg(test)]\nmod tests {\n    fn t() {\n        assert!(!super::is_allowed("shell.exec"));\n    }\n}\n`,
    );
    expect(failed("no-shell-exec")).toEqual([]);
  });

  it("ignores shell.exec inside a plain mod tests block", () => {
    put(
      "apps/desktop/src-tauri/src/extra.rs",
      'mod tests {\n    const X: &str = "shell.exec";\n}\n',
    );
    expect(failed("no-shell-exec")).toEqual([]);
  });

  it("still flags shell.exec in non-test code that follows a test module", () => {
    put(
      "apps/desktop/src-tauri/src/extra.rs",
      '#[cfg(test)]\nmod tests {\n    fn t() { let _ = "shell.exec"; }\n}\nfn later() { let _ = "shell.exec"; }\n',
    );
    const out = failed("no-shell-exec").join("\n");
    expect(out).toContain("extra.rs:5");
    expect(out).not.toContain("extra.rs:3");
  });

  it("flags shell.exec in a package src/gen directory (gen is not skipped)", () => {
    put("packages/auditd/src/gen/x.ts", 'export const m = "shell.exec";\n');
    expect(failed("no-shell-exec").join("\n")).toContain("packages/auditd/src/gen/x.ts");
  });
});

describe("web-copy: extensions, extra wording, test-file exemption, gen dirs", () => {
  it.each(["mdx", "svg", "yaml", "yml", "txt", "tsx", "jsx", "mjs", "cjs", "json5", "toml"])(
    "scans .%s files",
    (ext) => {
      put(`apps/web/app/copy.${ext}`, "Semgrep\n");
      expect(failed("web-copy").join("\n")).toContain(`apps/web/app/copy.${ext}:1`);
    },
  );

  it.each(["白話", "ChatGPT", "chatgpt", "ChatGPTs", "自研大模型", "自研的模型"])(
    "flags %s",
    (term) => {
      put("apps/web/app/copy.ts", `export const t = "我们用 ${term} 来检查";\n`);
      expect(failed("web-copy").join("\n")).toContain("apps/web/app/copy.ts:1");
    },
  );

  it.each([
    "apps/web/app/test/copy.ts",
    "apps/web/app/tests/copy.ts",
    "apps/web/app/gen/copy.ts",
    "apps/web/app/test/gen/copy.ts",
  ])("still scans %s (a directory name alone is not a test exemption)", (rel) => {
    put(rel, "Semgrep\n");
    expect(failed("web-copy").join("\n")).toContain(`${rel}:1`);
  });

  it.each([
    "apps/web/app/copy.spec.ts",
    "apps/web/app/copy.test.tsx",
    "apps/web/app/__tests__/copy.ts",
  ])("exempts %s by name", (rel) => {
    put(rel, "Semgrep\n");
    expect(failed("web-copy")).toEqual([]);
  });
});

describe("web-copy: shared packages rendered by the website", () => {
  it.each(["packages/ui/src/x.tsx", "packages/design-tokens/src/y.ts"])(
    "flags a forbidden term in %s",
    (path) => {
      put(path, 'export const t = "Semgrep";\n');
      expect(failed("web-copy").join("\n")).toContain(`${path}:1`);
    },
  );

  it("exempts test files in the shared packages", () => {
    put("packages/ui/src/x.test.tsx", 'expect("Semgrep");\n');
    expect(failed("web-copy")).toEqual([]);
  });

  it("does not require the shared package directories to exist", () => {
    expect(failed("web-copy")).toEqual([]);
  });
});

describe("web-copy", () => {
  it.each([
    "白话",
    "大白话",
    "自研模型",
    "Understand Anything",
    "Agentic QE",
    "agentic-qe",
    "reverse-skill",
    "Playwright",
    "Semgrep",
    "semgrep",
    "Trivy",
    "Gitleaks",
    "OSV",
    "Snyk",
    "CodeQL",
    "OpenAI",
    "Anthropic",
    "Claude",
    "GPT",
    "DeepSeek",
    "Qwen",
    "Ollama",
    "LM Studio",
    "B.AI",
    "Sonnet",
    "Haiku",
    "Opus",
    "Codex",
    "Copilot",
    "Cursor",
    "GLM",
    "glm",
    "智谱",
    "MiniMax",
    "豆包",
    "vLLM",
    "vllm",
  ])("flags %s in a website source", (term) => {
    put("apps/web/app/copy.ts", `export const t = "我们用 ${term} 来检查";\n`);
    expect(failed("web-copy").join("\n")).toContain("apps/web/app/copy.ts:1");
  });

  it("does not flag words that merely contain a listed name", () => {
    put("apps/web/app/copy.ts", 'export const t = "gptable osvaldo";\n');
    expect(failed("web-copy")).toEqual([]);
  });

  it("exempts tests and ignores node_modules and build output", () => {
    put("apps/web/app/copy.test.ts", 'expect(text).not.toContain("Semgrep");\n');
    put("apps/web/node_modules/pkg/index.js", "Semgrep\n");
    put("apps/web/.next/server/x.js", "Semgrep\n");
    expect(failed("web-copy")).toEqual([]);
  });

  it("does not police packages outside the website's shared roots", () => {
    put("packages/other/src/x.ts", "// Semgrep\n");
    expect(failed("web-copy")).toEqual([]);
  });

  it("does not flag ordinary words or CSS that resemble the short model names", () => {
    put("apps/web/app/ok.css", ".a { cursor: pointer; } .b { cursor: not-allowed; }\n");
    put(
      "apps/web/app/ok.ts",
      'export const t = "the cursor moves; a haiku, a sonnet, an opus; getCursor(); glmatrix; codexes";\n',
    );
    expect(failed("web-copy")).toEqual([]);
  });
});

describe("web-copy: the desktop UI is held to the same rules (spec 35.4)", () => {
  it.each(["Semgrep", "Claude", "Cursor", "豆包", "白话"])(
    "flags %s in apps/desktop/src",
    (term) => {
      put("apps/desktop/src/App.tsx", `export const t = "用 ${term} 检查";\n`);
      expect(failed("web-copy").join("\n")).toContain("apps/desktop/src/App.tsx:1");
    },
  );

  it("exempts desktop tests and leaves the Rust shell alone", () => {
    put("apps/desktop/src/App.test.tsx", 'expect(t).not.toContain("Semgrep");\n');
    put("apps/desktop/src/__tests__/x.ts", "// Claude\n");
    put("apps/desktop/src-tauri/src/extra.rs", "// Claude, Semgrep\n");
    expect(failed("web-copy")).toEqual([]);
  });

  it("does not require apps/desktop/src to exist", () => {
    expect(failed("web-copy")).toEqual([]);
  });

  it("does not flag `cursor: pointer` in desktop CSS", () => {
    put("apps/desktop/src/app.css", "button { cursor: pointer; }\n");
    expect(failed("web-copy")).toEqual([]);
  });
});

describe("Tauri config formats: json5 and Tauri.toml are scanned too", () => {
  it("flags an updater block in tauri.conf.json5 and Tauri.toml", () => {
    put("apps/desktop/src-tauri/tauri.conf.json5", "{ plugins: { updater: { endpoints: [] } } }");
    put("apps/desktop/src-tauri/Tauri.toml", "[plugins.updater]\nendpoints = []\n");
    const out = failed("no-updater").join("\n");
    expect(out).toContain("tauri.conf.json5:1");
    expect(out).toContain("Tauri.toml:1");
  });

  it("flags inline capabilities in Tauri.toml and tauri.conf.json5", () => {
    put("apps/desktop/src-tauri/Tauri.toml", "[app.security]\ncapabilities = []\n");
    put("apps/desktop/src-tauri/tauri.conf.json5", "{ app: { security: { capabilities: [] } } }");
    const out = failed("capabilities").join("\n");
    expect(out).toContain("Tauri.toml");
    expect(out).toContain("tauri.conf.json5");
  });

  it("accepts Tauri.toml as the config when tauri.conf.json is absent", () => {
    rmSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"));
    put("apps/desktop/src-tauri/Tauri.toml", 'product-name = "x"\n');
    expect(failed("no-updater")).toEqual([]);
    expect(failed("capabilities")).toEqual([]);
  });
});

describe("CLI", () => {
  const run = (target) => spawnSync(process.execPath, [SCRIPT, target], { encoding: "utf8" });

  it("exits 0 and says ok on a clean repo", () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(result.stdout).not.toContain("FAIL");
  });

  it("exits 1 and names the violation on a bad repo", () => {
    put("apps/web/app/copy.ts", 'export const t = "白话";\n');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("apps/web/app/copy.ts:1");
  });

  it("exits 1 and prints FAIL (never ok for every check) on a nonexistent root", () => {
    const result = run(join(root, "does-not-exist"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).not.toContain("ok ");
  });

  it("defaults to the repository root", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
