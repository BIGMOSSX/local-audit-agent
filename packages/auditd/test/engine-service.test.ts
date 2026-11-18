import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEngine, ExecutionContext, NotDone, ToolHost } from "@audit/audit-core";
import { createFakeEngine } from "@audit/audit-core/testing";
import { createCodeIntelligenceEngine } from "@audit/engine-code-intelligence";
import { createQualityEngine } from "@audit/engine-quality";
import { REDACTED } from "@audit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/detect";
import { createEngineService, type EngineHost, type EngineRunOptions } from "../src/engine-service";
import { childEnvFor, qualityEngineHostConfig, startMcpHost } from "../src/sandbox/host";
import { killAllManaged, liveChildCount } from "../src/sandbox/run";
import { createSandbox as realCreateSandbox, SandboxError } from "../src/sandbox/workspace";
import { cleanupTmp, makeTmp } from "./helpers";

const server = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const TMP_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const savedTmp = Object.fromEntries(TMP_KEYS.map((k) => [k, process.env[k]]));
const SECRET = "abcd1234efgh";
const OPTS: EngineRunOptions = { changedFiles: [], userCode: { allowed: false } };

afterEach(() => {
  killAllManaged();
  for (const k of TMP_KEYS) {
    const v = savedTmp[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupTmp();
});

function project(files: Record<string, string>): string {
  const dir = join(realpathSync.native(makeTmp()), "proj");
  mkdirSync(dir, { recursive: true });
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), c);
  }
  return dir;
}
/** Points os.tmpdir() at a fresh directory so a test can see every sandbox the code under test leaves behind. */
function privateTmp(): string {
  const dir = realpathSync.native(makeTmp("auditd-priv-"));
  for (const k of TMP_KEYS) process.env[k] = dir;
  return dir;
}
const sandboxesIn = (dir: string): string[] =>
  readdirSync(dir).filter((n) => n.startsWith("audit-sb-"));

