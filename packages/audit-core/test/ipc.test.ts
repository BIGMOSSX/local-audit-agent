import { describe, expect, it } from "vitest";
import { IpcRequestSchema, IpcResponseSchema } from "../src/index";

describe("ipc envelope", () => {
  it("accepts a request with string or numeric id and optional params", () => {
    expect(IpcRequestSchema.safeParse({ id: 1, token: "t", method: "project.list" }).success).toBe(
      true,
    );
    expect(
      IpcRequestSchema.safeParse({ id: "a", token: "t", method: "x", params: { a: 1 } }).success,
    ).toBe(true);
  });
  it("rejects a request without a token, with an empty token, or with extra keys", () => {
    expect(IpcRequestSchema.safeParse({ id: 1, method: "project.list" }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ id: 1, token: "", method: "project.list" }).success).toBe(
      false,
    );
    expect(IpcRequestSchema.safeParse({ id: 1, token: "t", method: "m", cwd: "/" }).success).toBe(
      false,
    );
  });
  it("parses success and failure responses", () => {
    expect(IpcResponseSchema.safeParse({ id: 1, ok: true, result: { a: 1 } }).success).toBe(true);
    expect(
      IpcResponseSchema.safeParse({
        id: null,
        ok: false,
        error: { code: "bad_request", message: "x" },
      }).success,
    ).toBe(true);
  });
  it("rejects an error response with an unknown code", () => {
    expect(
      IpcResponseSchema.safeParse({ id: 1, ok: false, error: { code: "weird", message: "x" } })
        .success,
    ).toBe(false);
  });
});
