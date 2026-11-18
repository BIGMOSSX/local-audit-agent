import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import net from "node:net";
import {
  type IpcErrorCode,
  type IpcMethod,
  IpcRequestSchema,
  type IpcResponse,
  isIpcMethod,
} from "@audit/audit-core";
import { disposeEndpoint, prepareEndpoint } from "./endpoint";
import { IpcError } from "./errors";
import type { Logger } from "./logger";

const NEWLINE = 0x0a;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_FIRST_LINE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const MIN_TOKEN_LENGTH = 32;
const LINGER_MS = 1000;

export type Handler = (params: unknown) => unknown | Promise<unknown>;
export type Handlers = Partial<Record<IpcMethod, Handler>>;

export interface IpcServerOptions {
  endpoint: string;
  token: string;
  handlers: Handlers;
  log: Logger;
  maxLineBytes?: number;
  firstLineTimeoutMs?: number;
  maxConnections?: number;
}

export interface IpcServer {
  endpoint: string;
  close(): Promise<void>;
}

type Id = string | number | null;

/** Never throws, whatever was thrown (null-prototype objects, hostile toString, ...). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.stack ?? err.message;
    return String(err);
  } catch {
    return "<unprintable error>";
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

function failure(id: Id, code: IpcErrorCode, message: string): IpcResponse {
  return { id, ok: false, error: { code, message } };
}

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  if (typeof opts.token !== "string" || opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`session token must be a string of at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const { endpoint, handlers, log } = opts;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const firstLineTimeoutMs = opts.firstLineTimeoutMs ?? DEFAULT_FIRST_LINE_TIMEOUT_MS;
  const expected = sha256(opts.token);
  const connections = new Set<net.Socket>();

  async function handleLine(
    line: string,
    state: { authed: boolean },
  ): Promise<{ response: IpcResponse; closeAfter: boolean }> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return {
        response: failure(null, "bad_request", "Malformed JSON."),
        closeAfter: !state.authed,
      };
    }
    const obj =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const id: Id =
      obj && (typeof obj.id === "string" || Number.isInteger(obj.id))
        ? (obj.id as string | number)
        : null;
    const claimed = typeof obj?.token === "string" ? obj.token : "";
    if (!timingSafeEqual(expected, sha256(claimed))) {
      log.warn("ipc request rejected: unauthorized");
      return { response: failure(id, "unauthorized", "Invalid session token."), closeAfter: true };
    }
    state.authed = true;

    const parsed = IpcRequestSchema.safeParse(value);
    if (!parsed.success)
      return { response: failure(id, "bad_request", "Malformed request."), closeAfter: false };
    const req = parsed.data;

    if (!isIpcMethod(req.method)) {
      log.warn("ipc request rejected: method not allowed", { method: req.method.slice(0, 64) });
      return {
        response: failure(
          req.id,
          "method_not_allowed",
          `Method not allowed: ${req.method.slice(0, 64)}`,
        ),
        closeAfter: false,
      };
    }
    const handler = handlers[req.method];
    if (!handler)
      return {
        response: failure(req.id, "method_not_implemented", `Not implemented yet: ${req.method}`),
        closeAfter: false,
      };

    try {
      const result = await handler(req.params);
      return {
        response: { id: req.id, ok: true, ...(result === undefined ? {} : { result }) },
        closeAfter: false,
      };
    } catch (err) {
      if (err instanceof IpcError)
        return { response: failure(req.id, err.code, err.message), closeAfter: false };
      log.error("handler failed", {
        method: req.method,
        error: describeError(err),
      });
      return { response: failure(req.id, "internal", "Internal error."), closeAfter: false };
    }
  }

  function serialise(response: IpcResponse): string {
    try {
      return `${JSON.stringify(response)}\n`;
    } catch (err) {
      log.error("response not serialisable", { error: describeError(err) });
      return `${JSON.stringify(failure(response.id, "internal", "Internal error."))}\n`;
    }
  }

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
      clearTimeout(firstLineTimer);
      clearTimeout(lingerTimer);
    });
    socket.on("error", (err) =>
      log.warn("ipc socket error", { code: (err as NodeJS.ErrnoException).code }),
    );

    let pending: Buffer = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    let closing = false;
    let discardInput = false;
    const state = { authed: false };
    let lingerTimer: NodeJS.Timeout | undefined;
    const firstLineTimer = setTimeout(() => socket.destroy(), firstLineTimeoutMs);

    const send = (response: IpcResponse, closeAfter: boolean) => {
      if (socket.destroyed) return;
      const text = serialise(response);
      if (closeAfter) {
        closing = true;
        // A stranger must not be able to hold the slot by never sending FIN: destroy once the
        // final reply is flushed, with a short fallback in case the flush never completes.
        lingerTimer = setTimeout(() => socket.destroy(), LINGER_MS);
        lingerTimer.unref();
        socket.end(text, () => socket.destroy());
      } else {
        socket.write(text);
      }
    };

    const refuseOversize = () => {
      discardInput = true;
      pending = Buffer.alloc(0);
      chain = chain.then(() => send(failure(null, "bad_request", "Request too large."), true));
    };

    socket.on("data", (chunk: Buffer) => {
      if (closing || discardInput) return;
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (
        let nl = pending.indexOf(NEWLINE, start);
        nl !== -1;
        nl = pending.indexOf(NEWLINE, start)
      ) {
        const lineBytes = pending.subarray(start, nl);
        start = nl + 1;
        if (lineBytes.length > maxLineBytes) return refuseOversize();
        if (lineBytes.length === 0) continue;
        clearTimeout(firstLineTimer);
        const line = lineBytes.toString("utf8");
        chain = chain.then(async () => {
          if (closing) return;
          try {
            const { response, closeAfter } = await handleLine(line, state);
            send(response, closeAfter);
          } catch (err) {
            // Last line of defence: never leave the chain rejected or the request unanswered.
            try {
              log.error("ipc request failed", { error: describeError(err) });
            } catch {}
            try {
              send(failure(null, "internal", "Internal error."), false);
            } catch {
              socket.destroy();
            }
          }
        });
      }
      pending = pending.subarray(start);
      if (pending.length > maxLineBytes) refuseOversize();
    });
  });
  server.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  prepareEndpoint(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  } catch (err) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    disposeEndpoint(endpoint);
    throw err;
  }
  server.on("error", (err) => log.error("ipc server error", { error: String(err) }));
  log.info("ipc listening", { endpoint });

  return {
    endpoint,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      disposeEndpoint(endpoint);
    },
  };
}
