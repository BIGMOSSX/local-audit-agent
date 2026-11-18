import type { ToolHost } from "@audit/audit-core";
import { redactSecrets } from "@audit/shared";
import type { ManagedProcess } from "./run";

// Minimal MCP client over a child's stdio (newline-delimited JSON-RPC 2.0). The child is
// third-party and untrusted: everything it sends is treated as hostile data. Never reachable from IPC.
const STDERR_CAP = 64 * 1024;
const MIN_STDERR_MARGIN = 4096;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_ERROR_MESSAGE_CHARS = 1000;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
const MIN_PARTIAL_CAPACITY = 4096;
// A finished line's buffer is kept for reuse only up to this size.
const KEEP_PARTIAL_CAPACITY = 64 * 1024;
// Refusals echo the server's request id, so an unbounded id would let a hostile server amplify.
const MAX_ECHOED_ID_CHARS = 128;
const MAX_REFUSED_REQUESTS = 100;
// Bytes the child may leave unread in our stdin queue (beyond the message just written).
const STDIN_BACKLOG_CAP = 1024 * 1024;

export class McpPolicyError extends Error {}

/**
 * An error built from the server's own `error.message`. The message is engine-controlled and
 * UNREDACTED: callers must run it through `redactSecrets` and `sanitizeEngineText` before logging.
 */
export class McpServerError extends Error {
  readonly untrusted = true;
}

/** Truncate to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

export interface McpOptions {
  allowedTools: readonly string[];
  maxMessageBytes: number;
  callTimeoutMs: number;
  /** Budget for `initialize`, which includes the child's cold start. Defaults to `callTimeoutMs`. */
  handshakeTimeoutMs?: number;
  /** Extra literals (e.g. a session token) to mask in `stderrTail()`. */
  secrets?: readonly string[];
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isContinuationByte = (b: number | undefined): boolean => ((b ?? 0) & 0xc0) === 0x80;

/** End offset that excludes a trailing, still-incomplete UTF-8 sequence (the child may be mid-write). */
function completeUtf8End(buf: Buffer): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back] ?? 0;
    if (isContinuationByte(b)) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

export class McpClient {
  refusedRequests = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly allowed: ReadonlySet<string>;
  private readonly secrets: readonly string[];
  private readonly maxMessageBytes: number;
  private readonly callTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly stderrLimit: number;
  /**
   * The current, not yet terminated line: ONE growable buffer (capacity doubles, so appends are
   * amortised O(1) and never exceed 2x the message cap), not a list of chunks. A server that dribbles
   * a line a byte at a time would otherwise cost one Buffer object per byte.
   */
  private partialBuf: Buffer = EMPTY;
  private partialBytes = 0;
  private stderrRaw: Buffer = Buffer.alloc(0);
  /** No further I/O: closed by the caller, killed by us, or the child is gone. */
  private dead = false;

  private constructor(
    private readonly proc: ManagedProcess,
    opts: McpOptions,
  ) {
    this.allowed = new Set(opts.allowedTools);
    this.secrets = [...(opts.secrets ?? [])];
    this.maxMessageBytes = opts.maxMessageBytes;
    this.callTimeoutMs = Math.min(opts.callTimeoutMs, MAX_TIMER_MS);
    this.handshakeTimeoutMs = Math.min(opts.handshakeTimeoutMs ?? opts.callTimeoutMs, MAX_TIMER_MS);
    // Keep a margin past the cap so a secret straddling the cap is seen whole and redacted
    // before the redacted text is cut to the cap.
    const margin = Math.max(
      MIN_STDERR_MARGIN,
      ...this.secrets.map((s) => Buffer.byteLength(s, "utf8")),
    );
    this.stderrLimit = STDERR_CAP + margin;

    const { stdout, stderr, stdin } = proc.child;
    stdout?.on("data", (chunk: Buffer | string) => this.onData(chunk));
    stdout?.on("error", () => this.shutdown(new Error("The analysis engine stopped.")));
    // The engine closed its output but may still be running: nothing more can ever arrive.
    stdout?.on("end", () => this.shutdown(new Error("The analysis engine stopped.")));
    stdout?.on("close", () => this.shutdown(new Error("The analysis engine stopped.")));
    // Must always be drained: a full stderr pipe blocks the child, and the call would time out.
    stderr?.on("data", (chunk: Buffer | string) => this.onStderr(chunk));
    stderr?.on("error", () => undefined);
    // EPIPE after the child died must reject pending calls, never crash the daemon.
    stdin?.on("error", () => this.shutdown(new Error("The analysis engine stopped.")));
    proc.child.on("error", () => this.shutdown(new Error("The analysis engine stopped.")));
    void proc.done.then(() => this.shutdown(new Error("The analysis engine stopped.")));
  }

