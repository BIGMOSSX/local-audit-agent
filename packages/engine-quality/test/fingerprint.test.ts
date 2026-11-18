import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint";

describe("fingerprint", () => {
  it("is 32 lowercase hex chars and deterministic", () => {
    expect(fingerprint(["a", "b"])).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["a", "b"]));
  });
  it("distinguishes part boundaries", () => {
    expect(fingerprint(["ab", "c"])).not.toBe(fingerprint(["a", "bc"]));
  });
});
