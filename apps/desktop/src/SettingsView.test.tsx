import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITION_KEY, type EditionEntitlement, EditionProvider } from "./edition";
import { t } from "./i18n";
import type { ModelClient } from "./ipc";
import { SettingsView } from "./SettingsView";

const models: ModelClient = { list: vi.fn(async () => []) };
const html = document.documentElement;

function mount(entitlement?: EditionEntitlement) {
  return render(
    <EditionProvider entitlement={entitlement} prefersDark={() => false}>
      <SettingsView models={models} />
    </EditionProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete html.dataset.edition;
  html.classList.remove("dark");
});
afterEach(() => window.localStorage.clear());

describe("设置 page", () => {
  it("has one h1 and two sections: 界面版本 then AI 模型", async () => {
    mount();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      t("settings.title"),
    ]);
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2).toEqual([t("settings.edition.title"), t("settings.models.title")]);
    await screen.findByText(t("settings.models.none"));
  });

  it("offers both editions as a radio group with easy selected by default", () => {
    mount();
    const group = screen.getByRole("group", { name: t("settings.edition.legend") });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    const easy = screen.getByRole("radio", { name: t("settings.edition.easy.name") });
    const boss = screen.getByRole("radio", { name: t("settings.edition.boss.name") });
    expect((easy as HTMLInputElement).checked).toBe(true);
    expect((boss as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(t("settings.edition.easy.desc"))).toBeTruthy();
    expect(screen.getByText(t("settings.edition.boss.desc"))).toBeTruthy();
    expect(screen.getByText(t("settings.edition.note"))).toBeTruthy();
  });

  it("choosing 老板版 applies at once: data-edition, dark, stored", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    expect(
      (screen.getByRole("radio", { name: t("settings.edition.boss.name") }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(html.dataset.edition).toBe("boss");
    expect(html.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(EDITION_KEY)).toBe("boss");
    await user.click(screen.getByRole("radio", { name: t("settings.edition.easy.name") }));
    expect(html.dataset.edition).toBe("easy");
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    mount();
    screen.getByRole("radio", { name: t("settings.edition.easy.name") }).focus();
    await user.keyboard("{ArrowDown}");
    expect(html.dataset.edition).toBe("boss");
  });

  it("a not-allowed 老板版 is disabled with a plain reason and no upsell", async () => {
    const user = userEvent.setup();
    const deny: EditionEntitlement = { allows: (e) => e !== "boss" };
    mount(deny);
    const boss = screen.getByRole("radio", { name: t("settings.edition.boss.name") });
    expect((boss as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(t("settings.edition.denied"))).toBeTruthy();
    expect(boss.getAttribute("aria-describedby")).toBeTruthy();
    await user.click(boss);
    expect(html.dataset.edition).toBe("easy");
    expect(window.localStorage.getItem(EDITION_KEY)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/升级|购买|订阅|价格|¥|元\//);
  });
});
