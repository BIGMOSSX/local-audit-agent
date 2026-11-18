import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BossOverview, type BossOverviewProps } from "./BossOverview";
import { buildHandoff } from "./handoff";
import { IpcCallError } from "./ipc";
import {
  fakeAudit,
  finishedRun,
  MODEL_MISSING,
  makeFinding,
  makeProject,
  runningRun,
} from "./test-support/audit";

const NOON = () => new Date(2026, 9, 13, 14, 0, 0);
const BLOCKER = makeFinding({ severity: "critical", confidence: "high", category: "secret" });

function props(over: Partial<BossOverviewProps> = {}): BossOverviewProps {
  return {
    audit: fakeAudit(),
    projects: [],
    failure: null,
    alreadyListed: false,
    tooMany: false,
    busy: false,
    dragging: false,
    dropUnavailable: false,
    onPick: vi.fn(),
    onCheck: vi.fn(),
    now: NOON,
    ...over,
  };
}

const alpha = makeProject("p1", "alpha");
const beta = makeProject("p2", "beta");
const gamma = makeProject("p3", "gamma");

describe("BossOverview · no project or no conclusion yet", () => {
  it("greets by time of day and offers choosing a folder when there is no project", () => {
    const onPick = vi.fn();
    render(<BossOverview {...props({ onPick })} />);
    expect(screen.getByRole("heading", { level: 1, name: "下午好。" })).toBeTruthy();
    expect(screen.getByText("还没有检查结论")).toBeTruthy();
    expect(screen.getByText("还没有项目做过检查。")).toBeTruthy();
    expect(screen.queryByText(/需要处理/)).toBeNull();
  });

  it("choosing a folder goes through onPick", async () => {
    const onPick = vi.fn();
    render(<BossOverview {...props({ onPick })} />);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("with projects but no run, 开始检查 targets the most recent project", async () => {
    const onCheck = vi.fn();
    render(<BossOverview {...props({ projects: [beta, alpha], onCheck })} />);
    await userEvent.click(await screen.findByRole("button", { name: "开始检查" }));
    expect(onCheck).toHaveBeenCalledWith(beta);
  });

  it("shows loading while the project list or the history is still being read", async () => {
    const never = new Promise<never>(() => {});
    const audit = fakeAudit({ history: vi.fn(() => never) });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    expect(screen.getByText("正在读取…")).toBeTruthy();
    expect(screen.queryByText("还没有检查结论")).toBeNull();
  });
});

describe("BossOverview · the featured project", () => {
  const history = (byProject: Record<string, ReturnType<typeof finishedRun> | null>) =>
    vi.fn(async (id: string) => {
      const run = byProject[id];
      return run ? [run] : [];
    });

  it("is the worst one, with its sentence, consequence and basis", async () => {
    const audit = fakeAudit({
      history: history({
        p1: finishedRun({ id: "run-ready", projectId: "p1" }),
        p2: finishedRun({
          id: "run-blocked",
          projectId: "p2",
          findings: [BLOCKER],
          notDone: [MODEL_MISSING],
        }),
        p3: finishedRun({ id: "run-none", projectId: "p3", engines: [] }),
      }),
      findings: vi.fn(async () => [BLOCKER]),
    });
    render(<BossOverview {...props({ audit, projects: [alpha, beta, gamma] })} />);
    const featured = (
      await screen.findByRole("heading", { level: 2, name: "建议暂缓发布。" })
    ).closest("section") as HTMLElement;
    expect(within(featured).getByText("beta")).toBeTruthy();
    expect(within(featured).getByText("有 1 项问题必须先处理，已按顺序列在报告里。")).toBeTruthy();
    expect(within(featured).getByText("依据 1 条，可交给技术同事复核。")).toBeTruthy();
    expect(within(featured).getByText("先别发布")).toBeTruthy();
    expect(screen.getByText("有 2 个项目需要处理。")).toBeTruthy();
  });

  it("lists the other projects with their own badge, sentence and an action that names them", async () => {
    const onCheck = vi.fn();
    const audit = fakeAudit({
      history: history({
        p1: finishedRun({ id: "run-ready", projectId: "p1" }),
        p2: finishedRun({ id: "run-none", projectId: "p2", engines: [] }),
      }),
    });
    render(<BossOverview {...props({ audit, projects: [alpha, beta, gamma], onCheck })} />);
    await screen.findByRole("heading", { level: 2, name: "这次没有完成检查。" });
    const others = screen.getByRole("region", { name: "其他项目" });
    const rowAlpha = within(others).getByText("alpha").closest("li") as HTMLElement;
    expect(within(rowAlpha).getByText("可以发布。")).toBeTruthy();
    expect(within(rowAlpha).getByText("可以发布")).toBeTruthy();
    const rowGamma = within(others).getByText("gamma").closest("li") as HTMLElement;
    expect(within(rowGamma).getByText("还没有检查过。")).toBeTruthy();
    await userEvent.click(within(rowGamma).getByRole("button", { name: "检查 gamma" }));
    expect(onCheck).toHaveBeenCalledWith(gamma);
    await userEvent.click(within(rowAlpha).getByRole("button", { name: "查看 alpha 的结论" }));
    expect(onCheck).toHaveBeenLastCalledWith(alpha);
  });

  it("查看结论 opens the featured project", async () => {
    const onCheck = vi.fn();
    const audit = fakeAudit({
      history: history({ p1: finishedRun({ id: "run-1", projectId: "p1" }) }),
    });
    render(<BossOverview {...props({ audit, projects: [alpha], onCheck })} />);
    await userEvent.click(await screen.findByRole("button", { name: "查看结论" }));
    expect(onCheck).toHaveBeenCalledWith(alpha);
  });

  it.each([
    ["ready", finishedRun({ id: "r" }), "可以发布。", "可以发布"],
    [
      "review",
      finishedRun({ id: "r", findings: [makeFinding()], notDone: [MODEL_MISSING] }),
      "建议先看看。",
      "建议先看看",
    ],
    ["none", finishedRun({ id: "r", engines: [] }), "这次没有完成检查。", "这次没有完成任何检查"],
  ])("says the %s conclusion in its fixed words", async (_gate, run, sentence, badge) => {
    const audit = fakeAudit({ history: vi.fn(async () => [run]), findings: vi.fn(async () => []) });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    const heading = await screen.findByRole("heading", { level: 2, name: sentence });
    expect(within(heading.closest("section") as HTMLElement).getByText(badge)).toBeTruthy();
  });

  it("a cancelled run is never presented as a clean one", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [
        finishedRun({ id: "r", status: "cancelled", engines: [], completeness: "partial" }),
      ]),
    });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    await screen.findByRole("heading", { level: 2, name: "这次检查已取消。" });
    expect(screen.queryByText("可以发布。")).toBeNull();
    expect(screen.getByText("有 1 个项目需要处理。")).toBeTruthy();
  });

  it("says 已过期 in words and why, only for a stale run", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [finishedRun({ id: "r", stale: true })]),
    });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    await screen.findByText("已过期");
    expect(screen.getByText("检查之后项目有过改动，这份结论可能已经不准。")).toBeTruthy();
  });

  it("a run still going is neither a conclusion nor counted as needing attention", async () => {
    const audit = fakeAudit({ history: vi.fn(async () => [runningRun()]) });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    await screen.findByText("正在检查…");
    expect(screen.queryByRole("button", { name: "转给技术同事" })).toBeNull();
    expect(screen.queryByText("可以发布。")).toBeNull();
    expect(screen.getByRole("button", { name: "查看进度" })).toBeTruthy();
  });
});

