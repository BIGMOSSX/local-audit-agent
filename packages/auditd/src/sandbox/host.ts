import { AQE_ALLOWED_TOOLS } from "@audit/engine-quality";
import type { EngineHost } from "../engine-service";
import { buildChildEnv, ENV_ALLOWLIST } from "./env";
import { McpClient, mcpToolHost } from "./mcp-client";
import { spawnManaged } from "./run";
import type { Sandbox } from "./workspace";

const CLOSE_WAIT_MS = 2000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Loader-injection variables can run arbitrary code in the child: never configurable.
const LOADER_KEYS = [
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
];

export interface McpEngineConfig {
  /** Absolute path to the engine's MCP entry file (installed by `tools.install`, never bundled here). */
  entry: string;
  allowedTools: readonly string[];
  timeoutMs?: number;
  /** Literals (e.g. the session token) to mask in the stderr tail. */
  secrets?: readonly string[];
  /** Extra child environment. Keys the sandbox sets itself, and loader-injection keys, are rejected. */
  env?: Readonly<Record<string, string>>;
}

export function qualityEngineHostConfig(
  entry: string,
  rest: Pick<McpEngineConfig, "timeoutMs" | "secrets"> = {},
): McpEngineConfig {
  return { ...rest, entry, allowedTools: AQE_ALLOWED_TOOLS };
}

/** Throws before any spawn; the message never contains the value. */
export function childEnvFor(
  cfg: Pick<McpEngineConfig, "env">,
  sandbox: Sandbox,
): Record<string, string> {
  const base = buildChildEnv(sandbox);
  const reserved = new Set(
    [...Object.keys(buildChildEnv(sandbox, {}, {})), ...ENV_ALLOWLIST, ...LOADER_KEYS].map((k) =>
      k.toUpperCase(),
    ),
  );
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    if (!ENV_KEY.test(key) || reserved.has(key.toUpperCase())) {
      throw new Error(
        `Environment variable ${key.slice(0, 40)} is not allowed for engine processes.`,
      );
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`Environment variable ${key} has an invalid value.`);
    }
    base[key] = value;
  }
  return base;
}

const bounded = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    void p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });

/** `signal` aborts a handshake that never completes (a child that accepts input but never answers). */
export async function startMcpHost(
  cfg: McpEngineConfig,
  sandbox: Sandbox,
  signal?: AbortSignal,
): Promise<EngineHost> {
  const env = childEnvFor(cfg, sandbox);
  if (signal?.aborted)
    throw new Error("The audit was cancelled before the analysis engine started.");
  const proc = spawnManaged({
    command: process.execPath,
    args: [cfg.entry],
    cwd: sandbox.cwd,
    env,
    timeoutMs: cfg.timeoutMs ?? 10 * 60_000,
  });
  let client: McpClient;
  try {
    client = await McpClient.connect(
      proc,
      {
        allowedTools: cfg.allowedTools,
        maxMessageBytes: 4 * 1024 * 1024,
        callTimeoutMs: 120_000,
        secrets: cfg.secrets ?? [],
      },
      signal,
    );
  } catch (err) {
    // connect killed the child; wait for it so the sandbox is not removed under a dying process.
    await bounded(proc.done, CLOSE_WAIT_MS);
    throw err;
  }
  return {
    host: mcpToolHost(client),
    // Kills the child, then waits (bounded) for it and its stdio to finish so the stderr tail is complete.
    close: async () => {
      client.close();
      await bounded(proc.done, CLOSE_WAIT_MS);
    },
    diagnostics: () => client.stderrTail(),
  };
}