const noHost = async (): Promise<EngineHost> => ({ host: null, close: () => undefined });
/** Wraps the real createSandbox and remembers each root, so tests assert on THEIR sandbox. */
function trackedSandbox() {
  const roots: string[] = [];
  const projectDirs: string[] = [];
  const create: typeof realCreateSandbox = async (p, l) => {
    const sb = await realCreateSandbox(p, l);
    roots.push(sb.root);
    projectDirs.push(sb.projectDir);
    return sb;
  };
  return { roots, projectDirs, create };
}
/** A fake engine whose execute first runs `act` against the tool host and the runtime. */
function engineThatCalls(
  id: string,
  act: (tools: ToolHost | null, rt: ExecutionContext) => Promise<void>,
): AuditEngine {
  const base = createFakeEngine({ id });
  return {
    ...base,
    async execute(task, rt) {
      await act(rt.tools, rt);
      return base.execute(task, rt);
    },
  };
}
const json = (v: unknown): string => JSON.stringify(v);
const textOf = (r: unknown): string =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("EngineService", () => {
  it("runs engines against the sandbox copy, merges findings, and removes the sandbox", async () => {
    const sb = trackedSandbox();
    const dir = project({
      "package.json": "{}",
      "src/a.ts": "a",
      ".claude/x": "secret",
      ".env": "K=v",
    });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
      createSandbox: sb.create,
    });
    const r = await svc.run(dir, OPTS);
    expect(r.findings.map((f) => f.file).sort()).toEqual(["package.json", "src/a.ts"]);
    expect(r.completeness).toBe("complete");
    expect(sb.roots).toHaveLength(1);
    expect(existsSync(sb.roots[0] as string)).toBe(false);
  });
  it("engines are given the sandbox copy, never the real project", async () => {
    const sb = trackedSandbox();
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const seen: string[] = [];
    const svc = createEngineService({
      engines: [engineThatCalls("probe", async (_t, rt) => void seen.push(rt.projectDir))],
      hostFor: noHost,
      detect: detectProject,
      createSandbox: sb.create,
    });
    await svc.run(dir, OPTS);
    expect(seen).toEqual(sb.projectDirs);
    expect(seen[0]).not.toBe(dir);
    expect((seen[0] as string).startsWith(sb.roots[0] as string)).toBe(true);
  });
  it("a project too large to copy becomes a notDone result and leaves no sandbox behind", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}", "a.ts": "a", "b.ts": "b" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
      createSandbox: (p) => realCreateSandbox(p, { maxFiles: 1 }),
    });
    const r = await svc.run(dir, OPTS);
    expect(r.completeness).toBe("partial");
    expect(r.findings).toEqual([]);
    expect(r.notDone.map((n) => n.what)).toContain("项目隔离副本");
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("any other SandboxError (project changed during copy) is also a notDone", async () => {
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
      createSandbox: async () => {
        throw new SandboxError("io", "The project changed while it was being copied.");
      },
    });
    const r = await svc.run(dir, OPTS);
    expect(r.notDone.map((n) => n.what)).toContain("项目隔离副本");
    expect(r.completeness).toBe("partial");
  });
  it("a detect failure or a missing project is a notDone, not an exception", async () => {
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: async () => {
        throw new Error(`cannot read api_key=${SECRET}`);
      },
    });
    const r = await svc.run("/nonexistent", OPTS);
    expect(r.completeness).toBe("partial");
    expect(json(r.notDone)).not.toContain(SECRET);
  });
  it("a non-applicable engine starts no host and no sandbox", async () => {
    let hosts = 0;
    let boxes = 0;
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine({ applicable: false })],
      hostFor: async () => {
        hosts += 1;
        return { host: null, close: () => undefined };
      },
      detect: detectProject,
      createSandbox: async (p, l) => {
        boxes += 1;
        return realCreateSandbox(p, l);
      },
    });
    const r = await svc.run(dir, OPTS);
    expect(hosts).toBe(0);
    expect(boxes).toBe(0);
    expect(r.completeness).toBe("partial");
  });
  it("a run where no engine applies checked nothing: partial, the engine is named, engines[] says why", async () => {
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine({ id: "idle", applicable: false })],
      hostFor: noHost,
      detect: detectProject,
    });
    const r = await svc.run(dir, OPTS);
    expect(r.completeness).not.toBe("complete");
    expect(r.findings).toEqual([]);
    expect(r.notDone).toEqual([{ what: "idle: 全部检查", reason: "不适用于此项目（fake）" }]);
    expect(r.engines).toEqual([{ id: "idle", applicable: false, tasks: [] }]);
  });
  it("an inapplicable detect reason is cleaned like any engine text", async () => {
    const dir = project({ "package.json": "{}" });
    const base = createFakeEngine({ id: "idle" });
    const leaky: AuditEngine = {
      ...base,
      detect: async () => ({ applicable: false, reason: `no api_key=${SECRET}\u200b here` }),
    };
    const r = await createEngineService({
      engines: [leaky],
      hostFor: noHost,
      detect: detectProject,
    }).run(dir, OPTS);
    expect(json(r.notDone)).not.toContain(SECRET);
    expect(r.notDone[0]?.what).toBe("idle: 全部检查");
    expect(r.completeness).toBe("partial");
  });
  it("mixed applicable and inapplicable engines: the applicable one runs, the other is named, result partial", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [
        createFakeEngine({ id: "idle", applicable: false }),
        createFakeEngine({ id: "busy" }),
      ],
      hostFor: noHost,
      detect: detectProject,
    });
    const r = await svc.run(dir, OPTS);
    expect(r.findings.some((f) => f.engine === "busy")).toBe(true);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.map((n) => n.what)).toEqual(["idle: 全部检查"]);
    expect(r.engines).toEqual([
      { id: "idle", applicable: false, tasks: [] },
      { id: "busy", applicable: true, tasks: [{ id: "busy.scan", status: "ok" }] },
    ]);
  });
  it("engines[] reports per-task status (ids and status only) and an all-ok run stays complete", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [createFakeEngine({ withRunTests: true })],
      hostFor: noHost,
      detect: detectProject,
    });
    const skipped = await svc.run(dir, OPTS);
    expect(skipped.engines).toEqual([
      {
        id: "fake",
        applicable: true,
        tasks: [
          { id: "fake.scan", status: "ok" },
          { id: "fake.run-tests", status: "skipped" },
        ],
      },
    ]);
    const ok = await createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
    }).run(dir, OPTS);
    expect(ok.completeness).toBe("complete");
    expect(ok.notDone).toEqual([]);
    expect(ok.engines).toEqual([
      { id: "fake", applicable: true, tasks: [{ id: "fake.scan", status: "ok" }] },
    ]);
    for (const e of ok.engines)
      for (const t of e.tasks) expect(Object.keys(t).sort()).toEqual(["id", "status"]);
  });
  it("redacts secrets in notDone text that runEngine produced (audit-core cannot redact)", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const leaky: AuditEngine = {
      ...createFakeEngine(),
      async execute(): Promise<never> {
        throw new Error(`engine failed api_key=${SECRET}`);
      },
    };
    const svc = createEngineService({ engines: [leaky], hostFor: noHost, detect: detectProject });
    const r = await svc.run(dir, OPTS);
    expect(r.notDone.length).toBeGreaterThan(0);
    expect(json(r.notDone)).not.toContain(SECRET);
  });
  it("a secret straddling runEngine's 300-char cut in a thrown message does not survive", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const lines: string[] = [];
    const secret = "sk-Zq9Xv7Lm3Kp5Rt8WaB2c";
    const leaky: AuditEngine = {
      ...createFakeEngine(),
      async execute(): Promise<never> {
        throw new Error(`${"x".repeat(285)} ${secret} tail`);
      },
    };
    const svc = createEngineService({
      engines: [leaky],
      hostFor: noHost,
      detect: detectProject,
      log: (l) => lines.push(l),
    });
    const r = await svc.run(dir, OPTS);
    expect(r.notDone.length).toBeGreaterThan(0);
    expect(json([r.notDone, lines])).not.toContain("sk-Zq9");
  });
  it("a secret straddling the cut in a result note, or in a tool-call rejection, does not survive", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const secret = "sk-Zq9Xv7Lm3Kp5Rt8WaB2c";
    const base = createFakeEngine();
    const viaNote: AuditEngine = {
      ...base,
      async execute(task) {
        return {
          taskId: task.id,
          status: "failed",
          data: null,
          note: `${"y".repeat(285)} ${secret}`,
        };
      },
    };
    const viaTool = engineThatCalls("tool", async (t) => {
      await t?.call("x", {});
    });
    const rejecting = async (): Promise<EngineHost> => ({
      host: {
        call: async () => {
          throw new Error(`${"z".repeat(285)} ${secret}`);
        },
      },
      close: () => undefined,
    });
    const r1 = await createEngineService({
      engines: [viaNote],
      hostFor: noHost,
      detect: detectProject,
    }).run(dir, OPTS);
    const r2 = await createEngineService({
      engines: [viaTool],
      hostFor: rejecting,
      detect: detectProject,
    }).run(dir, OPTS);
    expect(r1.notDone.length).toBeGreaterThan(0);
    expect(r2.notDone.length).toBeGreaterThan(0);
    expect(json([r1.notDone, r2.notDone])).not.toContain("sk-Zq9");
  });
  it("strips hidden characters from notDone text before redacting", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const sneaky: AuditEngine = {
      ...createFakeEngine(),
      async execute(): Promise<never> {
        throw new Error(`failed api_key=abcd​1234efgh \u001b[31mred`);
      },
    };
    const svc = createEngineService({ engines: [sneaky], hostFor: noHost, detect: detectProject });
    const r = await svc.run(dir, OPTS);
    const text = json(r.notDone);
    expect(text).not.toContain("1234efgh");
    expect(text).not.toContain("\\u200b");
    expect(text).not.toContain("\\u001b");
  });
  it("forwards a host's diagnostics to the tool log only after the host is closed", async () => {
    const dir = project({ "package.json": "{}" });
    const lines: string[] = [];
    const order: string[] = [];
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => ({
        host: null,
        close: async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push("closed");
        },
        diagnostics: () => {
          order.push("diagnostics");
          return `stderr tail api_key=${SECRET}`;
        },
      }),
      detect: detectProject,
      log: (l) => lines.push(l),
    });
    await svc.run(dir, OPTS);
    expect(order).toEqual(["closed", "diagnostics"]);
    expect(lines.some((l) => l.includes("fake") && l.includes("stderr tail"))).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
  it("caps and sanitizes log lines, and survives a throwing log sink", async () => {
    const dir = project({ "package.json": "{}" });
    const lines: string[] = [];
    const big: EngineHost = {
      host: null,
      close: () => undefined,
      diagnostics: () => `\u001b[31m${"x".repeat(100_000)}`,
    };
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => big,
      detect: detectProject,
      log: (l) => lines.push(l),
    });
    await svc.run(dir, OPTS);
    expect(lines).toHaveLength(1);
    expect((lines[0] as string).length).toBeLessThanOrEqual(4100);
    expect(lines[0]).not.toContain("\u001b");
    const throwing = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => big,
      detect: detectProject,
      log: () => {
        throw new Error("sink down");
      },
    });
    expect((await throwing.run(dir, OPTS)).completeness).toBe("complete");
  });
  it("without consent, a run-tests task is skipped and the result is partial (§16)", async () => {
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine({ withRunTests: true })],
      hostFor: noHost,
      detect: detectProject,
    });
    const r = await svc.run(dir, OPTS);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.map((n) => n.what)).toContain("运行项目测试");
  });
  it("a broken engine is reported, not thrown, and other engines still run", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [
        createFakeEngine({ id: "bad", throwIn: "execute" }),
        createFakeEngine({ id: "good" }),
      ],
      hostFor: noHost,
      detect: detectProject,
    });
    const r = await svc.run(dir, OPTS);
    expect(r.findings.some((f) => f.engine === "good")).toBe(true);
    expect(r.completeness).toBe("partial");
  });
  it("a host factory that throws becomes a notDone with no secret, and the sandbox is removed", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => {
        throw new Error(`spawn failed api_key=${SECRET}`);
      },
      detect: detectProject,
    });
    const r = await svc.run(dir, OPTS);
    expect(json(r.notDone)).not.toContain(SECRET);
    expect(r.completeness).toBe("partial");
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("closes the host even when the engine throws", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    let closed = 0;
    const svc = createEngineService({
      engines: [createFakeEngine({ throwIn: "execute" })],
      hostFor: async () => ({
        host: null,
        close: () => {
          closed += 1;
        },
      }),
      detect: detectProject,
    });
    await svc.run(dir, OPTS);
    expect(closed).toBe(1);
  });
  it("a close() that throws does not break the run or the sandbox cleanup", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => ({
        host: null,
        close: () => {
          throw new Error("close failed");
        },
      }),
      detect: detectProject,
    });
    expect((await svc.run(dir, OPTS)).completeness).toBe("complete");
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("a run that is already aborted creates no sandbox and no host", async () => {
    const priv = privateTmp();
    const ac = new AbortController();
    ac.abort();
    let hosts = 0;
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => {
        hosts += 1;
        return { host: null, close: () => undefined };
      },
      detect: detectProject,
    });
    const r = await svc.run(dir, { ...OPTS, signal: ac.signal });
    expect(r.completeness).toBe("partial");
    expect(hosts).toBe(0);
    expect(sandboxesIn(priv)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
  it("cleans the sandbox up when the run is aborted after the sandbox exists", async () => {
    const sb = trackedSandbox();
    const ac = new AbortController();
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: async () => {
        ac.abort();
        return { host: null, close: () => undefined };
      },
      detect: detectProject,
      createSandbox: sb.create,
    });
    const r = await svc.run(dir, { ...OPTS, signal: ac.signal });
    expect(r.completeness).toBe("partial");
    expect(sb.roots).toHaveLength(1);
    expect(existsSync(sb.roots[0] as string)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
  it("does not modify the real project", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const snapshot = readdirSync(dir).sort();
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
    });
    await svc.run(dir, OPTS);
    expect(readdirSync(dir).sort()).toEqual(snapshot);
  });
  it("is not reachable through IPC: handlers do not import it", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/handlers.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("engine-service");
    expect(src).not.toContain("sandbox/");
  });
});

