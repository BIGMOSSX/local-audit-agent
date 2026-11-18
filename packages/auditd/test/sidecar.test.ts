import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmp, makeTmp } from "./helpers";
import { callOnce } from "./ipc-client";
import { type Sidecar, spawnDaemon, startSidecar } from "./sidecar";

const started: Sidecar[] = [];
const isWindows = process.platform === "win32";

async function daemon(dataDir: string): Promise<Sidecar> {
  const sidecar = await startSidecar(dataDir);
  started.push(sidecar);
  return sidecar;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop().catch(() => null)));
  cleanupTmp();
});

function project(name: string, files: Record<string, string> = { "package.json": "{}" }): string {
  const dir = join(realpathSync.native(makeTmp()), name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("auditd process", () => {
  it("prints exactly one handshake line: ready, endpoint, 256-bit token", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    await new Promise((r) => setTimeout(r, 300));
    const lines = d.stdout().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ready: true,
      endpoint: d.endpoint,
      token: d.token,
    });
    expect(d.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("opens a project in a Unicode/space path and lists it, end to end over the socket", async () => {
    const d = await daemon(join(makeTmp(), "数据 目录"));
    const dir = project("AI软件安全审计项目开发 (副本)");
    const opened = await callOnce(d.endpoint, d.token, "project.open", { path: dir });
    expect(opened).toMatchObject({
      ok: true,
      result: { path: dir, name: "AI软件安全审计项目开发 (副本)", ecosystems: ["node"] },
    });
    const listed = await callOnce(d.endpoint, d.token, "project.list");
    expect((listed.result as { projects: unknown[] }).projects).toHaveLength(1);
    const id = (opened.result as { id: string }).id;
    expect((await callOnce(d.endpoint, d.token, "project.status", { id })).result).toMatchObject({
      pathExists: true,
    });
  });

  it("runs an audit in the background and ends honestly partial when no engine is installed", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    const dir = project("proj", { "package.json": "{}", "a.ts": "export const a = 1;" });
    const opened = await callOnce(d.endpoint, d.token, "project.open", { path: dir });
    const projectId = (opened.result as { id: string }).id;
    const started = await callOnce(d.endpoint, d.token, "audit.run", { projectId });
    expect(started).toMatchObject({ ok: true, result: { status: "running", projectId } });
    const runId = (started.result as { id: string }).id;
    type HistoryRun = {
      status: string;
      completeness: string | null;
      notDone: { what: string; reason: string }[];
      summary: { gate: string; checked: number } | null;
      stale: boolean | null;
      fingerprint: string | null;
    };
    const latest = async (): Promise<HistoryRun | undefined> => {
      const history = await callOnce(d.endpoint, d.token, "audit.history", { projectId });
      return (history.result as { runs: HistoryRun[] }).runs[0];
    };
    let run: HistoryRun | undefined;
    for (let i = 0; i < 100; i++) {
      run = await latest();
      if (run && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run).toMatchObject({ status: "completed", completeness: "partial" });
    expect(run?.notDone.length).toBeGreaterThan(0);
    // No model is connected in the real daemon: the run must say what that left undone, and never be ready.
    expect(run?.notDone).toContainEqual({
      what: "读懂项目、生成测试、安全深度分析",
      reason: "需要连接 AI 模型",
    });
    // Nothing could run (no engine installed): the daemon says "nothing was checked", never a colour.
    expect(run?.summary).toMatchObject({ gate: "none", checked: 0 });
    expect(run?.stale).toBe(false);
    expect(run?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect((await callOnce(d.endpoint, d.token, "finding.list", { runId })).result).toEqual({
      findings: [],
      total: 0,
      offset: 0,
    });
    // userCode can never be switched on by the caller
    const smuggled = await callOnce(d.endpoint, d.token, "audit.run", {
      projectId,
      userCode: { allowed: true },
    });
    expect(smuggled.error?.code).toBe("invalid_params");
  });

  it("reports a project edited after its run as changed since", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    const dir = project("edited", { "package.json": "{}", "a.ts": "export const a = 1;" });
    const opened = await callOnce(d.endpoint, d.token, "project.open", { path: dir });
    const projectId = (opened.result as { id: string }).id;
    const started = await callOnce(d.endpoint, d.token, "audit.run", { projectId });
    const runId = (started.result as { id: string }).id;
    // audit.cancel waits for the run to settle and hands back the stored run; unlike audit.history it
    // does not fingerprint the project, so no fingerprint is remembered for the edit below to hit.
    const settled = await callOnce(d.endpoint, d.token, "audit.cancel", { runId });
    expect(["completed", "cancelled"]).toContain((settled.result as { status: string }).status);
    const before = (settled.result as { fingerprint: string | null }).fingerprint;
    expect(before).toMatch(/^[0-9a-f]{8}$/);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 22222;\n");
    const history = await callOnce(d.endpoint, d.token, "audit.history", { projectId });
    const latest = (
      history.result as { runs: { stale: boolean | null; fingerprint: string | null }[] }
    ).runs[0];
    expect(latest?.stale).toBe(true);
    // The fingerprint belongs to the run (what was checked), not to the project as it is now.
    expect(latest?.fingerprint).toBe(before);
  });

  it("marks a run left running by a killed daemon as failed at the next start", async () => {
    const dataDir = join(makeTmp(), "data");
    const first = await daemon(dataDir);
    const dir = project("proj", { "package.json": "{}" });
    const opened = await callOnce(first.endpoint, first.token, "project.open", { path: dir });
    const projectId = (opened.result as { id: string }).id;
    await first.stop();
    // Forge the state a SIGKILL mid-run leaves behind.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dataDir, "audit.db"));
    raw.exec(
      `INSERT INTO audit_runs (id, project_id, status, started_at, not_done, engines, finding_count)
       VALUES ('stuck', '${projectId}', 'running', 1, '[]', '[]', 0)`,
    );
    raw.close();
    const second = await daemon(dataDir);
    const history = await callOnce(second.endpoint, second.token, "audit.history", { projectId });
    expect((history.result as { runs: unknown[] }).runs).toMatchObject([
      { id: "stuck", status: "failed", completeness: "partial" },
    ]);
  });

  it("rejects a wrong token and a non-allowlisted method", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    expect((await callOnce(d.endpoint, "0".repeat(64), "project.list")).error?.code).toBe(
      "unauthorized",
    );
    expect((await callOnce(d.endpoint, d.token, "shell.exec", { cmd: "id" })).error?.code).toBe(
      "method_not_allowed",
    );
  });

  it("distinguishes an allowlisted-but-unimplemented method from a non-allowlisted one", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    expect((await callOnce(d.endpoint, d.token, "audit.plan", {})).error?.code).toBe(
      "method_not_implemented",
    );
    expect((await callOnce(d.endpoint, d.token, "shell.exec", { cmd: "id" })).error?.code).toBe(
      "method_not_allowed",
    );
  });

  it("reports bad input as readable errors: relative, missing, wrong params, unknown id", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    const relative = await callOnce(d.endpoint, d.token, "project.open", { path: "relative/dir" });
    expect(relative.error?.code).toBe("invalid_path");
    const missing = await callOnce(d.endpoint, d.token, "project.open", {
      path: join(makeTmp(), "nope"),
    });
    expect(missing.error?.code).toBe("invalid_path");
    expect((await callOnce(d.endpoint, d.token, "project.open", {})).error?.code).toBe(
      "invalid_params",
    );
    expect((await callOnce(d.endpoint, d.token, "project.status", { id: "zzz" })).error?.code).toBe(
      "not_found",
    );
  });

  it("a remembered project whose folder was deleted shows up as pathExists:false, and the list still works", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    const dir = project("temp-project");
    const id = (
      (await callOnce(d.endpoint, d.token, "project.open", { path: dir })).result as { id: string }
    ).id;
    rmSync(dir, { recursive: true });
    expect((await callOnce(d.endpoint, d.token, "project.status", { id })).result).toMatchObject({
      id,
      pathExists: false,
    });
    expect(
      ((await callOnce(d.endpoint, d.token, "project.list")).result as { projects: unknown[] })
        .projects,
    ).toHaveLength(1);
  });

  it.skipIf(isWindows)(
    "one project row when reached through a symlink and through its real path",
    async () => {
      const d = await daemon(join(makeTmp(), "data"));
      const real = project("real-project");
      const link = join(realpathSync(makeTmp()), "alias");
      symlinkSync(real, link);
      const a = await callOnce(d.endpoint, d.token, "project.open", { path: link });
      const b = await callOnce(d.endpoint, d.token, "project.open", { path: real });
      expect((a.result as { id: string }).id).toBe((b.result as { id: string }).id);
      expect(
        ((await callOnce(d.endpoint, d.token, "project.list")).result as { projects: unknown[] })
          .projects,
      ).toHaveLength(1);
    },
  );

  it("survives kill -9: a new daemon on the same data dir has the data, a fresh token and a fresh endpoint", async () => {
    const dataDir = join(makeTmp(), "data");
    const first = await daemon(dataDir);
    const dir = project("persisted");
    await callOnce(first.endpoint, first.token, "project.open", { path: dir });
    await first.kill();

    const second = await daemon(dataDir);
    expect(second.token).not.toBe(first.token);
    expect(second.endpoint).not.toBe(first.endpoint);
    const listed = await callOnce(second.endpoint, second.token, "project.list");
    expect(
      (listed.result as { projects: Array<{ path: string }> }).projects.map((p) => p.path),
    ).toEqual([dir]);
  });

  it("exits with code 0 when its stdin closes, and removes its socket directory", async () => {
    const d = await daemon(join(makeTmp(), "data"));
    expect(await d.stop()).toBe(0);
    if (!isWindows) expect(existsSync(dirname(d.endpoint))).toBe(false);
  });

  it("never writes the session token to its log", async () => {
    const dataDir = join(makeTmp(), "data");
    const d = await daemon(dataDir);
    await callOnce(d.endpoint, d.token, "project.list");
    await callOnce(d.endpoint, "f".repeat(64), "project.list");
    await d.stop();
    const log = readFileSync(join(dataDir, "logs", "auditd.log"), "utf8");
    expect(log).toContain("ipc listening");
    expect(log).not.toContain(d.token);
    expect(d.stderr()).not.toContain(d.token);
    for (const file of filesUnder(dataDir)) {
      expect(readFileSync(file).includes(d.token), `token found in ${file}`).toBe(false);
    }
  });

  it.skipIf(process.platform !== "linux")(
    "never puts the session token in the process argv or environment",
    async () => {
      const d = await daemon(join(makeTmp(), "data"));
      const pid = d.child.pid;
      expect(pid).toBeTypeOf("number");
      expect(readFileSync(`/proc/${pid}/cmdline`, "utf8")).not.toContain(d.token);
      expect(readFileSync(`/proc/${pid}/environ`, "utf8")).not.toContain(d.token);
    },
  );

  it("two daemons on one data directory can write concurrently without SQLITE_BUSY", async () => {
    const dataDir = join(makeTmp(), "data");
    const [a, b] = await Promise.all([daemon(dataDir), daemon(dataDir)]);
    const dirs = Array.from({ length: 30 }, (_, i) => project(`p${i}`));
    const replies = await Promise.all(
      dirs.map((path, i) => {
        const target = i % 2 === 0 ? a : b;
        return callOnce(target.endpoint, target.token, "project.open", { path });
      }),
    );
    expect(replies.filter((r) => !r.ok)).toEqual([]);
    const listed = await callOnce(a.endpoint, a.token, "project.list");
    expect((listed.result as { projects: unknown[] }).projects).toHaveLength(30);
  });

  it("refuses to start without --data-dir, or with a relative one", async () => {
    for (const args of [[], ["--data-dir"], ["--data-dir", "relative/dir"]]) {
      const child = spawnDaemon(args);
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
      });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect(code).toBe(1);
      expect(err).toContain("--data-dir");
    }
  });
});