  /**
   * Takes ownership of `proc`: on invalid options, an abort or a failed handshake the child is killed.
   * `signal` matters because a child that accepts stdin but never answers `initialize` would otherwise
   * hold the caller until the handshake timeout.
   */
  static async connect(
    proc: ManagedProcess,
    opts: McpOptions,
    signal?: AbortSignal,
  ): Promise<McpClient> {
    try {
      validateOptions(opts);
    } catch (e) {
      proc.kill();
      throw e;
    }
    if (signal?.aborted) {
      proc.kill();
      throw new Error("The audit was cancelled before the analysis engine started.");
    }
    const client = new McpClient(proc, opts);
    const onAbort = (): void =>
      client.shutdown(new Error("The audit was cancelled while the analysis engine was starting."));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "local-audit-agent", version: "0" },
        },
        client.handshakeTimeoutMs,
      );
      client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (e) {
      client.close();
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return client;
  }

  /** Returns what the server advertises, not what is permitted; `callTool` enforces the allowlist. */
  async listTools(): Promise<string[]> {
    const r = await this.request("tools/list", {});
    const tools = isRecord(r) && Array.isArray(r.tools) ? (r.tools as unknown[]) : [];
    return tools
      .map((t) => (isRecord(t) ? t.name : undefined))
      .filter((n): n is string => typeof n === "string");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Enforced before anything is written to the child.
    if (!this.allowed.has(name)) {
      throw new McpPolicyError(`Tool "${name}" is not on the allowlist.`);
    }
    return this.request("tools/call", { name, arguments: args });
  }

  /** Last 64 KiB of the child's stderr, secrets masked. Safe to log (§84 tool.log). */
  stderrTail(): string {
    let start = 0;
    while (start < this.stderrRaw.length && isContinuationByte(this.stderrRaw[start])) start++;
    // Redact the whole bounded buffer first, then cut: a secret straddling the cut is masked whole.
    const redacted = Buffer.from(
      redactSecrets(
        this.stderrRaw.subarray(start, completeUtf8End(this.stderrRaw)).toString("utf8"),
        this.secrets,
      ),
      "utf8",
    );
    let cut = Math.max(0, redacted.length - STDERR_CAP);
    while (cut < redacted.length && isContinuationByte(redacted[cut])) cut++; // never split UTF-8
    return redacted.subarray(cut).toString("utf8");
  }

  close(): void {
    this.shutdown(new Error("The analysis engine connection was closed."));
  }

  /** Idempotent: mark dead, kill the child, reject every pending call, drop buffers. */
  private shutdown(reason: Error): void {
    const first = !this.dead;
    this.dead = true;
    if (first) {
      this.partialBuf = EMPTY;
      this.partialBytes = 0;
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      try {
        this.proc.child.stdin?.destroy(); // frees anything the child never read
      } catch {
        /* already gone */
      }
    }
    this.failAll(reason);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  /** Throws if the message cannot be written; callers turn that into a rejection. */
  private writeLine(message: object, onError?: (e: Error) => void): void {
    const stdin = this.proc.child.stdin;
    if (this.dead || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("The analysis engine is not running.");
    }
    const line = `${JSON.stringify(message)}\n`;
    stdin.write(line, (err) => {
      if (err) onError?.(err);
    });
    // A child that stops reading while we keep answering/asking would otherwise queue without bound.
    if (stdin.writableLength > STDIN_BACKLOG_CAP + Buffer.byteLength(line, "utf8")) {
      this.shutdown(new McpPolicyError("The analysis engine stopped reading its input."));
    }
  }

  /** Best-effort write that never throws (notifications, refusals). */
  private send(message: object): void {
    try {
      this.writeLine(message);
    } catch {
      /* engine already stopped; nothing to tell */
    }
  }

  private request(
    method: string,
    params: object,
    timeoutMs: number = this.callTimeoutMs,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const settle = (err: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(err);
      };
      const timer = setTimeout(() => settle(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        // JSON.stringify can throw (BigInt, cycles) and write can throw after end.
        this.writeLine({ jsonrpc: "2.0", id, method, params }, () =>
          settle(new Error("The analysis engine stopped.")),
        );
      } catch (e) {
        settle(e instanceof Error ? e : new Error("Could not send the request."));
      }
    });
  }

  private onStderr(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const joined = this.stderrRaw.length === 0 ? bytes : Buffer.concat([this.stderrRaw, bytes]);
    // Copy so a tiny tail does not pin a whole pooled chunk.
    this.stderrRaw = Buffer.from(joined.subarray(Math.max(0, joined.length - this.stderrLimit)));
  }

  private onData(chunk: Buffer | string): void {
    if (this.dead) return;
    try {
      let rest = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      while (rest.length > 0) {
        // Only the newly arrived bytes are scanned; the unterminated head of a line is carried over.
        const nl = rest.indexOf(NEWLINE);
        if (nl === -1) {
          // Checked before a newline ever shows up, so one endless line cannot grow memory unbounded.
          if (this.partialBytes + rest.length > this.maxMessageBytes) this.tooLarge();
          else this.appendPartial(rest);
          return;
        }
        if (this.partialBytes + nl > this.maxMessageBytes) {
          this.tooLarge();
          return;
        }
        const head = rest.subarray(0, nl);
        let line = head;
        if (this.partialBytes > 0) {
          this.appendPartial(head);
          line = this.partialBuf.subarray(0, this.partialBytes);
        }
        rest = rest.subarray(nl + 1);
        const text = line.toString("utf8");
        this.partialBytes = 0;
        if (this.partialBuf.length > KEEP_PARTIAL_CAPACITY) this.partialBuf = EMPTY;
        this.onLine(text);
        if (this.dead) return;
      }
    } catch {
      this.shutdown(new Error("The analysis engine sent unreadable output."));
    }
  }

  private appendPartial(chunk: Buffer): void {
    const need = this.partialBytes + chunk.length;
    if (need > this.partialBuf.length) {
      const grown = Buffer.allocUnsafe(
        Math.max(need, this.partialBuf.length * 2, MIN_PARTIAL_CAPACITY),
      );
      this.partialBuf.copy(grown, 0, 0, this.partialBytes);
      this.partialBuf = grown;
    }
    chunk.copy(this.partialBuf, this.partialBytes);
    this.partialBytes = need;
  }

  private tooLarge(): void {
    this.shutdown(new Error("The engine sent a message that was too large."));
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray non-protocol output is ignored
    }
    if (!isRecord(msg)) return;
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // A server→client request (e.g. sampling, roots): never executed.
        this.refusedRequests += 1;
        if (this.refusedRequests > MAX_REFUSED_REQUESTS) {
          this.shutdown(new McpPolicyError("The analysis engine sent too many requests."));
          return;
        }
        const id =
          typeof msg.id === "number" ||
          (typeof msg.id === "string" && msg.id.length <= MAX_ECHOED_ID_CHARS)
            ? msg.id
            : null;
        this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not supported" } });
      }
      return; // notifications are ignored
    }
    // Only ids we issued are numbers; anything else (strings like "__proto__" included) is dropped.
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return; // unknown, late or duplicate response
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const m = isRecord(msg.error) ? msg.error.message : undefined;
      p.reject(
        new McpServerError(
          typeof m === "string" ? truncateText(m, MAX_ERROR_MESSAGE_CHARS) : "engine error",
        ),
      );
    } else {
      p.resolve(msg.result);
    }
  }
}

function validateOptions(opts: McpOptions): void {
  if (!Number.isFinite(opts.maxMessageBytes) || opts.maxMessageBytes <= 0) {
    throw new Error("maxMessageBytes must be a finite number greater than 0.");
  }
  if (!Number.isFinite(opts.callTimeoutMs) || opts.callTimeoutMs <= 0) {
    throw new Error("callTimeoutMs must be a finite number greater than 0.");
  }
  const h = opts.handshakeTimeoutMs;
  if (h !== undefined && (!Number.isFinite(h) || h <= 0)) {
    throw new Error("handshakeTimeoutMs must be a finite number greater than 0.");
  }
}

export function mcpToolHost(client: McpClient): ToolHost {
  return { call: (tool, args) => client.callTool(tool, args) };
}
