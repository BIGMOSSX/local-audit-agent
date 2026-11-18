import type { AuditEngine, EngineResult } from "../engine";
import type { Finding } from "../finding";
import type { AuditTask } from "../plan";

export interface FakeEngineOptions {
  id?: string;
  applicable?: boolean;
  withRunTests?: boolean;
  throwIn?: "detect" | "plan" | "execute" | "normalize";
  needsNetwork?: boolean;
  emitInvalid?: boolean;
  hostileText?: boolean;
  duplicate?: boolean;
}

function fnv(seed: string, salt: number): string {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (const ch of seed) h = Math.imul(h ^ (ch.codePointAt(0) as number), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}
const fakeId = (seed: string) => [0, 1, 2, 3].map((s) => fnv(seed, s)).join("");

export function createFakeEngine(opts: FakeEngineOptions = {}): AuditEngine {
  const id = opts.id ?? "fake";
  const task = (
    name: string,
    title: string,
    scope: string[],
    readOnly: boolean,
    networkRequired: boolean,
  ): AuditTask => ({
    id: `${id}.${name}`,
    engine: id,
    kind: `${id}.${name}`,
    title,
    scope,
    readOnly,
    networkRequired,
  });
  return {
    id,
    async detect() {
      if (opts.throwIn === "detect") throw new Error("detect exploded");
      return { applicable: opts.applicable ?? true, reason: "fake" };
    },
    async plan(ctx) {
      if (opts.throwIn === "plan") throw new Error("plan exploded");
      const tasks = [task("scan", "Scan", [...ctx.files], true, false)];
      if (opts.withRunTests) tasks.push(task("run-tests", "Run tests", [], false, false));
      if (opts.needsNetwork) tasks.push(task("net", "Online check", [], true, true));
      return { projectPath: ctx.rootDir, tasks };
    },
    async execute(t): Promise<EngineResult> {
      if (opts.throwIn === "execute") throw new Error("execute exploded");
      return { taskId: t.id, status: "ok", data: { files: t.scope } };
    },
    normalize(result): Finding[] {
      if (opts.throwIn === "normalize") throw new Error("normalize exploded");
      if (result.taskId.endsWith("run-tests")) return [];
      const files = (result.data as { files: string[] }).files;
      const message = opts.hostileText
        ? `\u001b[31mbad\u0000 ${"x".repeat(5000)}`
        : "Fake finding.";
      const out: Finding[] = files.map((file) => ({
        id: fakeId(`${id}:${file}`),
        engine: id,
        ruleId: `${id}.demo`,
        title: `Demo finding for ${file}`,
        severity: "info",
        confidence: "low",
        category: "quality",
        source: "heuristic",
        file,
        message: message.slice(0, 2000),
        evidence: [],
      }));
      const first = out[0];
      if (opts.emitInvalid && first) out.push({ ...first, id: "not-hex" });
      if (opts.duplicate && first) return [first, first];
      return out;
    },
  };
}
