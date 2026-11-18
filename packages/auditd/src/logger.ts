import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "@audit/shared";

type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface LoggerOptions {
  file: string;
  secrets: readonly string[];
  stderr?: boolean;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions): Logger {
  mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
  const now = opts.now ?? (() => new Date());

  const write = (level: "info" | "warn" | "error", msg: string, fields?: Fields): void => {
    const t = now().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ t, level, msg, ...fields });
    } catch {
      line = JSON.stringify({ t, level, msg });
    }
    line = redactSecrets(line, opts.secrets);
    try {
      appendFileSync(opts.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // a failing log sink must never take the daemon down
    }
    if (opts.stderr) process.stderr.write(`${line}\n`);
  };

  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