describe("EngineService: oversize files and impact text", () => {
  it("a file over the 10 MiB cap is not checked, and the run says so (partial)", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    writeFileSync(join(dir, "huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = await createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
    }).run(dir, OPTS);
    expect(r.completeness).toBe("partial");
    expect(r.notDone).toEqual([{ what: "超大文件", reason: "1 个超过 10 MiB 的文件未检查" }]);
    expect(r.findings.some((f) => f.file === "huge.bin")).toBe(false);
  });
  it("redacts engine-supplied impact text (evidence text, business domain) and keeps paths and numbers", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "a" });
    const base = createFakeEngine({ id: "impactful" });
    const withImpact = {
      ...base,
      async impact() {
        return {
          changedFiles: ["src/a.ts"],
          directDependencies: [{ file: "src/a.ts", dependsOn: ["src/b.ts"] }],
          affectedFiles: ["src/b.ts"],
          complexity: [{ file: "src/a.ts", score: 7 }],
          businessDomain: `billing api_key=${SECRET}`,
          evidence: [
            {
              kind: "graph" as const,
              file: "src/a.ts",
              startLine: 3,
              text: `edge token=${SECRET}\u200b`,
            },
          ],
        };
      },
    };
    const r = await createEngineService({
      engines: [withImpact],
      hostFor: noHost,
      detect: detectProject,
    }).run(dir, { changedFiles: ["src/a.ts"], userCode: { allowed: false } });
    expect(json(r.impact)).not.toContain(SECRET);
    expect(r.impact.businessDomain).toContain(REDACTED);
    expect(r.impact.evidence[0]?.text).toContain(REDACTED);
    expect(r.impact.evidence[0]).toMatchObject({ kind: "graph", file: "src/a.ts", startLine: 3 });
    expect(r.impact.affectedFiles).toEqual(["src/b.ts"]);
    expect(r.impact.complexity).toEqual([{ file: "src/a.ts", score: 7 }]);
  });
});

