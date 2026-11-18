import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { CANDIDATE_PORTS, probeLoopbackModels } from "../src/model-probe";
import { cleanupTmp, makeTmp, minimalChildEnv } from "./helpers";

type Handler = (url: string, res: import("node:http").ServerResponse) => void;
const servers: Server[] = [];

async function listen(handler: Handler): Promise<number> {
  const server = createServer((req, res) => handler(req.url ?? "", res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const json =
  (body: unknown, status = 200): Handler =>
  (_url, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
const models = (...ids: unknown[]) => json({ data: ids.map((id) => ({ id })) });

afterEach(async () => {
  cleanupTmp();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe("probeLoopbackModels", () => {
  it("finds a service and lists its models", async () => {
    const port = await listen(models("a", "b"));
    expect(await probeLoopbackModels({ ports: [port] })).toEqual([{ port, models: ["a", "b"] }]);
  });

  it("asks /v1/models only", async () => {
    const seen: string[] = [];
    const port = await listen((url, res) => {
      seen.push(url);
      models("a")(url, res);
    });
    await probeLoopbackModels({ ports: [port] });
    expect(seen).toEqual(["/v1/models"]);
  });

  it("returns services sorted by port, and ignores a closed port", async () => {
    const a = await listen(models("a"));
    const b = await listen(models("b"));
    const [low, high] = a < b ? [a, b] : [b, a];
    const closed = await listen(models("x"));
    await new Promise<void>((resolve) => servers.at(-1)?.close(() => resolve()));
    const found = await probeLoopbackModels({ ports: [high, closed, low] });
    expect(found.map((s) => s.port)).toEqual([low, high]);
  });

  it.each([
    ["html", json("<html>hi</html>")],
    ["404", json({ error: "no" }, 404)],
    ["invalid json", json("{not json")],
    ["data not an array", json({ data: "x" })],
    ["no data key", json({})],
    ["empty list", json({ data: [] })],
    ["array at top level", json([{ id: "a" }])],
  ])("skips a listener that answers with %s", async (_name, handler) => {
    const port = await listen(handler);
    expect(await probeLoopbackModels({ ports: [port] })).toEqual([]);
  });

  it("skips a body over the size cap", async () => {
    const port = await listen(json({ data: [{ id: "a" }], pad: "x".repeat(2_000_000) }));
    expect(await probeLoopbackModels({ ports: [port] })).toEqual([]);
  });

  it("gives up on a listener that never answers", async () => {
    const port = await listen(() => {});
    const started = Date.now();
    expect(await probeLoopbackModels({ ports: [port], timeoutMs: 150 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up on a listener that sends headers and then stalls", async () => {
    const port = await listen((_url, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":[');
    });
    const started = Date.now();
    expect(await probeLoopbackModels({ ports: [port], timeoutMs: 150 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not follow a redirect", async () => {
    const target = await listen(models("secret"));
    const port = await listen((_url, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target}/v1/models` });
      res.end();
    });
    expect(await probeLoopbackModels({ ports: [port] })).toEqual([]);
  });

  it("drops bad ids and duplicates, and caps the count", async () => {
    const ids = [
      "",
      "x".repeat(201),
      "bad\u0000id",
      "bad\nid",
      "rtl\u202eid",
      "zero\u200bwidth",
      42,
      null,
      "m0",
      "m0",
      ...Array.from({ length: 300 }, (_, i) => `m${i + 1}`),
    ];
    const port = await listen(models(...ids));
    const [service] = await probeLoopbackModels({ ports: [port] });
    expect(service?.models).toHaveLength(200);
    expect(service?.models.slice(0, 3)).toEqual(["m0", "m1", "m2"]);
    expect(service?.models.every((m) => /^m\d+$/.test(m))).toBe(true);
    expect(new Set(service?.models).size).toBe(200);
  });

  it("a service whose every id is invalid is not listed", async () => {
    const port = await listen(models("", 7, "a\u0007"));
    expect(await probeLoopbackModels({ ports: [port] })).toEqual([]);
  });

  it("the built-in candidate list is non-empty, unique and valid ports", () => {
    expect(CANDIDATE_PORTS.length).toBeGreaterThan(0);
    expect(new Set(CANDIDATE_PORTS).size).toBe(CANDIDATE_PORTS.length);
    for (const port of CANDIDATE_PORTS)
      expect(Number.isInteger(port) && port > 0 && port < 65536).toBe(true);
  });

  it("sends no body and no credentials", async () => {
    const seen: Record<string, unknown>[] = [];
    const port = await listen((url, res) => {
      models("a")(url, res);
    });
    servers.at(-1)?.on("request", (req) => seen.push({ method: req.method, headers: req.headers }));
    await probeLoopbackModels({ ports: [port] });
    expect(seen[0]?.method).toBe("GET");
    const headers = Object.keys(seen[0]?.headers as object);
    expect(headers).not.toContain("authorization");
    expect(headers).not.toContain("cookie");
  });

  it("an environment proxy setting does not pull the probe off loopback", async () => {
    const proxied: string[] = [];
    const proxy = await listen((url, res) => {
      proxied.push(url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake" }] }));
    });
    const target = await listen(models("real"));
    const bundle = join(makeTmp("probe-"), "probe.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/model-probe.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
    });
    const script = `import { probeLoopbackModels } from ${JSON.stringify(pathToFileURL(bundle).href)};
      console.log(JSON.stringify(await probeLoopbackModels({ ports: [${target}] })));`;
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: {
            ...minimalChildEnv(),
            NODE_USE_ENV_PROXY: "1",
            HTTP_PROXY: `http://127.0.0.1:${proxy}`,
            http_proxy: `http://127.0.0.1:${proxy}`,
          },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    expect(JSON.parse(out)).toEqual([{ port: target, models: ["real"] }]);
    expect(proxied).toEqual([]);
  });
});
