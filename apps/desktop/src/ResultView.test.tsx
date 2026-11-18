import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResultView } from "./ResultView";
import { finishedRun, MODEL_MISSING, makeFinding, OK_ENGINE } from "./test-support/audit";

const noop = () => {};
const baseProps = {
  findingsFailure: null,
  starting: false,
  onRecheck: noop,
  onRetryFindings: noop,
};

const REAL_DAEMON = [
  { what: "quality: 引擎未能运行", reason: "分析引擎尚未安装" },
  { what: "检查", reason: "没有任何检查实际运行" },
  { what: "读懂项目、生成测试、安全深度分析", reason: "需要连接 AI 模型" },
];
// What engine-service produces when the engine could not start: applicable, but no task ran.
const FAILED_ENGINE = { id: "quality", applicable: true, tasks: [] };

describe("ResultView", () => {
  it("says honestly that nothing ran, for what the real daemon produces today", () => {
    const run = finishedRun({ notDone: REAL_DAEMON, engines: [FAILED_ENGINE] });
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    expect(screen.getAllByText(/没有完成任何检查/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/0 个问题/);
    expect(run.summary).toMatchObject({ gate: "none", checked: 0, skipped: 0, failed: 0 });
    expect(container.textContent).not.toContain("可以发布");
    expect(container.textContent).not.toContain("在这次检查做过的范围内");
    expect(screen.queryByRole("region", { name: "按轻重分的数量" })).toBeNull();
    expect(screen.getByText("检查了 0 项，跳过 0 项，失败 0 项")).toBeTruthy();
    expect(screen.getByText("引擎未能运行：分析引擎尚未安装")).toBeTruthy();
    expect(
      screen.getAllByText("读懂项目、生成测试、安全深度分析：需要连接 AI 模型").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/连接 AI 模型的功能还在开发中/)).toBeTruthy();
    expect(container.textContent).not.toContain("设置");
    expect(container.textContent).not.toContain("%");
  });

  it("shows engine ids only inside the closed 高级 drawer", () => {
    const run = finishedRun({ notDone: REAL_DAEMON, engines: [FAILED_ENGINE] });
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    const drawer = container.querySelector("details.advanced") as HTMLDetailsElement;
    expect(drawer).toBeTruthy();
    expect(drawer.open).toBe(false);
    const outside = (container.textContent ?? "").replace(drawer.textContent ?? "", "");
    expect(outside).not.toContain("quality");
    expect(drawer.textContent).toContain("quality");
    expect(drawer.textContent).toContain("quality: 引擎未能运行");
  });

  it("states the three verdicts in words", () => {
    const ready = finishedRun({ engines: [OK_ENGINE] });
    const view = render(<ResultView {...baseProps} run={ready} findings={[]} />);
    expect(screen.getAllByText("可以发布").length).toBeGreaterThan(0);
    view.unmount();

    const review = finishedRun({
      engines: [OK_ENGINE],
      findings: [makeFinding({ severity: "high" })],
    });
    const second = render(<ResultView {...baseProps} run={review} findings={[]} />);
    expect(screen.getAllByText("建议先看看").length).toBeGreaterThan(0);
    second.unmount();

    const blocked = finishedRun({
      engines: [OK_ENGINE],
      findings: [makeFinding({ severity: "critical" })],
    });
    render(<ResultView {...baseProps} run={blocked} findings={[]} />);
    expect(screen.getAllByText("先别发布").length).toBeGreaterThan(0);
  });

  it("promises 放行 only when fixing everything would really reach ready", () => {
    const fixable = finishedRun({
      engines: [OK_ENGINE],
      findings: [makeFinding({ severity: "critical" }), makeFinding({ severity: "high" })],
    });
    expect(fixable.summary?.afterFix).toBe("ready");
    const first = render(<ResultView {...baseProps} run={fixable} findings={[]} />);
    expect(screen.getByText("还差 2 件事就能放行。")).toBeTruthy();
    first.unmount();

    const partial = finishedRun({
      engines: [OK_ENGINE],
      notDone: [MODEL_MISSING],
      findings: [makeFinding({ severity: "critical" })],
    });
    expect(partial.summary?.afterFix).toBe("review");
    const { container } = render(<ResultView {...baseProps} run={partial} findings={[]} />);
    expect(container.textContent).not.toContain("就能放行");
    expect(
      screen.getByText(
        "还有 1 件事需要先处理。处理完之后，因为有些检查没有做或没做完，闸门最多到「建议先看看」，还不能放行。",
      ),
    ).toBeTruthy();
  });

  it("never says 必须先修 in the need-to-fix sentence when nothing is a must", () => {
    const run = finishedRun({
      engines: [OK_ENGINE],
      notDone: [MODEL_MISSING],
      findings: [makeFinding({ severity: "high" })],
    });
    expect(run.summary).toMatchObject({ needed: 1, counts: { must: 0, should: 1 } });
    expect(run.summary?.afterFix).toBe("review");
    render(<ResultView {...baseProps} run={run} findings={[]} />);
    const sentence = screen.getByText(/件事需要先处理/);
    expect(sentence.textContent).not.toContain("必须先修");
    expect(screen.queryByText(/^必须先修 \d+ 件事/)).toBeNull();
  });

  it("explains a yellow gate that comes from missing checks, not from findings", () => {
    const run = finishedRun({ engines: [OK_ENGINE], notDone: [MODEL_MISSING] });
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    expect(screen.getByText(/不是因为发现了问题/)).toBeTruthy();
    expect(container.textContent).not.toContain("就能放行");
  });

  it("shows the bucket counts next to the checked line, and the stale banner only when stale", () => {
    const findings = [
      makeFinding({ severity: "critical" }),
      makeFinding({ severity: "medium" }),
      makeFinding({ severity: "low" }),
      makeFinding({ severity: "info" }),
    ];
    const run = finishedRun({ engines: [OK_ENGINE], findings });
    const view = render(<ResultView {...baseProps} run={run} findings={findings} />);
    const columns = screen.getByRole("region", { name: "按轻重分的数量" });
    expect(within(columns).getByText("必须先修").parentElement?.textContent).toContain("1");
    expect(within(columns).getByText("建议修").parentElement?.textContent).toContain("1");
    expect(within(columns).getByText("可以之后再说").parentElement?.textContent).toContain("2");
    expect(screen.getByText("检查了 1 项，跳过 0 项，失败 0 项")).toBeTruthy();
    expect(screen.queryByText(/代码在这次检查之后改过/)).toBeNull();
    view.unmount();

    for (const stale of [null, false]) {
      const r = render(<ResultView {...baseProps} run={{ ...run, stale }} findings={findings} />);
      expect(screen.queryByText(/代码在这次检查之后改过/)).toBeNull();
      r.unmount();
    }
    render(<ResultView {...baseProps} run={{ ...run, stale: true }} findings={findings} />);
    expect(screen.getByText(/代码在这次检查之后改过/)).toBeTruthy();
  });

  it("renders the first 50 cards and the rest only after 显示更多", async () => {
    const findings = Array.from({ length: 120 }, () => makeFinding({ severity: "low" }));
    const run = finishedRun({ engines: [OK_ENGINE], findings });
    render(<ResultView {...baseProps} run={run} findings={findings} />);
    expect(screen.getAllByRole("article")).toHaveLength(50);
    expect(screen.getByText("已显示 50 / 120 条")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "显示更多" }));
    expect(screen.getAllByRole("article")).toHaveLength(100);
    await userEvent.click(screen.getByRole("button", { name: "显示更多" }));
    expect(screen.getAllByRole("article")).toHaveLength(120);
    expect(screen.queryByRole("button", { name: "显示更多" })).toBeNull();
  });

  it("keeps the verdict when the list failed to load and offers a retry", async () => {
    const onRetryFindings = vi.fn();
    const run = finishedRun({
      engines: [OK_ENGINE],
      findings: [makeFinding({ severity: "high" })],
    });
    render(
      <ResultView
        {...baseProps}
        run={run}
        findings={null}
        findingsFailure={{ code: "internal", detail: "boom" }}
        onRetryFindings={onRetryFindings}
      />,
    );
    expect(screen.getAllByText("建议先看看").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("没有能读取到问题列表");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetryFindings).toHaveBeenCalledTimes(1);
  });

  it("recheck is disabled while a new run is starting", async () => {
    const onRecheck = vi.fn();
    const run = finishedRun();
    const { rerender } = render(
      <ResultView {...baseProps} run={run} findings={[]} onRecheck={onRecheck} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    rerender(<ResultView {...baseProps} run={run} findings={[]} onRecheck={onRecheck} starting />);
    expect((screen.getByRole("button", { name: "正在开始…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  describe("degraded-run banner", () => {
    const banner = (_container: HTMLElement) =>
      screen.queryByRole("region", { name: "这次检查不完整" });

    it("is absent for a complete run", () => {
      const { container } = render(
        <ResultView {...baseProps} run={finishedRun({ engines: [OK_ENGINE] })} findings={[]} />,
      );
      expect(banner(container)).toBeNull();
    });

    it("says what is missing, what it affects and what can be done, above everything else", () => {
      const run = finishedRun({ notDone: REAL_DAEMON, engines: [FAILED_ENGINE] });
      const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
      const el = banner(container) as HTMLElement;
      expect(el).toBeTruthy();
      expect(container.firstElementChild?.firstElementChild).toBe(el);
      const text = el.textContent ?? "";
      expect(text).toMatch(/缺了什么/);
      expect(text).toMatch(/影响/);
      expect(text).toMatch(/怎么补/);
      expect(text).toMatch(/没有任何检查真正运行/);
      expect(text).not.toContain("quality");
      expect(text).not.toContain("%");
    });

    it("never promises a way to fix what this version cannot fix", () => {
      const run = finishedRun({ notDone: REAL_DAEMON, engines: [FAILED_ENGINE] });
      const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
      const text = banner(container)?.textContent ?? "";
      expect(text).toMatch(/重新检查也不会变/);
      expect(text).not.toMatch(/设置|安装|连接 AI 模型/);
    });

    it("tells a cancelled run to run it again", () => {
      const run = finishedRun({ status: "cancelled" });
      const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
      const text = banner(container)?.textContent ?? "";
      expect(text).toMatch(/被取消/);
      expect(text).toMatch(/重新检查/);
    });

    it("counts skipped and failed checks from the summary", () => {
      const run = finishedRun({
        engines: [
          {
            id: "quality",
            applicable: true,
            tasks: [
              { id: "lint", status: "ok" },
              { id: "tests", status: "skipped" },
              { id: "types", status: "failed" },
            ],
          },
        ],
      });
      const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
      expect(banner(container)?.textContent).toMatch(/跳过了 1 项，失败了 1 项/);
    });

    it("does not say the gate could be green for a partial run", () => {
      const run = finishedRun({ engines: [OK_ENGINE], notDone: [MODEL_MISSING] });
      const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
      const text = banner(container)?.textContent ?? "";
      expect(text).toMatch(/最高只到「建议先看看」/);
      expect(text).not.toContain("可以发布");
    });
  });
  it("a cancelled run in which nothing ran says it was cancelled and that no conclusion was reached", () => {
    const run = finishedRun({
      status: "cancelled",
      engines: [],
      notDone: [{ what: "审计", reason: "已取消，结果不完整" }, MODEL_MISSING],
    });
    expect(run.summary?.gate).toBe("none");
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    expect(screen.getAllByText("这次检查已取消，没有得出结论").length).toBeGreaterThan(0);
    expect(screen.getByText(/你取消了这次检查/)).toBeTruthy();
    expect(container.textContent).not.toContain("没有完成任何检查");
    expect(container.textContent).not.toContain("可以发布");
    expect(container.textContent).not.toContain("建议先看看");
    expect(container.querySelector('[data-gate="ready"], [data-gate="review"]')).toBeNull();
    expect(container.querySelector('[data-gate="none"]')).toBeTruthy();
    expect(screen.getByRole("region", { name: "这次检查已取消，没有得出结论" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "这次检查不完整" })).toBeTruthy();
  });

  it("a cancelled run that already holds a blocker stays red", () => {
    const run = finishedRun({
      status: "cancelled",
      engines: [OK_ENGINE],
      notDone: [{ what: "审计", reason: "已取消，结果不完整" }],
      findings: [makeFinding({ severity: "critical" })],
    });
    expect(run.summary?.gate).toBe("blocked");
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    expect(screen.getAllByText("先别发布").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("没有得出结论");
  });

  it("a finished run that is not cancelled keeps its own headline", () => {
    const run = finishedRun({ notDone: REAL_DAEMON, engines: [FAILED_ENGINE] });
    const { container } = render(<ResultView {...baseProps} run={run} findings={[]} />);
    expect(container.textContent).not.toContain("已取消");
  });
});