describe("EngineService: engine output redaction", () => {
  const runWith = async (engine: AuditEngine) => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const lines: string[] = [];
    const r = await createEngineService({
      engines: [engine],
      hostFor: noHost,
      detect: detectProject,
      log: (l) => lines.push(l),
    }).run(dir, OPTS);
    return { r, lines };
  };

  it("redacts secrets in every free-text field of a normalized finding", async () => {
    const base = createFakeEngine();
    const leaky: AuditEngine = {
      ...base,
      normalize: (res) =>
        base.normalize(res).map((f) => ({
          ...f,
          title: `title api_key=${SECRET}`,
          message: `message api_key=${SECRET}`,
          evidence: [{ kind: "log" as const, text: `evidence token=${SECRET}` }],
          remediation: `remediation password=${SECRET}`,
          verifyAfterFix: [`run check --api_key=${SECRET}`],
        })),
    };
    const { r } = await runWith(leaky);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(json(r.findings)).not.toContain(SECRET);
    const f = r.findings[0];
    expect(f?.message).toContain(REDACTED);
    expect(f?.title).toContain(REDACTED);
    expect(f?.evidence[0]?.text).toContain(REDACTED);
    expect(f?.remediation).toContain(REDACTED);
    expect(f?.verifyAfterFix?.[0]).toContain(REDACTED);
  });
  it("redacts across hidden characters and leaves ids, paths, enums and numbers alone", async () => {
    const base = createFakeEngine();
    const leaky: AuditEngine = {
      ...base,
      normalize: (res) =>
        base.normalize(res).map((f) => ({
          ...f,
          line: 7,
          message: `m api_key=abcd\u200b1234efgh`,
        })),
    };
    const clean = base.normalize({ taskId: "fake.scan", status: "ok", data: { files: ["a.ts"] } });
    const { r } = await runWith(leaky);
    expect(json(r.findings)).not.toContain("1234efgh");
    const f = r.findings.find((x) => x.file === "a.ts");
    expect(f).toMatchObject({
      id: clean[0]?.id,
      engine: "fake",
      severity: "info",
      line: 7,
      file: "a.ts",
    });
  });
  it("a secret straddling the message cap does not survive", async () => {
    const secret = "sk-Zq9Xv7Lm3Kp5Rt8WaB2c";
    const base = createFakeEngine();
    const leaky: AuditEngine = {
      ...base,
      normalize: (res) =>
        base.normalize(res).map((f) => ({ ...f, message: `${"x".repeat(1990)} ${secret}` })),
    };
    const { r } = await runWith(leaky);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(json(r.findings)).not.toContain("sk-Zq9");
  });
  it("a lazy iterable from normalize is materialised inside the wrapper: its throw is cleaned", async () => {
    const base = createFakeEngine();
    const lazy: AuditEngine = {
      ...base,
      normalize: () =>
        (function* () {
          yield* [];
          throw new Error(`${"l".repeat(285)} lazy boom sk-Zq9Xv7Lm3Kp5Rt8WaB2c api_key=${SECRET}`);
        })() as unknown as ReturnType<AuditEngine["normalize"]>,
    };
    const { r, lines } = await runWith(lazy);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.length).toBeGreaterThan(0);
    expect(json([r.notDone, lines])).not.toContain(SECRET);
    expect(json([r.notDone, lines])).not.toContain("sk-Zq9");
  });
  it("normalize returning a non-list is still reported", async () => {
    const base = createFakeEngine();
    const bad: AuditEngine = {
      ...base,
      normalize: () => 5 as unknown as ReturnType<AuditEngine["normalize"]>,
    };
    const { r } = await runWith(bad);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.length).toBeGreaterThan(0);
  });
  it("a null-prototype value thrown by detect does not break the service", async () => {
    const base = createFakeEngine();
    const hostile: AuditEngine = {
      ...base,
      detect: async () => {
        throw Object.create(null);
      },
    };
    const { r } = await runWith(hostile);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.length).toBeGreaterThan(0);
  });
  it.each(["detect", "plan", "execute", "normalize"] as const)(
    "a throwing %s with a secret in its message leaves no secret in notDone or the log",
    async (stage) => {
      const base = createFakeEngine();
      const boom = () => new Error(`${stage} failed api_key=${SECRET} ${"q".repeat(400)}`);
      const engine: AuditEngine = {
        ...base,
        detect: async (c) => {
          if (stage === "detect") throw boom();
          return base.detect(c);
        },
        plan: async (c, i) => {
          if (stage === "plan") throw boom();
          return base.plan(c, i);
        },
        execute: async (t, rt) => {
          if (stage === "execute") throw boom();
          return base.execute(t, rt);
        },
        normalize: (res) => {
          if (stage === "normalize") throw boom();
          return base.normalize(res);
        },
      };
      const { r, lines } = await runWith(engine);
      expect(r.notDone.length).toBeGreaterThan(0);
      expect(json([r.notDone, lines])).not.toContain(SECRET);
    },
  );
});

