import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { disposeEndpoint } from "../src/endpoint";

export const MAIN_JS = fileURLToPath(new URL("../dist/main.js", import.meta.url));

export interface Sidecar {
  child: ChildProcessWithoutNullStreams;
  endpoint: string;
  token: string;
  stdout(): string;
  stderr(): string;
  stop(): Promise<number | null>;
  kill(): Promise<void>;
}

export function spawnDaemon(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [MAIN_JS, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

export async function startSidecar(dataDir: string): Promise<Sidecar> {
  const child = spawnDaemon(["--data-dir", dataDir]);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    err += d;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );

  const handshake = await new Promise<{ ready: boolean; endpoint: string; token: string }>(
    (resolve, reject) => {
      const fail = (reason: string) => {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`${reason}; stderr: ${err}`));
      };
      const timer = setTimeout(() => fail("no handshake within 15s"), 15_000);
      child.stdout.on("data", (d: string) => {
        out += d;
        const i = out.indexOf("\n");
        if (i === -1) return;
        try {
          const parsed = JSON.parse(out.slice(0, i));
          clearTimeout(timer);
          resolve(parsed);
        } catch {
          fail("unparseable handshake line");
        }
      });
      void exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`daemon exited (${code}) before the handshake; stderr: ${err}`));
      });
    },
  );

  return {
    child,
    endpoint: handshake.endpoint,
    token: handshake.token,
    stdout: () => out,
    stderr: () => err,
    async stop() {
      child.stdin.end();
      return exited;
    },
    async kill() {
      child.kill("SIGKILL");
      await exited;
      disposeEndpoint(handshake.endpoint);
    },
  };
}
