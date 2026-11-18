import net from "node:net";

export interface Reply {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface TestClient {
  socket: net.Socket;
  closed: Promise<void>;
  send(value: unknown): void;
  next(timeoutMs?: number): Promise<Reply>;
  destroy(): void;
}

export function connect(endpoint: string): TestClient {
  const socket = net.createConnection(endpoint);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = "";
  socket.on("data", (data: string) => {
    buffer += data;
    for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  return {
    socket,
    closed,
    send: (value) => {
      socket.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    },
    next: (timeoutMs = 5000) =>
      new Promise<Reply>((resolve, reject) => {
        const ready = lines.shift();
        if (ready !== undefined) return resolve(JSON.parse(ready) as Reply);
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a reply")),
          timeoutMs,
        );
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(JSON.parse(line) as Reply);
        });
      }),
    destroy: () => socket.destroy(),
  };
}

/** One request on a fresh connection, like the Rust shell does. */
export async function callOnce(
  endpoint: string,
  token: string,
  method: string,
  params?: unknown,
  id: string | number = 1,
): Promise<Reply> {
  const client = connect(endpoint);
  try {
    client.send({ id, token, method, ...(params === undefined ? {} : { params }) });
    return await client.next();
  } finally {
    client.destroy();
  }
}
