import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("web shell", () => {
  it("renders the product name and a shared-UI button", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Local Audit Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shell button" })).toBeTruthy();
  });
});
