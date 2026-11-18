import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv, ENV_ALLOWLIST } from "../src/sandbox/env";
import type { Sandbox } from "../src/sandbox/workspace";

const sb: Sandbox = {
  root: "/sb",
  home: "/sb/home",
  cwd: "/sb/cwd",
  tmp: "/sb/tmp",
  projectDir: "/sb/project",
  fileCount: 0,
  bytes: 0,
  skippedLarge: 0,
  cleanup: async () => {},
};

describe("buildChildEnv", () => {
  it("never inherits secrets or arbitrary variables from the parent", () => {
    const parent = {
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "k",
      GITHUB_TOKEN: "t",
      AWS_SECRET_ACCESS_KEY: "a",
      NODE_OPTIONS: "--require /evil.js",
      HTTPS_PROXY: "http://p",
      SSH_AUTH_SOCK: "/s",
      PATH: "/usr/bin",
    };
    const env = buildChildEnv(sb, {}, parent);
    for (const k of Object.keys(parent).filter((k) => k !== "PATH"))
      expect(env).not.toHaveProperty(k);
  });
  it("points every home-like location and temp dir into the sandbox", () => {
    const env = buildChildEnv(sb, {}, {});
    for (const k of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
    ]) {
      // path.join is the host's: on Windows APPDATA & co. come back with backslashes.
      expect(env[k]?.replaceAll("\\", "/").startsWith("/sb/")).toBe(true);
    }
    expect(env.TMPDIR).toBe("/sb/tmp");
    expect(env.TEMP).toBe("/sb/tmp");
    expect(env.TMP).toBe("/sb/tmp");
  });
  it("builds the home-relative locations with the platform's path joining, never a hard-coded slash", () => {
    const env = buildChildEnv({ ...sb, home: `${join("/sb", "home")}/` }, {}, {});
    expect(env.APPDATA).toBe(join("/sb", "home", "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(join("/sb", "home", "AppData", "Local"));
    expect(env.XDG_DATA_HOME).toBe(join("/sb", "home", ".local", "share"));
    for (const k of [
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
    ])
      expect(env[k]).not.toContain("//");
  });
  it("sets AQE_PROJECT_ROOT to a temp dir and disables the LLM router", () => {
    const env = buildChildEnv(sb, {}, {});
    expect(env.AQE_PROJECT_ROOT).toBe("/sb/cwd");
    expect(env.AQE_LLM_ROUTER_DISABLED).toBe("1");
    expect(env.AQE_COVERAGE_NO_EXEC).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });
  it("uses a trimmed PATH that contains node's directory and no user directories", () => {
    const env = buildChildEnv(sb, {}, { PATH: "/home/u/bin:/opt/secret" });
    const entries = (env.PATH ?? "").split(delimiter);
    expect(entries).not.toContain("/home/u/bin");
    expect(entries).not.toContain("/opt/secret");
    expect(entries).toContain(dirname(process.execPath));
  });
  it("extra keys must be on the allowlist, else it throws", () => {
    expect(() => buildChildEnv(sb, { OPENAI_API_KEY: "x" }, {})).toThrow(/not allowed/);
    expect(() => buildChildEnv(sb, { LANG: "C" }, {})).not.toThrow();
  });
  it("the allowlist never contains a secret-looking name", () => {
    for (const k of ENV_ALLOWLIST) expect(k).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|PROXY/i);
  });
});
