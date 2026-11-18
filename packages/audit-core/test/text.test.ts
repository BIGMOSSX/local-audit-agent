import { describe, expect, it } from "vitest";
import { sanitizeEngineText } from "../src/text";

describe("sanitizeEngineText (§102: engine output is untrusted data)", () => {
  it("strips ANSI escapes and control characters but keeps newlines and tabs", () => {
    expect(sanitizeEngineText("\u001b[31mred\u001b[0m\u0000\u0007 ok\n\tx", 100)).toBe(
      "red ok\n\tx",
    );
  });
  it("strips bidi override characters", () => {
    expect(sanitizeEngineText("a\u202Eb\u2066c", 100)).toBe("abc");
  });
  it("strips zero-width characters and U+2028/2029 line separators", () => {
    expect(sanitizeEngineText("a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u2028g\u2029h", 100)).toBe(
      "abcdefgh",
    );
  });
  it("caps length with an ellipsis, counting code points", () => {
    expect(sanitizeEngineText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(sanitizeEngineText("😀".repeat(20), 5)).toBe(`${"😀".repeat(4)}…`);
  });
  it("strips tag characters, variation selectors and other invisible format characters", () => {
    expect(sanitizeEngineText("a\u{E0041}\u{E0042}b", 100)).toBe("ab");
    expect(sanitizeEngineText("a\u{E007F}b", 100)).toBe("ab");
    expect(sanitizeEngineText("a\u00ADb", 100)).toBe("ab");
    expect(sanitizeEngineText("a\u061Cb", 100)).toBe("ab");
    expect(sanitizeEngineText("a\u180Eb", 100)).toBe("ab");
    expect(sanitizeEngineText("a\uFE0Fb\u{E0100}c\u{E01EF}d", 100)).toBe("abcd");
    expect(
      sanitizeEngineText("a\u2061\u2062\u2063\u2064b\u206A\u206Fc\uFFF9\uFFFAd\uFFFBe", 100),
    ).toBe("abcde");
  });
  it("normalizes CRLF and lone CR to LF so CR cannot overwrite a line", () => {
    expect(sanitizeEngineText("a\u000D\u000Ab\u000Dc\n\u0009d", 100)).toBe("a\nb\nc\n\td");
  });
  it("bounds work and output for hostile or degenerate limits", () => {
    expect(sanitizeEngineText("x", 0)).toBe("");
    expect(sanitizeEngineText("x", -5)).toBe("");
    expect(sanitizeEngineText("x", Number.NaN)).toBe("");
    expect(sanitizeEngineText("xyz", 1)).toBe("\u2026");
    const huge = "x".repeat(5_000_000);
    const out = sanitizeEngineText(huge, 10);
    expect(Array.from(out).length).toBeLessThanOrEqual(10);
    expect(out.endsWith("\u2026")).toBe(true);
  });
  it("replaces lone surrogates with U+FFFD but keeps valid pairs", () => {
    expect(sanitizeEngineText("a\uD800b\uDC00c", 100)).toBe("a\uFFFDb\uFFFDc");
    expect(sanitizeEngineText("a\u{1F600}b", 100)).toBe("a\u{1F600}b");
  });
  it("leaves short clean text unchanged and never throws on non-strings", () => {
    expect(sanitizeEngineText("fine", 100)).toBe("fine");
    expect(sanitizeEngineText(undefined as unknown as string, 10)).toBe("");
  });
});
