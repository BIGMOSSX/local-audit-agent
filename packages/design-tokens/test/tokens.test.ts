import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_ACCENT, contrastRatio, luminance } from "../src/index";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

function blocks(source: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const chunk of source.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const [selector, body] = chunk.split("{");
    if (!selector || !body) continue;
    const decls: Record<string, string> = {};
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (m[1] && m[2]) decls[m[1]] = m[2].trim();
    }
    out.set(selector.trim().replace(/\s+/g, " "), decls);
  }
  return out;
}

const parsed = blocks(css);
const light = parsed.get(':root, [data-theme="light"]');
const dark = parsed.get('.dark, [data-theme="dark"]');

describe("contrast maths", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(
      contrastRatio("#fedcba", "#123456"),
      10,
    );
  });
  it("rejects non 6-digit hex", () => {
    expect(() => luminance("#fff")).toThrow();
    expect(() => luminance("oklch(0.5 0.1 100)")).toThrow();
  });
});

describe("brand tokens", () => {
  it("defines both themes", () => {
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
  });
  it("uses the brand accent in both themes", () => {
    expect(BRAND_ACCENT).toBe("#6ae301");
    expect(light?.["--accent"]).toBe(BRAND_ACCENT);
    expect(dark?.["--accent"]).toBe(BRAND_ACCENT);
  });
  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("%s theme meets contrast floors", (_name, theme) => {
    const t = theme ?? {};
    const need = (k: string): string => {
      const v = t[k];
      if (!v) throw new Error(`missing ${k}`);
      return v;
    };
    expect(contrastRatio(need("--accent-foreground"), need("--accent"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(need("--foreground"), need("--background"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(need("--focus"), need("--background"))).toBeGreaterThanOrEqual(3);
  });
});