describe("EngineService with real tool hosts", () => {
  it("end to end through a real MCP child: the host is closed and no child survives", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}" });
    const calls: unknown[] = [];
    const svc = createEngineService({
      engines: [
        engineThatCalls("mcp-fake", async (t) => {
          calls.push(await t?.call("echo", { hello: "world" }));
        }),
      ],
      detect: detectProject,
      hostFor: (_id, sandbox) => startMcpHost({ entry: server, allowedTools: ["echo"] }, sandbox),
    });
    const r = await svc.run(dir, OPTS);
    expect(r.completeness).toBe("complete");
    expect(calls).toHaveLength(1);
    expect(liveChildCount()).toBe(0);
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("an abort closes a hung engine call promptly: partial result, no child, no sandbox", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const ac = new AbortController();
    const svc = createEngineService({
      engines: [
        engineThatCalls("hang", async (t) => {
          setTimeout(() => ac.abort(), 300);
          await t?.call("slow", {});
        }),
      ],
      detect: detectProject,
      hostFor: (_id, sandbox) => startMcpHost({ entry: server, allowedTools: ["slow"] }, sandbox),
    });
    const started = Date.now();
    const r = await svc.run(dir, { ...OPTS, signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.completeness).toBe("partial");
    expect(liveChildCount()).toBe(0);
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("an abort while the host is still handshaking returns promptly: no child, no sandbox, partial", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const ac = new AbortController();
    const svc = createEngineService({
      engines: [createFakeEngine({ id: "mute" })],
      detect: detectProject,
      hostFor: (_id, sandbox, signal) =>
        startMcpHost(
          { entry: server, allowedTools: ["echo"], env: { FAKE_MCP_NO_INIT: "1" } },
          sandbox,
          signal,
        ),
    });
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const r = await svc.run(dir, { ...OPTS, signal: ac.signal });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.completeness).toBe("partial");
    expect(r.findings).toEqual([]);
    expect(liveChildCount()).toBe(0);
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("an abort during engine 1 stops engine 2: its host is never started, partial, no child, no sandbox", async () => {
    const priv = privateTmp();
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const ac = new AbortController();
    const hostsFor: string[] = [];
    const svc = createEngineService({
      engines: [
        engineThatCalls("first", async (t) => {
          setTimeout(() => ac.abort(), 300);
          await t?.call("slow", {});
        }),
        createFakeEngine({ id: "second" }),
      ],
      detect: detectProject,
      hostFor: (id, sandbox) => {
        hostsFor.push(id);
        return startMcpHost({ entry: server, allowedTools: ["slow"] }, sandbox);
      },
    });
    const r = await svc.run(dir, { ...OPTS, signal: ac.signal });
    expect(hostsFor).toEqual(["first"]);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.some((n) => n.what.startsWith("second"))).toBe(true);
    expect(r.findings.some((f) => f.engine === "second")).toBe(false);
    expect(liveChildCount()).toBe(0);
    expect(sandboxesIn(priv)).toEqual([]);
  });
  it("redacts and sanitizes server-supplied error text (McpServerError)", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const svc = createEngineService({
      engines: [
        engineThatCalls("mcp-fake", async (t) => {
          await t?.call("fail", { message: `boom api_key=${SECRET}​ \u001b[31mred` });
        }),
      ],
      detect: detectProject,
      hostFor: (_id, sandbox) => startMcpHost({ entry: server, allowedTools: ["fail"] }, sandbox),
    });
    const r = await svc.run(dir, OPTS);
    expect(r.completeness).toBe("partial");
    expect(r.notDone.some((n) => n.reason.includes("boom"))).toBe(true);
    const text = json(r.notDone);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("\\u001b");
  });
  it("logs the engine's stderr tail after it exited: redacted, capped, configured secrets masked", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const lines: string[] = [];
    const literal = "tok-literal-0123456789";
    const svc = createEngineService({
      engines: [
        engineThatCalls("mcp-fake", async (t) => {
          await t?.call("straddle", { pre: 10, secret: literal, post: 10 });
        }),
      ],
      detect: detectProject,
      hostFor: (_id, sandbox) =>
        startMcpHost({ entry: server, allowedTools: ["straddle"], secrets: [literal] }, sandbox),
      log: (l) => lines.push(l),
    });
    await svc.run(dir, OPTS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mcp-fake stderr: pppppppppp");
    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]).not.toContain(literal);
  });
  it("a noisy engine's log line is capped and carries no secret", async () => {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    const lines: string[] = [];
    const svc = createEngineService({
      engines: [engineThatCalls("mcp-fake", async (t) => void (await t?.call("noisy", {})))],
      detect: detectProject,
      hostFor: (_id, sandbox) => startMcpHost({ entry: server, allowedTools: ["noisy"] }, sandbox),
      log: (l) => lines.push(l),
    });
    await svc.run(dir, OPTS);
    expect(lines).toHaveLength(1);
    expect((lines[0] as string).length).toBeLessThanOrEqual(4100);
    expect(lines[0]).toContain("eeee");
    expect(lines[0]).not.toContain(SECRET);
    expect(liveChildCount()).toBe(0);
  });
  it("real engines: code intelligence feeds impact to the quality engine, all on the sandbox copy", async () => {
    const dir = project({
      "package.json": "{}",
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "import { a } from './a';",
    });
    const graph = {
      nodes: [{ file: "src/a.ts" }, { file: "src/b.ts" }],
      edges: [{ from: "src/b.ts", to: "src/a.ts" }],
    };
    const sb = trackedSandbox();
    const svc = createEngineService({
      engines: [createQualityEngine(), createCodeIntelligenceEngine(graph)],
      detect: detectProject,
      hostFor: async () => ({ host: null, close: () => undefined }),
      createSandbox: sb.create,
    });
    const r = await svc.run(dir, { changedFiles: ["src/a.ts"], userCode: { allowed: false } });
    expect(r.impact.affectedFiles).toEqual(["src/b.ts"]);
    expect(r.findings.some((f) => f.engine === "quality")).toBe(true);
    expect(r.completeness).toBe("partial");
    expect(existsSync(sb.roots[0] as string)).toBe(false);
    const names = r.notDone.map((n: NotDone) => `${n.what} ${n.reason}`).join("\n");
    expect(names).not.toMatch(/agentic|understand|aqe/i);
  });
  it("changedFiles scope the run even when no engine can compute an impact graph", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "a", "src/b.ts": "b" });
    const scopes: string[][] = [];
    const quality = createQualityEngine();
    const spy: AuditEngine = {
      ...quality,
      async execute(task, rt) {
        if (task.id.endsWith("coverage-gap")) scopes.push([...task.scope]);
        return quality.execute(task, rt);
      },
    };
    const svc = createEngineService({
      engines: [spy],
      detect: detectProject,
      hostFor: async () => ({ host: null, close: () => undefined }),
    });
    const r = await svc.run(dir, {
      changedFiles: ["src/a.ts", "../escape", "src/a.ts", "/abs"],
      userCode: { allowed: false },
    });
    expect(scopes).toEqual([["src/a.ts"]]);
    expect(r.impact.changedFiles).toEqual(["src/a.ts"]);
    expect(r.impact.affectedFiles).toEqual([]);
  });
  it.skipIf(process.platform === "win32")(
    "engines see the realpath of the sandbox even when the temp root is a symlink",
    async () => {
      const real = realpathSync.native(makeTmp("auditd-real-"));
      const link = join(realpathSync.native(makeTmp("auditd-link-")), "tmp-link");
      symlinkSync(real, link);
      for (const k of TMP_KEYS) process.env[k] = link;
      const dir = project({ "package.json": "{}", "src/a.ts": "a", "src/a.test.ts": "t" });
      const seen: string[] = [];
      const seenReal: string[] = [];
      const svc = createEngineService({
        engines: [
          engineThatCalls("probe", async (_t, rt) => {
            seen.push(rt.projectDir);
            seenReal.push(realpathSync.native(rt.projectDir));
          }),
          createQualityEngine(),
        ],
        detect: detectProject,
        // The fake server resolves symlinks in `target` before reporting rows, like a real server.
        hostFor: (_id, sandbox) => startMcpHost(qualityEngineHostConfig(server), sandbox),
      });
      const r = await svc.run(dir, OPTS);
      expect(seen).toHaveLength(1);
      const projectDir = seen[0] as string;
      expect(projectDir.startsWith(real)).toBe(true);
      expect(seenReal).toEqual([projectDir]);
      expect(
        r.findings.some((f) => f.engine === "quality" && f.ruleId === "quality.low-coverage"),
      ).toBe(true);
      expect(r.notDone.map((n) => n.reason).join("\n")).not.toContain("无法与项目对应");
    },
  );
});

