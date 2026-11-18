import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, arg] = process.argv.slice(2);
if (mode === "env") {
  process.stdout.write(JSON.stringify(process.env));
} else if (mode === "cwd") {
  process.stdout.write(process.cwd());
} else if (mode === "exit") {
  process.exit(Number(arg));
} else if (mode === "sleep") {
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  const chunk = "x".repeat(65536);
  const t = setInterval(() => process.stdout.write(chunk), 0);
  process.stdout.on("error", () => clearInterval(t));
} else if (mode === "grandchild") {
  const g = spawn(process.execPath, [fileURLToPath(import.meta.url), "sleep"], { stdio: "ignore" });
  writeFileSync(arg, String(g.pid));
  setInterval(() => {}, 1000);
} else if (mode === "orphan") {
  // Parent exits on its own, leaving a grandchild behind in the same process group.
  const g = spawn(process.execPath, [fileURLToPath(import.meta.url), "sleep"], { stdio: "ignore" });
  writeFileSync(arg, String(g.pid));
  setTimeout(() => process.exit(0), 100);
} else if (mode === "holdpipe") {
  // Exits at once but leaves a detached grandchild (own session) holding the inherited stdio open,
  // so neither the group sweep nor stdio close can finish `done` early. The grandchild self-exits.
  const g = spawn(process.execPath, [fileURLToPath(import.meta.url), "nap"], {
    stdio: "inherit",
    detached: true,
  });
  g.unref();
  writeFileSync(arg, String(g.pid));
  setTimeout(() => process.exit(0), 50);
} else if (mode === "nap") {
  setTimeout(() => process.exit(0), 3000);
} else if (mode === "stderr-raw") {
  process.stderr.write(arg);
} else if (mode === "stderr") {
  process.stderr.write(`boom api_key=${arg}\n`);
} else if (mode === "stdin-echo") {
  process.stdin.on("data", (d) => process.stdout.write(d));
}
