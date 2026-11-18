import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton, useCopy } from "./CopyButton";

const LABELS = { label: "复制它", copiedLabel: "复制好了", failedLabel: "没复制上，请手动选" };

afterEach(() => vi.restoreAllMocks());

describe("CopyButton", () => {
  it("writes the text to the clipboard and says so", async () => {
    const user = userEvent.setup();
    render(<CopyButton getText={() => "要复制的文字"} {...LABELS} />);
    await user.click(screen.getByRole("button", { name: "复制它" }));
    expect(await navigator.clipboard.readText()).toBe("要复制的文字");
    expect(await screen.findByText("复制好了")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers the same text, selected and read-only, when the clipboard refuses", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    render(<CopyButton getText={() => "备用文字"} {...LABELS} />);
    await user.click(screen.getByRole("button", { name: "复制它" }));
    expect(await screen.findByText("没复制上，请手动选")).toBeTruthy();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("备用文字");
    expect(box.readOnly).toBe(true);
    expect(select).toHaveBeenCalled();
    expect(screen.queryByText("复制好了")).toBeNull();
  });

  it("reads the text when pressed, not when rendered", async () => {
    const user = userEvent.setup();
    let current = "一";
    render(<CopyButton getText={() => current} {...LABELS} />);
    current = "二";
    await user.click(screen.getByRole("button", { name: "复制它" }));
    expect(await navigator.clipboard.readText()).toBe("二");
  });

  it("puts buttonClassName on the button and className on the wrapper", () => {
    const { container } = render(
      <CopyButton getText={() => "x"} className="wrap" buttonClassName="skin" {...LABELS} />,
    );
    expect(screen.getByRole("button", { name: "复制它" }).classList.contains("skin")).toBe(true);
    expect((container.firstElementChild as HTMLElement).classList.contains("wrap")).toBe(true);
  });

  it("can be disabled", () => {
    render(<CopyButton getText={() => "x"} isDisabled {...LABELS} />);
    expect((screen.getByRole("button", { name: "复制它" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("does not update state after unmount while the clipboard is still pending", async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let release: () => void = () => {};
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { unmount } = render(<CopyButton getText={() => "x"} {...LABELS} />);
    await user.click(screen.getByRole("button", { name: "复制它" }));
    unmount();
    release();
    await waitFor(() => expect(errors).not.toHaveBeenCalled());
  });
});

describe("useCopy", () => {
  it("goes idle → copied, and idle → failed when the clipboard refuses", async () => {
    const { result } = renderHook(() => useCopy(() => "文字"));
    expect(result.current.state).toBe("idle");
    await act(async () => {
      await result.current.copy();
    });
    expect(result.current.state).toBe("copied");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await act(async () => {
      await result.current.copy();
    });
    expect(result.current.state).toBe("failed");
  });
});
