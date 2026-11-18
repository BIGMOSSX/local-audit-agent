import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "../src/index";

describe("redactSecrets", () => {
  it("removes an explicitly registered secret everywhere", () => {
    const token = "a".repeat(64);
    const out = redactSecrets(`conn ${token} and again ${token}`, [token]);
    expect(out).not.toContain(token);
    expect(out.split(REDACTED)).toHaveLength(3);
  });

  it("ignores registered secrets shorter than 8 chars (would shred normal text)", () => {
    expect(redactSecrets("banana bandana", ["ana"])).toBe("banana bandana");
  });

  it("redacts common key formats", () => {
    const out = redactSecrets(
      "k=sk-abcdefghijklmnop1234 g=ghp_abcdefghijklmnopqrstu a=AKIAABCDEFGHIJKLMNOP",
    );
    expect(out).not.toMatch(/sk-abc|ghp_abc|AKIAABC/);
  });

  it("redacts an sk- key right after an underscore or other non-alphanumeric character", () => {
    const key = "sk-AbCdEfGhIjKlMnOp1234";
    for (const prefix of ["my_", "token_", "(", "=", '"', "/", "-", ":"]) {
      const out = redactSecrets(`value ${prefix}${key} end`);
      expect(out, prefix).not.toContain("AbCdEfGh");
      expect(out, prefix).toContain(REDACTED);
    }
  });
  it("leaves ordinary words that merely contain sk- alone", () => {
    for (const text of ["task-1234567890123456", "risk-assessment-for-the-whole-platform"]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
  it("does not hang on a long run of sk- lookalikes", () => {
    const started = Date.now();
    redactSecrets("_sk-".repeat(50000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("redacts bearer credentials", () => {
    expect(redactSecrets("Authorization: Bearer abcdefgh12345678")).not.toContain(
      "abcdefgh12345678",
    );
  });

  it("keeps the key name but hides the value in key=value pairs", () => {
    expect(redactSecrets("password=hunter2hunter2 token: 'abc def'")).toBe(
      `password=${REDACTED} token: ${REDACTED}`,
    );
  });

  it("does not touch look-alike words", () => {
    expect(redactSecrets("tokenizer=fast passwords are hard")).toBe(
      "tokenizer=fast passwords are hard",
    );
  });

  it("redacts JSON-encoded pairs, keeping the JSON shape", () => {
    const out = redactSecrets(
      JSON.stringify({ password: "hunter2", api_key: "sk-not-a-real-key", n: 1 }),
    );
    expect(out).toBe(`{"password":"${REDACTED}","api_key":"${REDACTED}","n":1}`);
    expect(redactSecrets('{"token" : "abc def", "ok": "yes"}')).toBe(
      `{"token" : "${REDACTED}", "ok": "yes"}`,
    );
    expect(JSON.parse(redactSecrets(JSON.stringify({ secret: 'a"b\\c' })))).toEqual({
      secret: REDACTED,
    });
  });

  it("redacts JSON that was itself embedded in a JSON string", () => {
    const line = JSON.stringify({ msg: JSON.stringify({ password: "hunter2hunter2" }) });
    const out = redactSecrets(line);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("password");
  });

  it("redacts compound keys that end in a secret word", () => {
    expect(redactSecrets("access_token=abc123xyz refresh-token: 'q w e' db_password=p")).toBe(
      `access_token=${REDACTED} refresh-token: ${REDACTED} db_password=${REDACTED}`,
    );
    expect(redactSecrets('{"access_token":"abc123xyz","client_secret":"s"}')).toBe(
      `{"access_token":"${REDACTED}","client_secret":"${REDACTED}"}`,
    );
    expect(redactSecrets("accessToken=abc123 X-Api-Key: k1")).toBe(
      `accessToken=${REDACTED} X-Api-Key: ${REDACTED}`,
    );
  });

  it("does not mangle ordinary prose or look-alike JSON keys", () => {
    for (const s of [
      "tokens: 5",
      "the token budget is high",
      "secrets are stored elsewhere",
      '{"tokens":5,"tokenizer":"fast","passwords":"none"}',
      "token counts: 5, password policy: strict",
    ]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });

  it("is a no-op on clean text, including Chinese paths", () => {
    const s = "/home/robin/Work/AI软件安全审计项目开发 opened";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("redactSecrets: JSON nested inside a JSON string", () => {
  const secret = 'SECRET-PART1"SECRET-PART2';
  it("redacts a value containing an escaped quote (3 backslashes + quote in the outer text)", () => {
    const text = String.raw`{"payload":"{\"api_key\":\"SECRET-PART1\\\"SECRET-PART2\",\"keep\":\"ok\"}"}`;
    const out = redactSecrets(text);
    expect(out).not.toContain("PART1");
    expect(out).not.toContain("PART2");
    expect(out).toContain(String.raw`\"keep\":\"ok\"`);
  });
  it("redacts a value containing an escaped backslash", () => {
    const text = String.raw`{"p":"{\"token\":\"AAAA\\\\BBBB\",\"x\":1}"}`;
    const out = redactSecrets(text);
    expect(out).not.toContain("AAAA");
    expect(out).not.toContain("BBBB");
  });
  it("redacts a value containing an escaped newline", () => {
    const text = String.raw`{"p":"{\"password\":\"line1\\nline2\"}"}`;
    expect(redactSecrets(text)).not.toContain("line2");
  });
  it("does not leak the tail of a value with an escaped quote", () => {
    const text = String.raw`{"msg":"{\"password\":\"hun\\\"ter2\"}"}`;
    const out = redactSecrets(text);
    expect(out).not.toContain("hun");
    expect(out).not.toContain("ter2");
  });
  it("still leaves the plain nested case and unrelated text alone", () => {
    const text = String.raw`{"p":"{\"api_key\":\"abcd1234efgh\",\"name\":\"n\"}"}`;
    const out = redactSecrets(text);
    expect(out).not.toContain("abcd1234efgh");
    expect(out).toContain(String.raw`\"name\":\"n\"`);
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
  it("does not hang on a long unterminated nested value", () => {
    const text = String.raw`{"p":"{\"token\":\"` + "\\\\".repeat(20000);
    const started = Date.now();
    redactSecrets(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("(sanity) the secret literal in this suite really contains a quote", () => {
    expect(secret).toContain('"');
  });
});
