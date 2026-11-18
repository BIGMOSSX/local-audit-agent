import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

export function makeTmp(prefix = "auditd-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  // Windows refuses to delete a file another process (or a not yet released handle) still has open;
  // rm retries EPERM/EBUSY/ENOTEMPTY itself when asked to.
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Smallest env a test child needs to start node. Windows cannot spawn node with PATH alone: it also needs SYSTEMROOT. */
export function minimalChildEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.platform === "win32") env.SYSTEMROOT = process.env.SYSTEMROOT ?? "C:\\Windows";
  return env;
}

/** `ps` state letters of `pid` ("S", "R", "Z", ...), or "" when ps lists no such process or cannot run. */
function psState(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // ps exits 1 when the pid is gone
  }
}

/**
 * Whether `pid` is a running process. A zombie (killed, waiting for its new parent to reap it) is not:
 * kill(pid, 0) still succeeds for it, and on macOS launchd reaps reparented orphans noticeably later than
 * the process group stops listing them, so a plain signal-0 probe reports a dead process as alive there.
 * Anything that is not a zombie still counts as alive. `readState` is injectable for tests.
 */
export function isProcessLive(pid: number, readState: (pid: number) => string = psState): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // ESRCH (gone). EPERM would mean the pid was reused by someone else's process.
  }
  if (process.platform === "win32") return true; // no zombies, and no ps
  const state = readState(pid);
  if (state === "") return false; // ps no longer lists it: it was reaped between the two probes
  return !state.startsWith("Z");
}