describe("BossOverview · history cannot be read", () => {
  it("hides the count, says so, and presents no project as unchecked or fine", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => {
        if (id === "p2") throw new IpcCallError("sidecar_unavailable", "no daemon");
        return [finishedRun({ id: "r1", projectId: id })];
      }),
    });
    render(<BossOverview {...props({ audit, projects: [alpha, beta] })} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("暂时读不到检查记录，项目状态未知。")).toBeTruthy();
    expect(screen.queryByText(/个项目需要处理/)).toBeNull();
    expect(screen.queryByText("已检查的项目里，没有需要处理的。")).toBeNull();
    const row = screen.getByText("beta").closest("li") as HTMLElement;
    expect(within(row).getByText("状态未知")).toBeTruthy();
    expect(within(row).queryByText("还没有检查过。")).toBeNull();
  });

  it("while the history is read again after a failure, the count line and 还没有检查过 stay away", async () => {
    let healthy = false;
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => {
        if (healthy) return new Promise<never>(() => {});
        if (id === "p2") throw new IpcCallError("sidecar_unavailable", "no daemon");
        return [finishedRun({ id: "r1", projectId: id })];
      }),
    });
    const { rerender } = render(<BossOverview {...props({ audit, projects: [alpha, beta] })} />);
    await screen.findByRole("alert");
    healthy = true;
    // A project was added: the list changes and the history is read again, and that read hangs.
    rerender(<BossOverview {...props({ audit, projects: [alpha, beta, gamma] })} />);
    await waitFor(() => expect(audit.history).toHaveBeenCalledTimes(5));
    expect(screen.queryByText(/个项目需要处理/)).toBeNull();
    expect(screen.queryByText("已检查的项目里，没有需要处理的。")).toBeNull();
    expect(screen.queryByText("还没有检查过。")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("when no history could be read at all there is no 还没有检查结论 either", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => {
        throw new IpcCallError("sidecar_unavailable", "no daemon");
      }),
    });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("还没有检查结论")).toBeNull();
    expect(screen.queryByRole("button", { name: "开始检查" })).toBeNull();
  });

  it("lists every project under 全部项目, not 其他项目, when there is no featured card", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => {
        throw new IpcCallError("sidecar_unavailable", "no daemon");
      }),
    });
    render(<BossOverview {...props({ audit, projects: [alpha, beta] })} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "全部项目" })).toBeTruthy();
    expect(screen.queryByText("其他项目")).toBeNull();
  });
});

