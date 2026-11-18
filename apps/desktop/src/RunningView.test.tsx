import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunningView } from "./RunningView";
import { runningRun } from "./test-support/audit";

describe("RunningView", () => {
  it("marks the current step and shows a number only when the run reports one", () => {
    const { container, rerender } = render(
      <RunningView
        name="alpha"
        run={runningRun({ stage: "checking", progress: { engine: "quality", done: 2, total: 5 } })}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("找安全漏洞");
    expect(screen.getByText("已完成 2 / 5 项")).toBeTruthy();

    rerender(
      <RunningView
        name="alpha"
        run={runningRun({ stage: "reading" })}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/已完成 \d/)).toBeNull();
    expect(screen.getByText("正在进行，没有可靠的进度数字")).toBeTruthy();
  });

  it("always says 读懂项目 and 试运行测试 are not done in this version, with the reason", () => {
    const { container } = render(
      <RunningView
        name="alpha"
        run={runningRun({ stage: "checking", progress: { engine: "quality", done: 2, total: 5 } })}
        cancelling={false}
        onCancel={() => {}}
      />,
    );
    const items = [...container.querySelectorAll("ol > li")];
    expect(items[0]?.textContent).toContain("读懂项目");
    expect(items[0]?.textContent).toContain("这次不做");
    expect(items[0]?.textContent).toContain("需要连接 AI 模型");
    expect(items[0]?.textContent).not.toContain("已经过");
    expect(items[1]?.textContent).toContain("试运行测试");
    expect(items[1]?.textContent).toContain("这次不做");
    expect(items[1]?.textContent).toContain("运行项目自己的测试需要另外的许可");
    expect(items[1]?.textContent).not.toMatch(/正在进行|已经过|已完成 \d/);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it("never prints a percentage and never says a stage is finished", () => {
    for (const stage of ["reading", "checking", "concluding"] as const) {
      const { container, unmount } = render(
        <RunningView
          name="alpha"
          run={runningRun({
            stage,
            progress: stage === "checking" ? { engine: "x", done: 1, total: 3 } : null,
          })}
          cancelling={false}
          onCancel={() => {}}
        />,
      );
      expect(container.textContent).not.toContain("%");
      expect(screen.queryByText("已完成")).toBeNull();
      expect(screen.queryByText("没有做")).toBeNull();
      unmount();
    }
  });

  it("cancel calls the handler and is disabled while cancelling", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <RunningView name="alpha" run={runningRun()} cancelling={false} onCancel={onCancel} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "取消检查" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<RunningView name="alpha" run={runningRun()} cancelling onCancel={onCancel} />);
    const busy = screen.getByRole("button", { name: "正在取消…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });
});
