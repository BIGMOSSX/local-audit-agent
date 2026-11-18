import { Agent, get } from "node:http";
import { type LocalModelService, MODEL_ID_MAX, MODELS_PER_SERVICE_MAX } from "@audit/audit-core";

// Common default ports of local OpenAI-compatible servers. Spec §35.2: not verified against the
// installed software, so this is only where we look, never a claim about what is running there.
export const CANDIDATE_PORTS: readonly number[] = [1234, 8000, 8080, 11434];

const LOOPBACK = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 800;
const MAX_BODY_BYTES = 1_000_000;
// Control, format (bidi overrides, zero-width), private-use, surrogate and unassigned characters.
const UNPRINTABLE = /\p{C}/u;

export interface ProbeOptions {
  ports?: readonly number[];
  timeoutMs?: number;
}

function modelIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  for (const entry of data) {
    const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : null;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MODEL_ID_MAX ||
      UNPRINTABLE.test(id)
    )
      continue;
    ids.add(id);
    if (ids.size === MODELS_PER_SERVICE_MAX) break;
  }
  return [...ids];
}

// node:http with our own Agent, not global fetch: fetch honours NODE_USE_ENV_PROXY / --use-env-proxy
// and would send this loopback request to whatever proxy the user's environment names.
const agent = new Agent({ keepAlive: false });

function fetchCapped(port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get(
      {
        host: LOOPBACK,
        port,
        path: "/v1/models",
        agent,
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        // A redirect or any non-2xx is simply "not a model server"; it is never followed.
        if (!res.statusCode || res.statusCode < 200 || res.statusCode > 299) {
          res.destroy();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BODY_BYTES) {
            res.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve(null));
        res.on("aborted", () => resolve(null));
      },
    );
    req.on("error", () => resolve(null));
  });
}

async function probeOne(port: number, timeoutMs: number): Promise<LocalModelService | null> {
  try {
    const text = await fetchCapped(port, timeoutMs);
    if (text === null) return null;
    const models = modelIds(JSON.parse(text));
    return models.length > 0 ? { port, models } : null;
  } catch {
    return null;
  }
}

export async function probeLoopbackModels(opts: ProbeOptions = {}): Promise<LocalModelService[]> {
  const ports = [...new Set(opts.ports ?? CANDIDATE_PORTS)];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const found = await Promise.all(ports.map((port) => probeOne(port, timeoutMs)));
  return found.filter((s): s is LocalModelService => s !== null).sort((a, b) => a.port - b.port);
}
