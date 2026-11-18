import { delimiter, dirname, join } from "node:path";
import type { Sandbox } from "./workspace";

/** The only variables a child may ever receive (besides the fixed ones set below). */
export const ENV_ALLOWLIST = [
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
] as const;

/**
 * Per-user locations inside the sandbox home that the child's environment points at. Built with
 * path.join so the separators match the platform; createSandbox creates exactly these directories.
 */
export function homeLocations(home: string): Record<string, string> {
  return {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

function trimmedPath(parent: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const dirs = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const root = parent.SystemRoot ?? "C:\\Windows";
    dirs.push(`${root}\\System32`, root);
  } else {
    dirs.push("/usr/bin", "/bin");
  }
  return dirs.join(delimiter);
}

export function buildChildEnv(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
  parent: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of Object.keys(extra)) {
    if (!(ENV_ALLOWLIST as readonly string[]).includes(key)) {
      throw new Error(`Environment variable ${key} is not allowed for engine processes.`);
    }
    env[key] = extra[key] as string;
  }
  const h = sandbox.home;
  Object.assign(env, {
    PATH: trimmedPath(parent),
    HOME: h,
    USERPROFILE: h,
    ...homeLocations(h),
    TMPDIR: sandbox.tmp,
    TEMP: sandbox.tmp,
    TMP: sandbox.tmp,
    AQE_PROJECT_ROOT: sandbox.cwd,
    AQE_LLM_ROUTER_DISABLED: "1",
    // The coverage tool would otherwise run the project's own test runner (project code, network).
    // Fixed here, not per engine: every host gets it, and childEnvFor refuses to let a config override it.
    AQE_COVERAGE_NO_EXEC: "1",
    NO_COLOR: "1",
    CI: "1",
  });
  return env;
}
