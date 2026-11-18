import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/index";

describe("shared Button", () => {
  it("renders an accessible button and fires onPress once per click", async () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>选择项目文件夹</Button>);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", async () => {
    const onPress = vi.fn();
    render(
      <Button isDisabled onPress={onPress}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("styles.css", () => {
  it("imports tailwind, then HeroUI styles, then brand tokens (order matters for overrides)", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
      "utf8",
    );
    const order = ['"tailwindcss"', '"@heroui/styles"', '"@audit/design-tokens/tokens.css"'].map(
      (s) => css.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