describe("startMcpHost", () => {
  async function sandbox() {
    const dir = project({ "package.json": "{}", "a.ts": "a" });
    return realCreateSandbox(dir);
  }

  it("serves allowed calls, exposes a bounded redacted stderr tail after close, and leaves no child", async () => {
    const sb = await sandbox();
    try {
      const eh = await startMcpHost({ entry: server, allowedTools: ["echo", "noisy"] }, sb);
      expect(textOf(await eh.host?.call("echo", { hello: "world" }))).toBe('{"hello":"world"}');
      await eh.host?.call("noisy", {});
      await eh.close();
      const tail = eh.diagnostics?.() ?? "";
      expect(tail.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64 * 1024);
      expect(tail).toContain("eeee");
      expect(tail).not.toContain(SECRET);
      expect(liveChildCount()).toBe(0);
      await eh.close();
    } finally {
      await sb.cleanup();
    }
  });
  it("refuses a tool that is not on the allowlist", async () => {
    const sb = await sandbox();
    try {
      const eh = await startMcpHost({ entry: server, allowedTools: ["echo"] }, sb);
      await expect(eh.host?.call("noisy", {})).rejects.toThrow();
      await eh.close();
      expect(liveChildCount()).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
  it("AQE_COVERAGE_NO_EXEC=1 reaches every host's child, with and without a config env", async () => {
    const sb = await sandbox();
    try {
      const cfg = qualityEngineHostConfig(server);
      expect(cfg.allowedTools).toEqual(["coverage_analyze_sublinear"]);
      expect(cfg.env).toBeUndefined();
      const quality = await startMcpHost({ ...cfg, allowedTools: ["env_probe"] }, sb);
      expect(
        JSON.parse(textOf(await quality.host?.call("env_probe", {}))).AQE_COVERAGE_NO_EXEC,
      ).toBe("1");
      await quality.close();
      for (const env of [undefined, { SOME_OTHER_FLAG: "x" }]) {
        const host = await startMcpHost({ entry: server, allowedTools: ["env_probe"], env }, sb);
        expect(
          JSON.parse(textOf(await host.host?.call("env_probe", {}))).AQE_COVERAGE_NO_EXEC,
        ).toBe("1");
        await host.close();
      }
      expect(liveChildCount()).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
  it("extra env cannot override the sandbox's own variables, and loader hooks are refused before any spawn", async () => {
    const sb = await sandbox();
    try {
      for (const key of [
        "HOME",
        "PATH",
        "TMPDIR",
        "tmp",
        "AQE_PROJECT_ROOT",
        "AQE_LLM_ROUTER_DISABLED",
        "AQE_COVERAGE_NO_EXEC",
        "aqe_coverage_no_exec",
        "NODE_OPTIONS",
        "LANG",
        "A B",
        "1X",
      ]) {
        await expect(
          startMcpHost({ entry: server, allowedTools: ["echo"], env: { [key]: "/evil" } }, sb),
        ).rejects.toThrow(/not allowed/);
      }
      expect(() => childEnvFor({ env: { OK_KEY: "a\0b" } }, sb)).toThrow(/invalid value/);
      expect(liveChildCount()).toBe(0);
      const env = childEnvFor({ env: { OK_KEY: "v" } }, sb);
      expect(env.AQE_COVERAGE_NO_EXEC).toBe("1");
      expect(env.HOME).toBe(sb.home);
      expect(env.TMPDIR).toBe(sb.tmp);
    } finally {
      await sb.cleanup();
    }
  });
  it("an abort during the handshake rejects at once and leaves no child; an already-aborted signal never spawns", async () => {
    const sb = await sandbox();
    try {
      const cfg = { entry: server, allowedTools: ["echo"], env: { FAKE_MCP_NO_INIT: "1" } };
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      await expect(startMcpHost(cfg, sb, ac.signal)).rejects.toThrow(/cancelled/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(liveChildCount()).toBe(0);
      const done = AbortSignal.abort();
      await expect(startMcpHost(cfg, sb, done)).rejects.toThrow(/cancelled/);
      expect(liveChildCount()).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
  it("a failed handshake rejects, and no child is left", async () => {
    const sb = await sandbox();
    try {
      await expect(
        startMcpHost({ entry: join(sb.tmp, "missing.mjs"), allowedTools: ["echo"] }, sb),
      ).rejects.toThrow();
      expect(liveChildCount()).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
});

describe("EngineService progress events", () => {
  const collect = () => {
    const events: unknown[] = [];
    return { events, onEvent: (e: unknown) => events.push(e) };
  };

  it("goes reading → checking (with a real done/total) → concluding", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "a" });
    const { events, onEvent } = collect();
    const svc = createEngineService({
      engines: [createFakeEngine({ withRunTests: true })],
      hostFor: noHost,
      detect: detectProject,
    });
    await svc.run(dir, { ...OPTS, onEvent });
    expect(events).toEqual([
      { stage: "reading" },
      { stage: "checking" },
      { engine: "fake", done: 0, total: 2 },
      { engine: "fake", done: 1, total: 2 },
      { engine: "fake", done: 2, total: 2 },
      { stage: "concluding" },
    ]);
  });

  it("emits no engine progress for an engine that does not apply", async () => {
    const dir = project({ "package.json": "{}" });
    const { events, onEvent } = collect();
    const svc = createEngineService({
      engines: [createFakeEngine({ applicable: false })],
      hostFor: noHost,
      detect: detectProject,
    });
    await svc.run(dir, { ...OPTS, onEvent });
    expect(events.filter((e) => "engine" in (e as object))).toEqual([]);
  });

  it("is not changed by a throwing onEvent", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "a" });
    const svc = createEngineService({
      engines: [createFakeEngine()],
      hostFor: noHost,
      detect: detectProject,
    });
    const r = await svc.run(dir, {
      ...OPTS,
      onEvent: () => {
        throw new Error("sink broke");
      },
    });
    expect(r.completeness).toBe("complete");
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("still concludes when the run is aborted midway", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "a" });
    const { events, onEvent } = collect();
    const ac = new AbortController();
    const svc = createEngineService({
      engines: [engineThatCalls("fake", async () => ac.abort())],
      hostFor: noHost,
      detect: detectProject,
    });
    await svc.run(dir, { ...OPTS, signal: ac.signal, onEvent });
    expect(events.at(-1)).toEqual({ stage: "concluding" });
  });
});
