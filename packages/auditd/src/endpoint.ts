import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const MAX_SOCKET_PATH_BYTES = 100;
const DIR_PREFIX = "audit-";
const SOCKET_NAME = "d.sock";
const isWindows = process.platform === "win32";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateEndpoint(): string {
  if (isWindows) return `\\\\.\\pipe\\audit-auditd-${randomBytes(16).toString("hex")}`;
  const dirName = `${DIR_PREFIX}${randomBytes(8).toString("hex")}`;
  for (const base of [tmpdir(), "/tmp"]) {
    const candidate = join(base, dirName, SOCKET_NAME);
    if (Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES) return candidate;
  }
  throw new Error("cannot build a Unix socket path short enough for this system");
}

export function prepareEndpoint(endpoint: string): void {
  if (isWindows) return;
  const dir = dirname(endpoint);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const info = lstatSync(dir);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `refusing socket location ${dir}: it must be a private directory owned by the current user`,
    );
  }

  try {
    if (!lstatSync(endpoint).isSocket())
      throw new Error(`refusing to replace ${endpoint}: it is not a socket`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  unlinkSync(endpoint);
}

export function disposeEndpoint(endpoint: string): void {
  if (isWindows) return;
  try {
    unlinkSync(endpoint);
  } catch {}
  const dir = dirname(endpoint);
  if (!basename(dir).startsWith(DIR_PREFIX)) return;
  try {
    rmdirSync(dir);
  } catch {}
}
