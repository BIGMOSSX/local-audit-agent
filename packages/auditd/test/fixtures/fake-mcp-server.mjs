import { closeSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const pendingSampling = new Map();
const rl = createInterface({ input: process.stdin });
process.stdin.on("error", () => undefined);
process.stdout.on("error", () => undefined);

rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && m.id !== undefined && pendingSampling.has(m.id)) {
    const callId = pendingSampling.get(m.id);
    pendingSampling.delete(m.id);
    send({ id: callId, result: { content: [{ type: "text", text: JSON.stringify(m) }] } });
    return;
  }
  if (m.method === "initialize") {
    // FAKE_MCP_NO_INIT: accepts input but never answers the handshake.
    if (process.env.FAKE_MCP_NO_INIT === "1") return;
    send({
      id: m.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0" },
      },
    });
  } else if (m.method === "tools/list") {
    send({
      id: m.id,
      result: {
        tools: [
          "echo",
          "slow",
          "huge",
          "ask_sampling",
          "noisy",
          "forbidden",
          "env_probe",
          "coverage_analyze_sublinear",
        ].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      },
    });
  } else if (m.method === "tools/call") {
    const { name, arguments: args } = m.params;
    if (name === "echo")
      send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(args) }] } });
    else if (name === "env_probe") {
      const seen = {
        AQE_COVERAGE_NO_EXEC: process.env.AQE_COVERAGE_NO_EXEC ?? null,
        HOME: process.env.HOME ?? null,
        PATH: process.env.PATH ?? null,
      };
      send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(seen) }] } });
    } else if (name === "coverage_analyze_sublinear") {
      // Like a real server: resolves symlinks in the target before reporting paths.
      const real = realpathSync(args.target);
      const text = JSON.stringify({
        success: true,
        data: {
          coverageByFile: [{ file: `${real}/src/a.ts`, lineCoverage: 10 }],
          measured: true,
          estimated: false,
        },
      });
      send({ id: m.id, result: { content: [{ type: "text", text }] } });
    } else if (name === "noisy") {
      // Writes far more than a 64 KiB pipe buffer to stderr BEFORE replying: blocks forever unless the client drains stderr.
      const line = `${"e".repeat(1023)}\n`;
      for (let i = 0; i < 300; i++) process.stderr.write(line);
      process.stderr.write("last line api_key=abcd1234efgh\n");
      send({ id: m.id, result: { content: [{ type: "text", text: "done" }] } });
    } else if (name === "huge")
      send({
        id: m.id,
        result: { content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] },
      });
    else if (name === "ask_sampling") {
      pendingSampling.set("s1", m.id);
      send({ id: "s1", method: "sampling/createMessage", params: { messages: [] } });
    } else if (name === "forbidden") {
      process.stderr.write("forbidden tool was invoked\n");
      send({ id: m.id, result: { content: [] } });
    } else if (name === "fail") {
      send({ id: m.id, error: { code: -32000, message: args?.message ?? "boom" } });
    } else if (name === "garbage") {
      // Hostile / sloppy output the client must shrug off before the one real reply.
      const raw = (s) => process.stdout.write(`${s}\n`);
      raw("this is not json");
      raw("null");
      raw("[]");
      raw("123");
      raw('"str"');
      raw('{"jsonrpc":"2.0","id":987654,"result":{"stale":true}}');
      raw('{"jsonrpc":"2.0","id":"__proto__","result":{"polluted":true}}');
      raw('{"jsonrpc":"2.0","method":"notifications/progress","params":{}}');
      raw('{"jsonrpc":"2.0","id":{"a":1},"method":"roots/list"}');
      send({ id: m.id, result: { content: [{ type: "text", text: "first" }] } });
      send({ id: m.id, result: { content: [{ type: "text", text: "duplicate" }] } });
    } else if (name === "nonewline") {
      // One enormous line with no terminator, never answered: the buffer must be capped before a newline shows up.
      process.stdout.write("y".repeat(4 * 1024 * 1024));
    } else if (name === "idlen") {
      // A server request whose id is args.len chars long; the echoed refusal comes back as the tool result.
      const id = "i".repeat(args.len);
      pendingSampling.set(args.len <= 128 ? id : null, m.id);
      send({ id, method: "roots/list" });
    } else if (name === "flood_requests") {
      // Stop reading stdin, then spray server requests (huge ids, or many small ones).
      process.stdin.pause();
      setInterval(() => undefined, 1000);
      const bigId = "z".repeat(args.idChars);
      for (let i = 0; i < args.count; i++)
        send({
          id: args.idChars > 0 ? `${bigId}${i}` : i + 1000,
          method: "sampling/createMessage",
        });
    } else if (name === "stall") {
      // Answer, then stop reading stdin for good (the client's later writes pile up unread).
      send({ id: m.id, result: { content: [{ type: "text", text: "stalled" }] } });
      process.stdin.pause();
      setInterval(() => undefined, 1000);
    } else if (name === "closeout") {
      // Close stdout but keep running.
      closeSync(1);
      setInterval(() => undefined, 1000);
    } else if (name === "die") {
      process.exit(0);
    } else if (name === "straddle") {
      // pre + secret + post on stderr, no newline: lets a test place a secret across the 64 KiB tail boundary.
      process.stderr.write(`${"p".repeat(args.pre)}${args.secret}${"q".repeat(args.post)}`);
      send({ id: m.id, result: { content: [{ type: "text", text: "done" }] } });
    } else if (name === "multibyte") {
      process.stderr.write(`a${"é".repeat(args.count)}`);
      send({ id: m.id, result: { content: [{ type: "text", text: "done" }] } });
    }
    // "slow": never answers
  }
});
