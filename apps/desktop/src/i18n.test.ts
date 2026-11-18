import { FindingCategorySchema, IpcErrorCodeSchema } from "@audit/audit-core";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CJK,
  FORBIDDEN_SUBSTRINGS,
  NAME_PATTERNS,
} from "../../../scripts/check-policy.mjs";
import { errorText, t } from "./i18n";
import zh from "./locales/zh.json";

describe("t", () => {
  it("returns the Chinese source text", () => {
    expect(t("home.pick")).toBe("选择项目文件夹");
  });

  it("fills named placeholders and leaves a missing one visible", () => {
    expect(t("error.detail", { message: "boom" })).toBe("详情：boom");
    expect(t("error.detail")).toBe("详情：{message}");
  });

  it("does not substitute inside a substituted value", () => {
    expect(t("error.detail", { message: "{message}" })).toBe("详情：{message}");
  });
});

describe("errorText", () => {
  const codes = [
    ...IpcErrorCodeSchema.options,
    "sidecar_unavailable",
    "sidecar_protocol",
    "sidecar_io",
  ] as const;
  it.each(codes)("has readable text for %s", (code) => {
    const text = errorText(code);
    expect(text.length).toBeGreaterThan(3);
    expect(text).not.toContain("error.");
  });
});

describe("copy rules (AGENTS.md hard rules)", () => {
  const values = Object.values(zh);
  it("never says 白话 / 大白话 and never calls the product 自研", () => {
    for (const value of values) expect(value).not.toMatch(/白话|自研/);
  });
  it("names no engine, scanner or model vendor", () => {
    const banned =
      /Semgrep|Trivy|Gitleaks|OpenAI|Anthropic|Claude|Gemini|Ollama|Understand Anything|Agentic QE|reverse-skill/i;
    for (const value of values) expect(value).not.toMatch(banned);
  });
});

describe("BOSS copy rules (design #14)", () => {
  const entries = Object.entries(zh).filter(
    ([key]) => key.startsWith("boss.") || key.startsWith("settings.edition."),
  );
  const values = [...entries.map(([, value]) => value), t("app.title")];
  const bannedPhrases = [
    "!",
    "！",
    "皇冠",
    "至尊",
    "VIP",
    "立即升级",
    "100% 安全",
    "100%安全",
    "保证无漏洞",
    "绝对放心",
    "白话",
    "自研",
    "我们",
  ];

  it("covers a meaningful set of keys", () => {
    expect(entries.length).toBeGreaterThan(80);
  });

  it("uses none of the over-promising or marketing phrases", () => {
    for (const value of values) {
      for (const phrase of bannedPhrases) expect(value, phrase).not.toContain(phrase);
    }
  });

  it("names no engine, scanner or model vendor (same list as pnpm check:policy)", () => {
    for (const value of values) {
      for (const term of FORBIDDEN_CJK) expect(value, term).not.toContain(term);
      for (const term of FORBIDDEN_SUBSTRINGS) {
        expect(value.toLowerCase(), term).not.toContain(term.toLowerCase());
      }
      for (const { label, re } of NAME_PATTERNS) expect(value, label).not.toMatch(re);
    }
  });

  it("has a business-consequence sentence for every finding category", () => {
    for (const category of FindingCategorySchema.options) {
      expect(zh, `boss.impact.${category}`).toHaveProperty(`boss.impact.${category}`);
    }
    expect(zh).toHaveProperty("boss.impact.unknown");
  });
});
