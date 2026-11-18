import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditionProvider } from "./edition";
import { SKIPPED_GATES } from "./gates";
import { t } from "./i18n";
import { Sidebar } from "./Sidebar";

const original = { ...SKIPPED_GATES };

function mount() {
  window.localStorage.setItem("audit.edition", "boss");
  return render(
    <EditionProvider prefersDark={() => false}>
      <Sidebar view="projects" onSelect={() => {}} />
    </EditionProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  SKIPPED_GATES.understand = original.understand;
  window.localStorage.clear();
});

describe("Sidebar · 老板版 status line", () => {
  it("says no AI model is connected while 读懂项目 is a model task this version skips", () => {
    mount();
    expect(SKIPPED_GATES.understand).toBe("model");
    expect(screen.getByText(t("boss.nav.status"))).toBeTruthy();
  });

  it("follows SKIPPED_GATES, so it cannot outlive the fact it states", () => {
    delete SKIPPED_GATES.understand;
    mount();
    expect(screen.queryByText(t("boss.nav.status"))).toBeNull();
    expect(screen.getByText(t("boss.nav.local"))).toBeTruthy();
  });
});
