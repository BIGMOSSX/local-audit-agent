// Drives the real built daemon (packages/auditd/dist/main.js) the way the desktop shell does,
// and checks the machine-checkable parts of spec §111. The window itself is not covered.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[4] ? resolve(process.argv[4]) : resolve(here, "../..");
const mainJs = join(root, "packages/auditd/dist/main.js");
const samples = process.argv[2] ? resolve(process.argv[2]) : join(root, "sample-projects");
const reportFile = process.argv[3];

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const line = `${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (reportFile) appendFileSync(reportFile, `${line}\n`);
}
const check = (name, ok, detail = "") => record(name, ok ? "通过" : "失败", ok ? "" : detail);
const skip = (name, why) => record(name, "跳过", why);

function startDaemon(dataDir) {
  const child = spawn(process.execPath, [mainJs, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    err += d;
  });
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  child.stdout.setEncoding("utf8");
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`15 秒内没有握手；stderr: ${err.slice(-300)}`));
    }, 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const i = out.indexOf("\n");
      if (i === -1) return;
      clearTimeout(timer);
      try {
        res({
          child,
          exited,
          handshakeLines: out.trimEnd().split("\n"),
          ...JSON.parse(out.slice(0, i)),
        });
      } catch {
        rej(new Error("握手行不是合法 JSON"));
      }
    });
    exited.then(({ code }) => {
      clearTimeout(timer);
      rej(new Error(`后台进程提前退出(${code})；stderr: ${err.slice(-300)}`));
    });
  });
}

function call(endpoint, token, method, params) {
  return new Promise((res, rej) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rej(new Error("5 秒没有回复"));
    }, 5000);
    socket.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    socket.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i === -1) return;
      clearTimeout(timer);
      socket.destroy();
      res(JSON.parse(buf.slice(0, i)));
    });
    socket.write(`${JSON.stringify({ id: 1, token, method, ...(params ? { params } : {}) })}\n`);
  });
}

const stop = async (d) => {
  d.child.stdin.end();
  await Promise.race([d.exited, new Promise((r) => setTimeout(r, 5000))]);
};

function processEnvText(pid) {
  if (process.platform === "linux") {
    return (
      readFileSync(`/proc/${pid}/cmdline`, "utf8") + readFileSync(`/proc/${pid}/environ`, "utf8")
    );
  }
  return execFileSync("ps", ["-wwE", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  console.log(`系统 ${process.platform}/${process.arch}  Node ${process.version}`);
  if (!existsSync(mainJs)) throw new Error(`没有找到 ${mainJs}，请先 pnpm build`);
  if (!existsSync(samples)) throw new Error(`没有找到样例文件夹 ${samples}`);

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "audit-desktop-check-")));
  const dataDir = join(tmp, "数据 目录");
  const daemons = [];
  const noAccess = join(tmp, "no-access");
  try {
    let d = await startDaemon(dataDir);
    daemons.push(d);

    check(
      "握手：只输出一行，含 ready、endpoint、64 位令牌",
      d.handshakeLines.length === 1 && d.ready === true && /^[0-9a-f]{64}$/.test(d.token),
      JSON.stringify({ lines: d.handshakeLines.length, ready: d.ready }),
    );

    const bad = await call(d.endpoint, "f".repeat(64), "project.list");
    check(
      "IPC 鉴权：错误令牌被拒绝",
      bad.ok === false && bad.error?.code === "unauthorized",
      JSON.stringify(bad),
    );
    const none = await call(d.endpoint, "", "project.list");
    check("IPC 鉴权：空令牌被拒绝", none.ok === false, JSON.stringify(none));

    const expect = {
      "demo-node-app": "node",
      "测试 项目 (副本)": "python",
      "mixed-node-python": "node · python",
      "not-a-project": "",
    };
    for (const [name, eco] of Object.entries(expect)) {
      const r = await call(d.endpoint, d.token, "project.open", { path: join(samples, name) });
      const got = r.ok ? r.result.ecosystems.join(" · ") : `错误 ${r.error?.code}`;
      check(
        `打开样例 ${name}：识别为 ${eco || "—"}`,
        r.ok && got === eco && r.result.name === name,
        `得到 ${got}`,
      );
    }
    const again = await call(d.endpoint, d.token, "project.open", {
      path: join(samples, "demo-node-app"),
    });
    const list1 = await call(d.endpoint, d.token, "project.list");
    check(
      "重复打开同一文件夹不产生重复项",
      again.ok && list1.ok && list1.result.projects.length === 4,
      `列表 ${list1.result?.projects?.length ?? "?"} 项`,
    );

    for (const [label, p] of [
      ["不存在的路径", join(tmp, "不存在")],
      ["相对路径", "relative/path"],
      ["文件而不是文件夹", join(samples, "demo-node-app", "package.json")],
    ]) {
      const r = await call(d.endpoint, d.token, "project.open", { path: p });
      check(
        `拒绝${label}（invalid_path）`,
        r.ok === false && r.error?.code === "invalid_path",
        JSON.stringify(r),
      );
    }

    if (process.getuid?.() === 0) {
      skip("拒绝无读权限的文件夹", "当前是 root，权限位不生效");
    } else {
      mkdirSync(noAccess);
      chmodSync(noAccess, 0o000);
      const r = await call(d.endpoint, d.token, "project.open", { path: noAccess });
      check(
        "拒绝无读权限的文件夹（invalid_path）",
        r.ok === false && r.error?.code === "invalid_path",
        JSON.stringify(r),
      );
      const listAfter = await call(d.endpoint, d.token, "project.list");
      check("被拒绝后列表不变", listAfter.ok && listAfter.result.projects.length === 4);
    }

    try {
      const text = processEnvText(d.child.pid);
      check(
        "令牌不在后台进程的参数和环境里",
        !text.includes(d.token),
        "在进程参数或环境里发现了令牌",
      );
    } catch (e) {
      skip("令牌不在后台进程的参数和环境里", `无法读取进程信息：${e.message}`);
    }

    const mode = (p) => (statSync(p).mode & 0o777).toString(8);
    if (process.platform !== "win32") {
      check("数据目录权限 700", mode(dataDir) === "700", `实际 ${mode(dataDir)}`);
      check(
        "数据库权限 600",
        mode(join(dataDir, "audit.db")) === "600",
        `实际 ${mode(join(dataDir, "audit.db"))}`,
      );
    }

    // Restart: clean stop, then a new daemon on the same data directory.
    await stop(d);
    check("正常退出后进程消失", !alive(d.child.pid));
    d = await startDaemon(dataDir);
    daemons.push(d);
    const list2 = await call(d.endpoint, d.token, "project.list");
    const names = list2.ok ? list2.result.projects.map((p) => p.name).sort() : [];
    check("重启后项目仍在（持久化）", list2.ok && names.length === 4, `得到 ${names.join("、")}`);

    // Crash: SIGKILL, then a new daemon on the same data directory.
    const killedPid = d.child.pid;
    d.child.kill("SIGKILL");
    await d.exited;
    check("强杀后进程消失", !alive(killedPid));
    d = await startDaemon(dataDir);
    daemons.push(d);
    const list3 = await call(d.endpoint, d.token, "project.list");
    check(
      "强杀后重新启动，数据仍在",
      list3.ok && list3.result.projects.length === 4,
      JSON.stringify(list3).slice(0, 200),
    );
    const reopen = await call(d.endpoint, d.token, "project.open", {
      path: join(samples, "mixed-node-python"),
    });
    check("强杀后重新启动，仍能正常打开项目", reopen.ok, JSON.stringify(reopen).slice(0, 200));

    await stop(d);
    const leaked = filesUnder(dataDir).filter((f) =>
      daemons.some((x) => readFileSync(f).includes(x.token)),
    );
    check("令牌没有写进数据库或日志", leaked.length === 0, leaked.join(", "));
  } finally {
    for (const x of daemons) if (alive(x.child.pid)) x.child.kill("SIGKILL");
    try {
      chmodSync(noAccess, 0o755);
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.status === "失败").length;
  const summary = `\n合计 ${results.length} 项：通过 ${results.filter((r) => r.status === "通过").length}，失败 ${failed}，跳过 ${results.filter((r) => r.status === "跳过").length}`;
  console.log(summary);
  if (reportFile) appendFileSync(reportFile, `${summary}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`脚本自身出错：${e.message}`);
  if (reportFile) appendFileSync(reportFile, `脚本自身出错：${e.message}\n`);
  process.exitCode = 2;
});
