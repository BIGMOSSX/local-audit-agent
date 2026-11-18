import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createQualityEngine } from "@audit/engine-quality";
import { openDb } from "./db";
import { detectProject } from "./detect";
import { generateEndpoint, generateToken } from "./endpoint";
import { createEngineService } from "./engine-service";
import { createHandlers } from "./handlers";
import { createLogger } from "./logger";
import { createOrchestrator } from "./orchestrator";
import { ProjectsRepo } from "./projects-repo";
import { RunsRepo } from "./runs-repo";
import { killAllManaged } from "./sandbox/run";
import { startIpcServer } from "./server";

function parseDataDir(argv: string[]): string {
  const i = argv.indexOf("--data-dir");
  const value = i === -1 ? undefined : argv[i + 1];
  if (!value || !isAbsolute(value)) {
    throw new Error("usage: main.js --data-dir <absolute directory>");
  }
  return value;
}

async function main(): Promise<void> {
  const dataDir = parseDataDir(process.argv.slice(2));
  const token = generateToken();
  const log = createLogger({ file: join(dataDir, "logs", "auditd.log"), secrets: [token] });
  const db = openDb(join(dataDir, "audit.db"));
  const repo = new ProjectsRepo(db, { now: Date.now, newId: randomUUID });
  const runs = new RunsRepo(db, { now: Date.now, newId: randomUUID });
  // Only this daemon writes `running` rows, so any left over belong to one that is gone.
  const orphans = runs.failOrphans();
  if (orphans > 0) log.warn("marked interrupted audit runs as failed", { count: orphans });
  const service = createEngineService({
    engines: [createQualityEngine()],
    // No installer exists yet (tools.install); until it does an engine cannot be started, and the
    // run says so instead of pretending. Never bundle or auto-run a third-party engine here.
    hostFor: async () => {
      throw new Error("分析引擎尚未安装");
    },
    detect: detectProject,
    log: (line) => log.info("tool.log", { line }),
  });
  const orchestrator = createOrchestrator({
    projects: repo,
    runs,
    service,
    log: (line) => log.warn("audit", { line }),
  });
  const server = await startIpcServer({
    endpoint: generateEndpoint(),
    token,
    handlers: createHandlers({ repo, orchestrator }),
    log,
  });

  let stopping = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    killAllManaged(); // engine children and their process groups die before anything else closes
    log.info("shutting down", { reason });
    try {
      await orchestrator.shutdown();
      await server.close();
      db.close();
    } finally {
      process.exit(code);
    }
  };

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.stack ?? String(err) });
    void shutdown("uncaught exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: String(reason) });
    void shutdown("unhandled rejection", 1);
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.stdin.on("end", () => void shutdown("stdin closed", 0));
  process.stdin.on("error", () => void shutdown("stdin error", 0));
  process.stdin.resume();

  process.stdout.write(`${JSON.stringify({ ready: true, endpoint: server.endpoint, token })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `auditd failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
