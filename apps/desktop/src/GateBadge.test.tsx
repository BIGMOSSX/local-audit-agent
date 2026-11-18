import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateBadge } from "./GateBadge";
import { t } from "./i18n";

describe("GateBadge", () => {
  it.each([
    ["blocked", "先别发布"],
    ["review", "建议先看看"],
    ["ready", "可以发布"],
    ["none", "这次没有完成任何检查"],
  ] as const)("says %s in words, not only in colour", (gate, label) => {
    render(<GateBadge gate={gate} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(t(`gate.${gate}`)).toBe(label);
  });
  it("says cancelled in words for a cancelled run without a blocker, and keeps the gate in data-gate", () => {
    const { container } = render(<GateBadge gate="none" cancelled />);
    expect(screen.getByText("这次检查已取消，没有得出结论")).toBeTruthy();
    expect(container.querySelector('[data-gate="none"]')).toBeTruthy();
    expect(container.querySelector("[data-cancelled]")).toBeTruthy();
  });

  it("never hides a blocker behind the cancelled label", () => {
    render(<GateBadge gate="blocked" cancelled />);
    expect(screen.getByText("先别发布")).toBeTruthy();
    expect(screen.queryByText("这次检查已取消，没有得出结论")).toBeNull();
  });
});