describe("BossOverview · 转给技术同事", () => {
  const blockedRun = finishedRun({ id: "run-blocked", projectId: "p1", findings: [BLOCKER] });

  it("is disabled with 正在准备… until the findings are loaded, then copies the fixed template", async () => {
    let release: (v: ReturnType<typeof makeFinding>[]) => void = () => {};
    const audit = fakeAudit({
      history: vi.fn(async () => [blockedRun]),
      findings: vi.fn(
        () =>
          new Promise<ReturnType<typeof makeFinding>[]>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<BossOverview {...props({ audit, projects: [makeProject("p1", "客户门户")] })} />);
    const preparing = await screen.findByRole("button", { name: "正在准备…" });
    expect((preparing as HTMLButtonElement).disabled).toBe(true);
    release([BLOCKER]);
    const button = await screen.findByRole("button", { name: "转给技术同事" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(buildHandoff(blockedRun, [BLOCKER])),
    );
    expect(await navigator.clipboard.readText()).not.toContain("客户门户");
    expect(await screen.findByText("已复制，可以粘贴给技术同事或 AI 编程工具。")).toBeTruthy();
  });

  it("without findings to list there is nothing to wait for", async () => {
    const run = finishedRun({ id: "r", projectId: "p1" });
    const audit = fakeAudit({ history: vi.fn(async () => [run]) });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    const button = await screen.findByRole("button", { name: "转给技术同事" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(audit.findings).not.toHaveBeenCalled();
  });

  it("a failed list disables it, says why, and can be retried", async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new IpcCallError("sidecar_unavailable", "no daemon"))
      .mockResolvedValueOnce([BLOCKER]);
    const audit = fakeAudit({ history: vi.fn(async () => [blockedRun]), findings: find });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    expect(await screen.findByText("暂时读不到问题清单，不能转交。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "转给技术同事" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "转给技术同事" })).toBeTruthy();
  });
});

describe("BossOverview · 备查 and the drop zone", () => {
  it("always carries the caveat, and the coverage line of the featured run", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [finishedRun({ id: "r", notDone: [MODEL_MISSING] })]),
    });
    render(<BossOverview {...props({ audit, projects: [alpha] })} />);
    const review = await screen.findByRole("region", { name: "备查" });
    expect(within(review).getByText("基于本次可检测范围，不代表绝对安全。")).toBeTruthy();
    expect(within(review).getByText(/本次检查了 1 项，跳过 0 项，失败 0 项/)).toBeTruthy();
    const toggle = within(review).getByRole("button", { name: "展开" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(review).queryByText("没有做的事")).toBeNull();
    await userEvent.click(toggle);
    expect(within(review).getByText("没有做的事")).toBeTruthy();
    expect(within(review).getByText("读懂项目、生成测试、安全深度分析")).toBeTruthy();
    expect(within(review).queryByText("需要连接 AI 模型")).toBeNull();
    expect(within(review).getByRole("button", { name: "收起" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("keeps the caveat even with no project", () => {
    render(<BossOverview {...props()} />);
    expect(screen.getByText("基于本次可检测范围，不代表绝对安全。")).toBeTruthy();
  });

  it("keeps the folder-open states: busy, dragging, already listed, too many, unavailable, failure", () => {
    const { rerender } = render(<BossOverview {...props({ busy: true })} />);
    expect((screen.getByRole("button", { name: "正在打开…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<BossOverview {...props({ dragging: true })} />);
    expect(screen.getByText("松开鼠标即可添加")).toBeTruthy();
    rerender(<BossOverview {...props({ dragging: true, busy: true })} />);
    expect(screen.getByText("正在打开上一个文件夹，请稍后再拖。")).toBeTruthy();
    rerender(
      <BossOverview
        {...props({
          alreadyListed: true,
          tooMany: true,
          dropUnavailable: true,
          failure: { code: "sidecar_unavailable", detail: "x" },
        })}
      />,
    );
    expect(screen.getByText("这个文件夹已经在列表里了，已挪到最前面。")).toBeTruthy();
    expect(screen.getByText("一次最多添加 20 个文件夹，多出来的没有添加。")).toBeTruthy();
    expect(screen.getByText("拖拽添加暂时不可用，请用上面的按钮选择文件夹。")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
