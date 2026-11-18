import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/index";

const css = readFileSync(new URL("../src/boss.css", import.meta.url), "utf8");
const SCOPE = '[data-edition="boss"]';

interface Rule {
  selector: string;
  body: string;
  at: string | null;
}

function parse(source: string, at: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let rest = source.replace(/\/\*[\s\S]*?\*\//g, "");
  while (rest.trim().length > 0) {
    const open = rest.indexOf("{");
    if (open === -1) break;
    const header = rest.slice(0, open).trim().replace(/\s+/g, " ");
    let depth = 1;
    let i = open + 1;
    while (i < rest.length && depth > 0) {
      if (rest[i] === "{") depth++;
      if (rest[i] === "}") depth--;
      i++;
    }
    const inner = rest.slice(open + 1, i - 1);
    if (header.startsWith("@")) rules.push(...parse(inner, header));
    else rules.push({ selector: header, body: inner, at });
    rest = rest.slice(i);
  }
  return rules;
}

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2])
      out[m[1]] = m[2].trim().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  }
  return out;
}

const rules = parse(css);
const tokenRule = rules.find((r) => r.selector === `:root${SCOPE}` && r.at === null);
const tokens = decls(tokenRule?.body ?? "");

function resolve(name: string, seen: string[] = []): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`missing token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (!ref?.[1]) return raw;
  if (seen.includes(ref[1])) throw new Error(`cycle at ${ref[1]}`);
  return resolve(ref[1], [...seen, name]);
}
const hex = (name: string): string => {
  const v = resolve(name);
  if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a 6-digit hex colour: ${v}`);
  return v;
};

const GOLD = ["--boss-gold-1", "--boss-gold-2", "--boss-gold-3"] as const;

describe("BOSS token block", () => {
  it("exists, is dark and sets the semantic tokens the components read", () => {
    expect(tokenRule).toBeDefined();
    expect(tokens["color-scheme"]).toBe("dark");
    for (const k of [
      "--background",
      "--foreground",
      "--surface",
      "--surface-foreground",
      "--surface-secondary",
      "--overlay",
      "--overlay-foreground",
      "--muted",
      "--default",
      "--default-foreground",
      "--field-background",
      "--field-foreground",
      "--border",
      "--separator",
      "--focus",
      "--accent",
      "--accent-foreground",
      "--danger",
      "--danger-foreground",
      "--warning",
      "--warning-foreground",
      "--success",
      "--success-foreground",
    ]) {
      expect(tokens[k], k).toBeDefined();
    }
  });

  it("only ever applies under the BOSS scope (nothing leaks into the default theme)", () => {
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) {
      if (r.at?.startsWith("@media print")) continue;
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        expect(sel.includes(SCOPE), `unscoped selector: ${sel}`).toBe(true);
      }
    }
  });
});

