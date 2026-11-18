import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DegradedBanner } from "./DegradedBanner";
import { finishedRun, MODEL_MISSING, runningRun } from "./test-support/audit";

describe("DegradedBanner", () => {
  it("renders nothing for a complete run", () => {
    const { container } = render(<DegradedBanner run={finishedRun()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the run is still running", () => {
    const { container } = render(<DegradedBanner run={runningRun()} />);
    expect(container.firstChild).toBeNull();
  });

  it("says what is missing, what it changes and how to fix it, as a named region", () => {
    render(<DegradedBanner run={finishedRun({ notDone: [MODEL_MISSING] })} />);
    const region = screen.getByRole("region", { name: "这次检查不完整" });
    expect(within(region).getByText("缺了什么：")).toBeTruthy();
    expect(within(region).getByText("影响什么：")).toBeTruthy();
    expect(within(region).getByText("怎么补：")).toBeTruthy();
    expect(region.textContent).toContain("没做的部分，在这个版本里还补不上");
  });

  it("a cancelled run says cancelled and offers a re-check", () => {
    render(<DegradedBanner run={finishedRun({ status: "cancelled", engines: [] })} />);
    const region = screen.getByRole("region", { name: "这次检查不完整" });
    expect(region.textContent).toContain("这次检查被取消了，只做了一部分。");
    expect(region.textContent).toContain("重新检查");
  });
});
