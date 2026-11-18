import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { redactSecrets } from "@audit/shared";

// The only place the daemon spawns third-party engine processes. Never reachable from IPC.
//
// Windows limit: Node has no Job Object, so a grandchild orphaned by a parent that exits on its
// own cannot be reaped. Timeout and cancel kill the whole tree with `taskkill /T /F`.
// POSIX limits: a member that calls setsid/setpgid leaves the group and escapes the sweep; the
// post-exit group wait is bounded at 2 s; children are detached, so they survive a hard SIGKILL of
// the daemon (only the graceful shutdown path reaches killAllManaged).
const live = new Set<ChildProcess>();

const GROUP_GONE_POLL_MS = 20;
const GROUP_GONE_MAX_MS = 2000;
const STDIO_DRAIN_MS = 1500;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MIN_STDERR_MARGIN = 4096;

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}
export interface ManagedProcess {
  child: ChildProcess;
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>;
  kill(): void;
}
export interface RunOptions extends SpawnOptions {
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdin?: string;
  secrets?: readonly string[];
}
export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** SIGKILL the child's whole process group (POSIX). ESRCH/EPERM are ignored: nothing of ours is left. */
function sweepGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
}

/**
 * Kill the child and everything it spawned. Safe to call repeatedly and after exit: once the child
 * has been reaped its pid may be reused, so we never signal it again (the single post-exit orphan
 * sweep lives in spawnManaged).
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const taskkill = root ? join(root, "System32", "taskkill.exe") : "taskkill";
    spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function killAllManaged(): void {
  for (const child of [...live]) killTree(child);
}
export const liveChildCount = (): number => live.size;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolves once no member of process group `pgid` remains (bounded; signal 0 sends nothing). */
async function waitGroupGone(pgid: number): Promise<void> {
  const deadline = Date.now() + GROUP_GONE_MAX_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return; // ESRCH: empty. EPERM: no longer our group.
    }
    await sleep(GROUP_GONE_POLL_MS);
  }
}

/** A process that never started: done resolves with a null exit code, nothing is registered. */
function failedSpawn(): ManagedProcess {
  return {
    child: new ChildProcess(),
    done: Promise.resolve({ exitCode: null, signal: null, timedOut: false }),
    kill: () => undefined,
  };
}

export function spawnManaged(o: SpawnOptions): ManagedProcess {
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) return failedSpawn();
  let child: ChildProcess;
  try {
    child = spawn(o.command, [...o.args], {
      cwd: o.cwd,
      env: { ...o.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return failedSpawn(); // e.g. a NUL byte in an argument: spawn throws synchronously
  }
  live.add(child);
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      killTree(child);
    },
    Math.min(o.timeoutMs, MAX_TIMER_MS),
  );

  // `done` resolves only after the child is reaped, its process group is swept and empty (POSIX) or
  // taskkill has finished (Windows), and its stdio has drained. Sandbox cleanup relies on that.
  const done = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      resolve({ exitCode, signal, timedOut });
    };
    const closed = new Promise<void>((r) => child.once("close", () => r()));
    child.on("error", () => {
      // Spawn failure (e.g. ENOENT): no pid, no exit event will follow.
      if (child.pid === undefined) finish(null, null);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer); // a clean exit is never reported as timed out by a timer firing mid-sweep
      void (async () => {
        const pid = child.pid;
        if (pid !== undefined && process.platform !== "win32") {
          sweepGroup(pid); // the one post-exit sweep: orphans still in the group
          await waitGroupGone(pid);
        }
        let drain: NodeJS.Timeout | undefined;
        await Promise.race([
          closed,
          new Promise<void>((r) => {
            drain = setTimeout(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
              r();
            }, STDIO_DRAIN_MS);
          }),
        ]);
        clearTimeout(drain);
        finish(code, signal);
      })();
    });
  });
  child.stdin?.on("error", () => undefined);
  return { child, done, kill: () => killTree(child) };
}

export async function runProcess(o: RunOptions): Promise<RunResult> {
  const proc = spawnManaged(o);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  // Capture a margin past the cap so a secret straddling the cap is seen whole and redacted
  // before the redacted text is cut to the cap.
  const secrets = o.secrets ?? [];
  const margin = Math.max(MIN_STDERR_MARGIN, ...secrets.map((x) => Buffer.byteLength(x, "utf8")));
  const errLimit = o.maxStderrBytes + margin;
  let errDropped = false;
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  proc.child.stdout?.on("data", (d: Buffer) => {
    if (truncated) return;
    const room = o.maxStdoutBytes - outBytes;
    out.push(d.subarray(0, Math.max(0, room)));
    outBytes += Math.min(d.length, Math.max(0, room));
    if (d.length > room) {
      truncated = true;
      proc.kill();
    }
  });
  proc.child.stderr?.on("data", (d: Buffer) => {
    const room = errLimit - errBytes;
    if (d.length > room) errDropped = true;
    if (room <= 0) return;
    err.push(d.subarray(0, room));
    errBytes += Math.min(d.length, room);
  });
  if (o.stdin !== undefined) proc.child.stdin?.end(o.stdin);
  else proc.child.stdin?.end();
  const r = await proc.done;
  const redacted = Buffer.from(redactSecrets(Buffer.concat(err).toString("utf8"), secrets), "utf8");
  let end = Math.min(redacted.length, o.maxStderrBytes);
  if (end < redacted.length) {
    while (end > 0 && ((redacted[end] ?? 0) & 0xc0) === 0x80) end--; // do not split a UTF-8 sequence
  }
  if (end < redacted.length || errDropped) truncated = true;
  return {
    ...r,
    truncated,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: redacted.subarray(0, end).toString("utf8"),
  };
}