describe("BOSS print stylesheet", () => {
  const printRules = rules.filter((r) => r.at?.startsWith("@media print"));
  const find = (needle: string) => printRules.filter((r) => r.selector.includes(needle));

  it("hides .no-print", () => {
    const rule = printRules.find((r) => r.selector === ".no-print");
    expect(decls(rule?.body ?? "").display).toMatch(/^none/);
  });

  it("shows only [data-report]: everything that is neither the sheet, inside it, nor an ancestor of it is display:none", () => {
    const hide = printRules.find(
      (r) =>
        r.selector.includes(":not([data-report])") &&
        r.selector.includes(":not([data-report] *)") &&
        r.selector.includes(":not(:has([data-report]))"),
    );
    expect(hide, "no rule hides the rest of the shell").toBeDefined();
    expect(decls(hide?.body ?? "").display).toMatch(/^none/);
    expect(hide?.selector.startsWith("body:has([data-report])")).toBe(true);
  });

  it("never hides with visibility (that keeps the boxes and prints blank pages)", () => {
    for (const r of printRules) expect(decls(r.body).visibility, r.selector).toBeUndefined();
  });

  it("resets the ancestors of the sheet to plain block flow", () => {
    const reset = printRules.find(
      (r) => r.selector === "body:has([data-report]) *:has([data-report])",
    );
    const d = decls(reset?.body ?? "");
    expect(d.display).toBe("block");
    expect(d.position).toBe("static");
    expect(d.width).toBe("auto");
    expect(d["max-width"]).toBe("none");
    expect(d["min-height"]).toBe("0");
    expect(d.height).toBe("auto");
    expect(d.padding).toBe("0");
    expect(d.margin).toBe("0");
    expect(d.overflow).toBe("visible");
  });

  it("prints on paper: light colour-scheme, white page, dark text, backgrounds kept", () => {
    const page = find('html[data-edition="boss"]:has([data-report])').find((r) =>
      r.selector.includes("body"),
    );
    const p = decls(page?.body ?? "");
    expect(p["color-scheme"]).toBe("light");
    expect(p.background).toBe("#ffffff");
    expect(p.color).toBe("#111111");
    const keep = printRules.find((r) => r.selector === "[data-report], [data-report] *");
    const k = decls(keep?.body ?? "");
    expect(k["print-color-adjust"]).toBe("exact");
    expect(k["-webkit-print-color-adjust"]).toBe("exact");
  });

  it("the paper rules out-rank the screen skin they override (checked by specificity, not by text)", () => {
    const spec = (selector: string): number => {
      let a = 0;
      let b = 0;
      let c = 0;
      const sel = selector.replace(/:not\(|:has\(|\)/g, " ").replace(/\[[^\]]*\]/g, () => {
        b += 1;
        return " ";
      });
      for (const token of sel.split(/[\s>+~,]+/)) {
        if (token === "" || token === "*") continue;
        a += (token.match(/#[\w-]+/g) ?? []).length;
        b += (token.match(/\.[\w-]+|:[\w-]+/g) ?? []).length;
        if (/^[a-z]/i.test(token)) c += 1;
      }
      return a * 10000 + b * 100 + c;
    };
    const screen = (selector: string) => {
      const r = rules.find((x) => !x.at && x.selector === selector);
      expect(r, selector).toBeDefined();
      return spec(selector);
    };
    const paperPage = spec('html[data-edition="boss"]:has([data-report]) body');
    const paperSheet = spec('html[data-edition="boss"] [data-report]');
    expect(paperPage).toBeGreaterThan(screen('[data-edition="boss"] body'));
    expect(paperSheet).toBeGreaterThan(screen('[data-edition="boss"] .boss-card'));
    expect(paperSheet).toBeGreaterThan(screen('[data-edition="boss"] .boss-sheet'));
  });

  it("sets an A4 page with a margin", () => {
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(css).toMatch(/@page\s*\{[^}]*margin:\s*16mm/);
  });

  it("keeps rows and sections together and headings with what follows", () => {
    const joined = printRules.map((r) => `${r.selector}{${r.body}}`).join("\n");
    expect(joined).toMatch(/\[data-report\] li[\s\S]*break-inside:\s*avoid/);
    expect(joined).toMatch(/\[data-report\] h2[\s\S]*break-after:\s*avoid/);
  });

  it("paper colours still read: label, muted, none-badge and the amber border on white", () => {
    const sheet = decls(
      printRules.find((r) => r.selector === 'html[data-edition="boss"] [data-report]')?.body ?? "",
    );
    const val = (n: string): string => {
      const v = sheet[n];
      if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${n}: ${v}`);
      return v;
    };
    expect(contrastRatio(val("--boss-label"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(val("--muted"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(val("--foreground"), "#ffffff")).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(val("--boss-none-fg"), val("--boss-none-bg"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(val("--warning"), "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("every gate badge (the 13 px bold text on its fill) is ≥ 4.5:1 with the paper overrides applied", () => {
    const sheet = decls(
      printRules.find((r) => r.selector === 'html[data-edition="boss"] [data-report]')?.body ?? "",
    );
    const effective = { ...tokens, ...sheet };
    const paper = (name: string): string => {
      const seen: string[] = [];
      let cur = effective[name];
      while (cur !== undefined) {
        const ref = /^var\((--[\w-]+)\)$/.exec(cur);
        if (!ref?.[1]) break;
        if (seen.includes(ref[1])) throw new Error(`cycle at ${ref[1]}`);
        seen.push(ref[1]);
        cur = effective[ref[1]];
      }
      if (!cur || !/^#[0-9a-f]{6}$/i.test(cur)) throw new Error(`${name} is not hex: ${cur}`);
      return cur;
    };
    const gates = ["blocked", "review", "ready", "none"] as const;
    for (const gate of gates) {
      const rule = rules.find(
        (r) => r.at === null && r.selector === `${SCOPE} .boss-badge[data-gate="${gate}"]`,
      );
      const d = decls(rule?.body ?? "");
      const bg = /^var\((--[\w-]+)\)$/.exec(d["background-color"] ?? "")?.[1];
      const fg = /^var\((--[\w-]+)\)$/.exec(d.color ?? "")?.[1];
      if (!bg || !fg) throw new Error(`badge ${gate} does not use tokens`);
      expect(
        contrastRatio(paper(fg), paper(bg)),
        `${gate}: ${fg} on ${bg} (${paper(fg)} on ${paper(bg)})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("BOSS contrast floors (measured, not asserted from the canvas)", () => {
  const page = () => hex("--background");
  const card = () => hex("--surface");
  const raised = () => hex("--surface-secondary");

  it.each([
    ["page", page],
    ["card", card],
    ["raised", raised],
  ] as const)("body text on %s ≥ 7:1", (_n, bg) => {
    expect(contrastRatio(hex("--foreground"), bg())).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ["page", page],
    ["card", card],
    ["raised", raised],
  ] as const)("secondary text on %s ≥ 7:1", (_n, bg) => {
    expect(contrastRatio(hex("--muted"), bg())).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ["page", page],
    ["card", card],
  ] as const)("champagne label on %s ≥ 7:1", (_n, bg) => {
    expect(contrastRatio(hex("--boss-label"), bg())).toBeGreaterThanOrEqual(7);
  });

  it.each(GOLD)("primary button text on gradient stop %s ≥ 7:1", (stop) => {
    expect(contrastRatio(hex("--boss-on-gold"), hex(stop))).toBeGreaterThanOrEqual(7);
  });

  it("the gradient is built from exactly those three stops", () => {
    expect(tokens["--boss-gradient"]).toBe(
      "linear-gradient(180deg, var(--boss-gold-1), var(--boss-gold-2) 55%, var(--boss-gold-3))",
    );
  });

  it("solid accent (button hover/focus fallback) text ≥ 7:1", () => {
    expect(contrastRatio(hex("--accent-foreground"), hex("--accent"))).toBeGreaterThanOrEqual(7);
  });

  it("red as text on a card ≥ 4.5:1", () => {
    expect(contrastRatio(hex("--boss-red-text"), card())).toBeGreaterThanOrEqual(4.5);
  });

  it("white on solid red ≥ 4.5:1", () => {
    expect(contrastRatio(hex("--danger-foreground"), hex("--danger"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["warning", "--warning-foreground", "--warning"],
    ["success", "--success-foreground", "--success"],
    ["none", "--boss-none-fg", "--boss-none-bg"],
    ["default", "--default-foreground", "--default"],
  ] as const)("%s badge text ≥ 4.5:1", (_n, fg, bg) => {
    expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("focus ring against the page ≥ 3:1", () => {
    expect(contrastRatio(hex("--focus"), page())).toBeGreaterThanOrEqual(3);
  });
});

describe("BOSS type, brand and motion", () => {
  it("serif stack includes SimSun and every stack is a system stack (CSP: no web fonts)", () => {
    expect(tokens["--boss-font-serif"]).toContain('"SimSun"');
    expect(tokens["--boss-font-sans"]).toContain('"Microsoft YaHei"');
    expect(tokens["--boss-font-mono"]).toContain("ui-monospace");
    expect(css).not.toMatch(/@font-face|@import|url\(/);
  });

  it("brand green is only the 6 px status dot", () => {
    const withGreen = rules.filter((r) => /#6ae301/i.test(r.body));
    expect(withGreen.map((r) => r.selector)).toEqual([`${SCOPE} .boss-dot`]);
    const dot = decls(withGreen[0]?.body ?? "");
    expect(dot.width).toBe("6px");
    expect(dot.height).toBe("6px");
    expect(tokens["--accent"]).not.toMatch(/6ae301/i);
  });

  it("defines the utility classes the views use", () => {
    const selectors = rules.map((r) => r.selector).join(" | ");
    for (const c of [
      ".boss-card",
      ".boss-primary",
      ".boss-secondary",
      ".boss-serif",
      ".boss-label",
      ".boss-hairline",
      ".boss-dot",
      ".boss-sidebar",
      ".boss-sheet",
    ]) {
      expect(selectors, c).toContain(c);
    }
    for (const g of ["blocked", "review", "ready", "none"]) {
      expect(selectors, g).toContain(`.boss-badge[data-gate="${g}"]`);
    }
  });

  it("transitions are 200–400 ms, never on the red badge, and reduced motion turns them off", () => {
    for (const r of rules.filter((x) => x.at === null)) {
      const t = decls(r.body).transition;
      if (!t) continue;
      for (const m of t.matchAll(/(\d+)ms/g)) {
        const ms = Number(m[1]);
        expect(ms, `${r.selector}: ${t}`).toBeGreaterThanOrEqual(200);
        expect(ms, `${r.selector}: ${t}`).toBeLessThanOrEqual(400);
      }
    }
    const red = rules.filter((r) => r.selector.includes('[data-gate="blocked"]'));
    expect(red.length).toBeGreaterThan(0);
    for (const r of red) expect(decls(r.body).transition).toBeUndefined();
    const reduced = rules.filter((r) => r.at?.includes("prefers-reduced-motion"));
    expect(reduced.length).toBeGreaterThan(0);
    expect(decls(reduced[0]?.body ?? "").transition).toMatch(/^none/);
  });
});
