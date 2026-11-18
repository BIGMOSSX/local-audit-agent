import type { LocalModelService, Project } from "@audit/audit-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "./App";
import type { DropHandlers, DropSource } from "./dragdrop";
import { errorText, t } from "./i18n";
import { IpcCallError, type ModelClient, type ProjectClient } from "./ipc";
import { fakeAudit, finishedRun, makeFinding, runningRun } from "./test-support/audit";

const alpha: Project = {
  id: "p1",
  path: "/work/alpha",
  name: "alpha",
  ecosystems: ["node", "rust"],
  packageManager: "pnpm",
  isMonorepo: false,
  isGitRepo: true,
  addedAt: 1,
  lastOpenedAt: 2,
};
const unicode: Project = {
  ...alpha,
  id: "p2",
  path: "/work/AI软件安全审计项目开发",
  name: "AI软件安全审计项目开发",
  ecosystems: ["python"],
};

function fakeClient(
  initial: Project[] = [],
): ProjectClient & { list: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } {
  let stored = [...initial];
  return {
    list: vi.fn(async () => [...stored]),
    open: vi.fn(async (path: string) => {
      const found = stored.find((p) => p.path === path) ??
        [alpha, unicode].find((p) => p.path === path) ?? {
          ...alpha,
          id: `id:${path}`,
          path,
          name: path.split("/").pop() ?? path,
        };
      stored = [found, ...stored.filter((p) => p.id !== found.id)];
      return found;
    }),
  };
}

function fakeModels(
  services: LocalModelService[] = [],
): ModelClient & { list: ReturnType<typeof vi.fn> } {
  return { list: vi.fn(async () => services) };
}

const pick = (value: string | null) => vi.fn(async () => value);

function fakeDrop() {
  let handlers: DropHandlers | undefined;
  const unsubscribe = vi.fn();
  const source: DropSource = vi.fn(async (h) => {
    handlers = h;
    return unsubscribe;
  });
  return {
    source,
    unsubscribe,
    hover: (on: boolean) => act(() => handlers?.onHover(on)),
    drop: (paths: string[]) => act(async () => handlers?.onDrop(paths)),
  };
}

describe("App", () => {
  it("shows the empty state when there are no projects", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
      />,
    );
    expect(await screen.findByText(/还没有项目/)).toBeTruthy();
  });

  it("lists remembered projects with name, path and ecosystems", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([alpha, unicode])}
        pickFolder={pick(null)}
      />,
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("/work/alpha")).toBeTruthy();
    expect(screen.getByText(/node · rust/)).toBeTruthy();
    expect(screen.getByText("AI软件安全审计项目开发")).toBeTruthy();
  });

  it("picking a folder opens it and the list refreshes", async () => {
    const client = fakeClient();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/AI软件安全审计项目开发")}
      />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(await screen.findByText("AI软件安全审计项目开发")).toBeTruthy();
    expect(client.open).toHaveBeenCalledWith("/work/AI软件安全审计项目开发");
    expect(screen.queryByText(/还没有项目/)).toBeNull();
  });

  it("cancelling the folder dialog does nothing", async () => {
    const client = fakeClient();
    render(
      <App audit={fakeAudit()} models={fakeModels()} client={client} pickFolder={pick(null)} />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(client.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed open shows the localised message plus the service detail, and keeps the list", async () => {
    const client = fakeClient([alpha]);
    client.open.mockRejectedValueOnce(
      new IpcCallError("invalid_path", "Not a directory: /tmp/file.txt"),
    );
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/tmp/file.txt")}
      />,
    );
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(errorText("invalid_path"));
    expect(alert.textContent).toContain("Not a directory: /tmp/file.txt");
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("a failed initial load shows the localised message", async () => {
    const client = fakeClient();
    client.list.mockRejectedValueOnce(new IpcCallError("sidecar_unavailable", "spawn ENOENT"));
    render(
      <App audit={fakeAudit()} models={fakeModels()} client={client} pickFolder={pick(null)} />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(errorText("sidecar_unavailable"));
  });

  it("a folder-dialog failure is reported, not thrown", async () => {
    const failing = vi.fn(async () => {
      throw new Error("dialog exploded");
    });
    render(
      <App audit={fakeAudit()} models={fakeModels()} client={fakeClient()} pickFolder={failing} />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect((await screen.findByRole("alert")).textContent).toContain(errorText("internal"));
  });

  it("a successful action clears an earlier error", async () => {
    const client = fakeClient();
    client.open.mockRejectedValueOnce(new IpcCallError("invalid_path", "nope"));
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/alpha")}
      />,
    );
    await screen.findByText(/还没有项目/);
    const button = screen.getByRole("button", { name: "选择项目文件夹" });
    await userEvent.click(button);
    await screen.findByRole("alert");
    await userEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("alpha")).toBeTruthy();
  });

  it("disables the button while an open is in flight, so a double click cannot open twice", async () => {
    let release: (p: Project) => void = () => {};
    const client = fakeClient();
    client.open.mockImplementationOnce(
      () =>
        new Promise<Project>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/alpha")}
      />,
    );
    await screen.findByText(/还没有项目/);
    const button = screen.getByRole("button", { name: "选择项目文件夹" });
    await userEvent.click(button);
    await waitFor(() => expect(client.open).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /正在打开/ }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /正在打开/ }));
    expect(client.open).toHaveBeenCalledTimes(1);
    release(alpha);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "选择项目文件夹" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });

  it("an already listed folder shows a notice, keeps one row and moves it to the top", async () => {
    const client = fakeClient([unicode, alpha]);
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/alpha")}
      />,
    );
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect((await screen.findByRole("status")).textContent).toContain(t("home.alreadyListed"));
    expect(screen.getAllByText("alpha")).toHaveLength(1);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("alpha");
  });

  it("a new folder shows no already-listed notice", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([alpha])}
        pickFolder={pick("/work/brand-new")}
      />,
    );
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    await screen.findByText("brand-new");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the notice goes away on the next action", async () => {
    const picker = vi
      .fn()
      .mockResolvedValueOnce("/work/alpha")
      .mockResolvedValueOnce("/work/other");
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([alpha])}
        pickFolder={picker}
      />,
    );
    await screen.findByText("alpha");
    const button = screen.getByRole("button", { name: "选择项目文件夹" });
    await userEvent.click(button);
    await screen.findByRole("status");
    await userEvent.click(button);
    await screen.findByText("other");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("dropping folders opens each of them", async () => {
    const drop = fakeDrop();
    const client = fakeClient();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await drop.drop(["/work/alpha", "/work/AI软件安全审计项目开发"]);
    expect(await screen.findByText("AI软件安全审计项目开发")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(client.open.mock.calls.map((c) => c[0])).toEqual([
      "/work/alpha",
      "/work/AI软件安全审计项目开发",
    ]);
  });

  it("a dropped path that is not a folder is reported and the list stays", async () => {
    const drop = fakeDrop();
    const client = fakeClient([alpha]);
    client.open.mockRejectedValueOnce(
      new IpcCallError("invalid_path", "Not a directory: /tmp/a.txt"),
    );
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText("alpha");
    await drop.drop(["/tmp/a.txt"]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(errorText("invalid_path"));
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("dragging over the window highlights the drop area, leaving restores it", async () => {
    const drop = fakeDrop();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    expect(screen.getByText(t("home.dropHint"))).toBeTruthy();
    await drop.hover(true);
    expect(screen.getByText(t("home.dropActive"))).toBeTruthy();
    await drop.hover(false);
    expect(screen.getByText(t("home.dropHint"))).toBeTruthy();
  });

  it("if drag and drop cannot start, the user is told and the button still works", async () => {
    const source: DropSource = vi.fn(async () => {
      throw new Error("not allowed");
    });
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick("/work/alpha")}
        dropSource={source}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toContain(t("home.dropUnavailable"));
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(await screen.findByText("alpha")).toBeTruthy();
  });

  it("unsubscribes from the drop source when the app unmounts", async () => {
    const drop = fakeDrop();
    const { unmount } = render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await waitFor(() => expect(drop.source).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(drop.unsubscribe).toHaveBeenCalled());
  });
  it("shows the three sections; 项目 is current, 报告 and 设置 are honest empty pages", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([alpha])}
        pickFolder={pick(null)}
      />,
    );
    await screen.findByText("alpha");
    const nav = screen.getByRole("navigation", { name: t("nav.label") });
    const labels = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["项目", "报告", "设置"]);
    expect(screen.getByRole("button", { name: "项目" }).getAttribute("aria-current")).toBe("page");

    await userEvent.click(screen.getByRole("button", { name: "报告" }));
    expect(screen.getByText(t("reports.empty"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "报告" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { name: t("settings.models.title") })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("the first screen has one primary action and the privacy sentence", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
      />,
    );
    await screen.findByText(/还没有项目/);
    expect(screen.getAllByRole("button", { name: "选择项目文件夹" })).toHaveLength(1);
    expect(screen.getByText(t("home.privacy"))).toBeTruthy();
  });

  it("a project with no recognised type says so in words, not a dash", async () => {
    const plain: Project = {
      ...alpha,
      id: "p3",
      path: "/work/plain",
      name: "plain",
      ecosystems: [],
    };
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([plain])}
        pickFolder={pick(null)}
      />,
    );
    expect(await screen.findByText(t("home.noEcosystem"))).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("dropping while on another section brings the user back to the project list", async () => {
    const drop = fakeDrop();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "报告" }));
    await drop.drop(["/work/alpha"]);
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByRole("button", { name: "项目" }).getAttribute("aria-current")).toBe("page");
  });

  it("long and Unicode paths are rendered in full with the full path as tooltip", async () => {
    const longPath = `/Users/某某/Documents/${"很长的文件夹名 (副本)/".repeat(8)}项目`;
    const long: Project = { ...alpha, id: "p4", path: longPath, name: "项目" };
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([long])}
        pickFolder={pick(null)}
      />,
    );
    const node = await screen.findByText(longPath);
    expect(node.getAttribute("title")).toBe(longPath);
    expect(node.className).toContain("break-all");
  });
  it("a drop during an open in flight is not promised: the hint says wait, nothing is opened twice", async () => {
    const drop = fakeDrop();
    let release: (p: Project) => void = () => {};
    const client = fakeClient();
    client.open.mockImplementationOnce(
      () =>
        new Promise<Project>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/alpha")}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledTimes(1));
    await drop.hover(true);
    expect(screen.getByText(t("home.dropBusy"))).toBeTruthy();
    expect(screen.queryByText(t("home.dropActive"))).toBeNull();
    await drop.drop(["/work/other"]);
    expect(client.open).toHaveBeenCalledTimes(1);
    release(alpha);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "选择项目文件夹" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });

  it("a drop that is ignored because the app is busy does not switch the section", async () => {
    const drop = fakeDrop();
    let release: (p: Project) => void = () => {};
    const client = fakeClient();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={client}
        pickFolder={pick("/work/alpha")}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "报告" }));
    client.open.mockImplementationOnce(
      () =>
        new Promise<Project>((resolve) => {
          release = resolve;
        }),
    );
    await drop.drop(["/work/alpha"]);
    await waitFor(() => expect(client.open).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "报告" }));
    await drop.drop(["/work/other"]);
    expect(client.open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "报告" }).getAttribute("aria-current")).toBe("page");
    release(alpha);
  });

  it("a huge drop tells the user only the first folders were added", async () => {
    const drop = fakeDrop();
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
        dropSource={drop.source}
      />,
    );
    await screen.findByText(/还没有项目/);
    await drop.drop(Array.from({ length: 25 }, (_, i) => `/work/p${i}`));
    expect((await screen.findByRole("status")).textContent).toContain(t("home.tooMany"));
  });

  it("a long project name can wrap", async () => {
    const name = "a".repeat(120);
    const long: Project = { ...alpha, id: "p5", path: `/work/${name}`, name };
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient([long])}
        pickFolder={pick(null)}
      />,
    );
    const node = await screen.findByText(name);
    expect(node.className).toContain("break-words");
  });

  it("the home screen says plainly that only the basic check is available", async () => {
    render(
      <App
        audit={fakeAudit()}
        models={fakeModels()}
        client={fakeClient()}
        pickFolder={pick(null)}
      />,
    );
    await screen.findByText(/还没有项目/);
    expect(screen.getByText(t("home.modelStatus"))).toBeTruthy();
    expect(t("home.modelStatus")).toMatch(/基础检查/);
  });
});

describe("设置 — local models", () => {
  const open = async (models: ReturnType<typeof fakeModels>) => {
    render(
      <App audit={fakeAudit()} models={models} client={fakeClient()} pickFolder={pick(null)} />,
    );
    await screen.findByText(/还没有项目/);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
  };

  it("does not look until 设置 is opened, then looks once", async () => {
    const models = fakeModels();
    render(
      <App audit={fakeAudit()} models={models} client={fakeClient()} pickFolder={pick(null)} />,
    );
    await screen.findByText(/还没有项目/);
    expect(models.list).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByText(t("settings.models.none"));
    expect(models.list).toHaveBeenCalledTimes(1);
  });

  it("lists each service by port with its model names as plain text", async () => {
    const models = fakeModels([
      { port: 4321, models: ["alpha-7b", "<img src=x onerror=alert(1)>"] },
      { port: 5555, models: ["beta"] },
    ]);
    await open(models);
    expect(await screen.findByText(/端口 4321/)).toBeTruthy();
    expect(screen.getByText(/端口 5555/)).toBeTruthy();
    expect(screen.getByText("alpha-7b")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("says that a found model is not used and that detection sends nothing", async () => {
    await open(fakeModels([{ port: 4321, models: ["alpha-7b"] }]));
    await screen.findByText(/端口 4321/);
    expect(screen.getByText(t("settings.models.status"))).toBeTruthy();
    expect(screen.getByText(t("settings.models.notUsed"))).toBeTruthy();
    expect(screen.getByText(t("settings.models.privacy"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: /使用/ })).toBeNull();
  });

  it("finding nothing is a normal answer, not an error", async () => {
    await open(fakeModels());
    expect(await screen.findByText(t("settings.models.none"))).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed detection shows the failure card and the page still works", async () => {
    const models = fakeModels();
    models.list.mockRejectedValueOnce(new IpcCallError("sidecar_unavailable", "gone"));
    await open(models);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(errorText("sidecar_unavailable"));
    expect(screen.getByRole("button", { name: t("settings.models.redetect") })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(screen.getByText(/还没有项目/)).toBeTruthy();
  });

  it("re-detect probes again, and a click while one probe is running is ignored", async () => {
    const models = fakeModels();
    let release: (value: LocalModelService[]) => void = () => {};
    models.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await open(models);
    const button = await screen.findByRole("button", { name: t("settings.models.detecting") });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    // react-aria arms an 80 ms fallback click on pointerup even on a disabled button. Let it fire now,
    // while the button is still disabled (a no-op); on a slow machine it would otherwise land on the
    // re-enabled button and start a probe of its own.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(models.list).toHaveBeenCalledTimes(1);
    await act(async () => release([{ port: 4321, models: ["m"] }]));
    await screen.findByText(/端口 4321/);
    models.list.mockResolvedValueOnce([{ port: 5555, models: ["n"] }]);
    await userEvent.click(screen.getByRole("button", { name: t("settings.models.redetect") }));
    await screen.findByText(/端口 5555/);
    expect(screen.queryByText(/端口 4321/)).toBeNull();
    expect(models.list).toHaveBeenCalledTimes(2);
  });

  it("an answer that arrives after leaving 设置 does not break the page the user is on", async () => {
    const models = fakeModels();
    let release: (value: LocalModelService[]) => void = () => {};
    models.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await open(models);
    await userEvent.click(screen.getByRole("button", { name: "项目" }));
    await act(async () => release([{ port: 4321, models: ["m"] }]));
    expect(screen.queryByText(/端口 4321/)).toBeNull();
  });
});

describe("App · 检查", () => {
  const checkButton = (name: string) =>
    screen.getByRole("button", { name: t("home.checkLabel", { name }) });

  function mount(audit: ReturnType<typeof fakeAudit>, projects: Project[] = [alpha]) {
    render(
      <App
        audit={audit}
        models={fakeModels()}
        client={fakeClient(projects)}
        pickFolder={pick(null)}
      />,
    );
  }

  it("each project row has 检查, and a double click starts exactly one run", async () => {
    const audit = fakeAudit();
    mount(audit, [alpha, unicode]);
    await screen.findByText("alpha");
    expect(screen.getAllByRole("button", { name: /^检查 / })).toHaveLength(2);
    await userEvent.click(checkButton("alpha"));
    const start = await screen.findByRole("button", { name: t("audit.start") });
    await userEvent.dblClick(start);
    await screen.findByText(t("run.cancel"));
    expect(audit.run).toHaveBeenCalledTimes(1);
    expect(audit.run).toHaveBeenCalledWith("p1");
  });

  it("opens straight into the running view when the project's run is already running", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [
        runningRun({ stage: "checking", progress: { engine: "quality", done: 2, total: 5 } }),
      ]),
    });
    mount(audit);
    await screen.findByText("alpha");
    await userEvent.click(checkButton("alpha"));
    expect(await screen.findByText("已完成 2 / 5 项")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("audit.start") })).toBeNull();
    expect(audit.run).not.toHaveBeenCalled();
  });

  it("follows a run from reading to a blocked result with a card and a copyable prompt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const finding = makeFinding({
        severity: "critical",
        category: "secret",
        title: "密钥写在了代码里",
        file: "src/config.ts",
        line: 7,
      });
      const done = finishedRun({ findings: [finding] });
      const history = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([runningRun({ stage: "reading" })])
        .mockResolvedValueOnce([
          runningRun({ stage: "checking", progress: { engine: "quality", done: 2, total: 5 } }),
        ])
        .mockResolvedValue([done]);
      const audit = fakeAudit({ history, findings: vi.fn(async () => [finding]) });
      mount(audit);
      await screen.findByText("alpha");
      await user.click(checkButton("alpha"));
      await user.click(await screen.findByRole("button", { name: t("audit.start") }));
      await screen.findByText(t("run.cancel"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(await screen.findByText("已完成 2 / 5 项")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(await screen.findByText("密钥写在了代码里")).toBeTruthy();
      expect(screen.getAllByText(t("gate.blocked")).length).toBeGreaterThan(0);
      expect(screen.queryByText(t("run.cancel"))).toBeNull();
      await user.click(screen.getByRole("button", { name: t("card.copy") }));
      const copied = await navigator.clipboard.readText();
      expect(copied).toContain("位置：src/config.ts:7");
      expect(copied).not.toContain("密钥写在了代码里");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows what the real daemon produces today as 'nothing was checked'", async () => {
    const run = finishedRun({
      notDone: [
        { what: "quality: 引擎未能运行", reason: "分析引擎尚未安装" },
        { what: "检查", reason: "没有任何检查实际运行" },
        { what: "读懂项目、生成测试、安全深度分析", reason: "需要连接 AI 模型" },
      ],
      engines: [{ id: "quality", applicable: true, tasks: [] }],
    });
    const audit = fakeAudit({ history: vi.fn(async () => [run]) });
    mount(audit);
    await screen.findByText("alpha");
    await userEvent.click(checkButton("alpha"));
    expect((await screen.findAllByText(/没有完成任何检查/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/0 个问题|可以发布|%/);
    expect(screen.getByText("引擎未能运行：分析引擎尚未安装")).toBeTruthy();
  });

  it("a busy daemon is reported as text and the start button comes back", async () => {
    const audit = fakeAudit({
      run: vi.fn(async () => {
        throw new IpcCallError("busy", "Another audit is already running.");
      }),
    });
    mount(audit);
    await screen.findByText("alpha");
    await userEvent.click(checkButton("alpha"));
    await userEvent.click(await screen.findByRole("button", { name: t("audit.start") }));
    expect((await screen.findByRole("alert")).textContent).toContain(errorText("busy"));
    expect(screen.getByRole("button", { name: t("audit.start") })).toBeTruthy();
  });

  it("a poll that fails stops polling and offers a retry instead of spinning", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const history = vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockRejectedValueOnce(new IpcCallError("sidecar_io", "gone"))
        .mockResolvedValue([finishedRun()]);
      mount(fakeAudit({ history }));
      await screen.findByText("alpha");
      await user.click(checkButton("alpha"));
      await screen.findByText(t("run.cancel"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect((await screen.findByRole("alert")).textContent).toContain(errorText("sidecar_io"));
      expect(vi.getTimerCount()).toBe(0);
      await user.click(screen.getByRole("button", { name: t("audit.retry") }));
      expect((await screen.findAllByText(/没有完成任何检查|可以发布/)).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switching to another page and back while running leaves no timer behind", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const audit = fakeAudit({ history: vi.fn(async () => [runningRun()]) });
      mount(audit);
      await screen.findByText("alpha");
      await user.click(checkButton("alpha"));
      await screen.findByText(t("run.cancel"));
      await user.click(screen.getByRole("button", { name: t("nav.settings") }));
      await screen.findByText(t("settings.models.title"));
      expect(vi.getTimerCount()).toBe(0);
      await user.click(screen.getByRole("button", { name: t("nav.projects") }));
      await screen.findByText(t("run.cancel"));
      expect(audit.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("报告 lists the newest run of each project with its gate and opens it", async () => {
    const blocked = finishedRun({
      projectId: "p1",
      findings: [makeFinding({ severity: "critical", title: "一个必须先处理的问题" })],
    });
    const audit = fakeAudit({
      history: vi.fn(async (projectId: string) => (projectId === "p1" ? [blocked] : [])),
      findings: vi.fn(async () => [
        makeFinding({ severity: "critical", title: "一个必须先处理的问题" }),
      ]),
    });
    mount(audit, [alpha, unicode]);
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: t("nav.reports") }));
    expect(await screen.findByText(t("gate.blocked"))).toBeTruthy();
    expect(screen.queryByText("AI软件安全审计项目开发")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: t("reports.openLabel", { name: "alpha" }) }),
    );
    expect(await screen.findByText("一个必须先处理的问题")).toBeTruthy();
    expect(audit.run).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: t("audit.back") }));
    expect(await screen.findByText(t("gate.blocked"))).toBeTruthy();
  });

  it("报告 shows the newer run after 重新检查 from an opened run and going back", async () => {
    const blocked = finishedRun({
      id: "old",
      projectId: "p1",
      findings: [makeFinding({ severity: "critical", title: "旧的问题" })],
    });
    let runs = [blocked];
    const audit = fakeAudit({
      history: vi.fn(async (_id: string, limit?: number) => runs.slice(0, limit ?? 50)),
      run: vi.fn(async () => {
        const started = runningRun({ id: "new", projectId: "p1" });
        runs = [started, blocked];
        return started;
      }),
      findings: vi.fn(async () => [makeFinding({ severity: "critical", title: "旧的问题" })]),
    });
    mount(audit);
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: t("nav.reports") }));
    expect(await screen.findByText(t("gate.blocked"))).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: t("reports.openLabel", { name: "alpha" }) }),
    );
    await userEvent.click(await screen.findByRole("button", { name: t("audit.recheck") }));
    await screen.findByText(t("run.cancel"));
    await userEvent.click(screen.getByRole("button", { name: t("audit.back") }));
    await waitFor(() => expect(screen.queryByText(t("gate.blocked"))).toBeNull());
    expect(screen.getAllByText(t("reports.running")).length).toBeGreaterThan(0);
  });

  it("报告 keeps the empty message when no project has a run", async () => {
    mount(fakeAudit(), [alpha]);
    await screen.findByText("alpha");
    await userEvent.click(screen.getByRole("button", { name: t("nav.reports") }));
    expect(await screen.findByText(t("reports.empty"))).toBeTruthy();
  });
});

describe("App · 界面版本", () => {
  const html = document.documentElement;
  const nav = () => screen.getByRole("navigation", { name: t("nav.label") });
  const navLabels = () => Array.from(nav().querySelectorAll("button")).map((b) => b.textContent);

  function mount(over: Partial<AppProps> = {}) {
    const client = fakeClient([alpha]);
    const audit = fakeAudit();
    const models = fakeModels();
    render(
      <App
        audit={audit}
        models={models}
        client={client}
        pickFolder={pick(null)}
        prefersDark={() => false}
        {...over}
      />,
    );
    return { client, audit, models };
  }

  beforeEach(() => {
    window.localStorage.clear();
    delete html.dataset.edition;
    html.classList.remove("dark");
  });
  afterEach(() => window.localStorage.clear());

  it("starts as 小白版: three labels, data-edition easy, no 老板版 chrome", async () => {
    mount();
    await screen.findByText("alpha");
    expect(navLabels()).toEqual(["项目", "报告", "设置"]);
    expect(html.dataset.edition).toBe("easy");
    expect(within(nav()).queryByText(t("boss.nav.edition"))).toBeNull();
    expect(within(nav()).queryByText(t("boss.nav.local"))).toBeNull();
  });

  it("switching in 设置 changes the nav labels and data-edition at once", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("alpha");
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    expect(navLabels()).toEqual(["总览", "报告", "设置"]);
    expect(html.dataset.edition).toBe("boss");
    expect(html.classList.contains("dark")).toBe(true);
    expect(within(nav()).getByText(t("boss.nav.edition"))).toBeTruthy();
    expect(within(nav()).getByText(t("boss.nav.local"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置" }).getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("radio", { name: t("settings.edition.easy.name") }));
    expect(navLabels()).toEqual(["项目", "报告", "设置"]);
    expect(html.dataset.edition).toBe("easy");
  });

  it("a stored 老板版 is applied on first render", async () => {
    window.localStorage.setItem("audit.edition", "boss");
    mount();
    await screen.findByText("alpha");
    expect(navLabels()).toEqual(["总览", "报告", "设置"]);
    expect(html.dataset.edition).toBe("boss");
  });

  it("a denied entitlement keeps 小白版 and says why, without an upsell", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("audit.edition", "boss");
    mount({ entitlement: { allows: (e) => e !== "boss" } });
    await screen.findByText("alpha");
    expect(navLabels()).toEqual(["项目", "报告", "设置"]);
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(
      (screen.getByRole("radio", { name: t("settings.edition.boss.name") }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(t("settings.edition.denied"))).toBeTruthy();
  });

  it("the sidebar status never says an AI is connected", async () => {
    window.localStorage.setItem("audit.edition", "boss");
    mount();
    await screen.findByText("alpha");
    expect(nav().textContent).toContain(t("boss.nav.status"));
    expect(nav().textContent).not.toMatch(/已连接/);
  });

  it("the edition changes presentation only: same projects, no extra daemon calls", async () => {
    const user = userEvent.setup();
    const { client, audit, models } = mount();
    await screen.findByText("alpha");
    await user.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByText(t("settings.models.none"));
    const before = {
      list: client.list.mock.calls.length,
      open: client.open.mock.calls.length,
      history: audit.history.mock.calls.length,
      run: audit.run.mock.calls.length,
      models: models.list.mock.calls.length,
    };
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.easy.name") }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    expect({
      list: client.list.mock.calls.length,
      open: client.open.mock.calls.length,
      history: audit.history.mock.calls.length,
      run: audit.run.mock.calls.length,
      models: models.list.mock.calls.length,
    }).toEqual(before);
    await user.click(screen.getByRole("button", { name: "总览" }));
    expect(await screen.findByText("alpha")).toBeTruthy();
  });

  it("an open project's start panel is still there after switching edition in 设置", async () => {
    const user = userEvent.setup();
    const { audit } = mount();
    await screen.findByText("alpha");
    await user.click(screen.getByRole("button", { name: t("home.checkLabel", { name: "alpha" }) }));
    await screen.findByRole("button", { name: t("audit.start") });
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    await user.click(screen.getByRole("button", { name: "总览" }));
    expect(await screen.findByRole("button", { name: t("audit.start") })).toBeTruthy();
    expect(audit.run).not.toHaveBeenCalled();
  });
});

describe("App · 老板版总览与报告", () => {
  const html = document.documentElement;

  function mount(over: Partial<AppProps> = {}, projects: Project[] = [alpha]) {
    window.localStorage.setItem("audit.edition", "boss");
    const audit =
      (over.audit as ReturnType<typeof fakeAudit> | undefined) ??
      fakeAudit({
        history: vi.fn(async (id: string) =>
          id === "p1" ? [finishedRun({ id: "run-1", projectId: "p1" })] : [],
        ),
      });
    render(
      <App
        audit={audit}
        models={fakeModels()}
        client={fakeClient(projects)}
        pickFolder={pick(null)}
        prefersDark={() => false}
        {...over}
      />,
    );
    return audit;
  }

  beforeEach(() => {
    window.localStorage.clear();
    delete html.dataset.edition;
    html.classList.remove("dark");
  });
  afterEach(() => window.localStorage.clear());

  it("shows the 老板版 overview instead of the project list", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { level: 2, name: t("boss.conclusion.ready") }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: t("home.checkLabel", { name: "alpha" }) }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: t("boss.overview.view") })).toBeTruthy();
  });

  it("查看结论 opens the report sheet and 返回总览 comes back", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: t("boss.overview.view") }));
    expect(await screen.findByRole("heading", { level: 1, name: "安心报告" })).toBeTruthy();
    expect(document.querySelector("[data-report]")?.textContent).toContain("alpha");
    await user.click(screen.getByRole("button", { name: t("boss.report.back") }));
    expect(await screen.findByRole("button", { name: t("boss.overview.view") })).toBeTruthy();
  });

  it("重新检查 on the report starts exactly one new run", async () => {
    const user = userEvent.setup();
    const audit = mount();
    await user.click(await screen.findByRole("button", { name: t("boss.overview.view") }));
    await user.click(await screen.findByRole("button", { name: t("audit.recheck") }));
    expect(await screen.findByText(t("run.cancel"))).toBeTruthy();
    expect(audit.run).toHaveBeenCalledTimes(1);
    expect(audit.run).toHaveBeenCalledWith("p1");
  });

  it("keeps the pick button, the drop hint and an open failure on the overview", async () => {
    const user = userEvent.setup();
    const picker = vi.fn(async () => "/work/new");
    const client = fakeClient([alpha]);
    client.open.mockRejectedValueOnce(new IpcCallError("internal", "boom"));
    mount({ client, pickFolder: picker });
    await screen.findByRole("button", { name: t("boss.overview.view") });
    expect(screen.getByText(t("home.dropHint"))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t("home.pick") }));
    expect(picker).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(errorText("internal"))).toBeTruthy();
  });

  it("with no project it offers to pick one", async () => {
    mount({}, []);
    expect(await screen.findByText(t("boss.overview.empty.title"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("home.pick") })).toBeTruthy();
  });

  it("switching edition while a finished report is open shows the same run in the other presentation", async () => {
    const user = userEvent.setup();
    const blocker = makeFinding({
      title: "固定标题-ABC",
      severity: "critical",
      confidence: "high",
      category: "secret",
      file: "src/config.ts",
      line: 7,
    });
    const run = finishedRun({
      id: "run-9f8e7d6c",
      projectId: "p1",
      findings: [blocker],
      fingerprint: "0a1b2c3d",
    });
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => (id === "p1" ? [run] : [])),
      findings: vi.fn(async () => [blocker]),
    });
    mount({ audit });
    await user.click(await screen.findByRole("button", { name: t("boss.overview.view") }));
    const sheetNumber = /^LA-\d{8}-RUN9F8E7$/;
    expect(await screen.findByText(sheetNumber)).toBeTruthy();
    expect(screen.getByText(/有 1 项问题必须先处理/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.easy.name") }));
    await user.click(screen.getByRole("button", { name: "项目" }));

    // The same run, in the 小白版 presentation: the same finding, the same counts.
    expect(await screen.findByText("固定标题-ABC")).toBeTruthy();
    expect(document.querySelector("[data-report]")).toBeNull();
    expect(screen.queryByText(sheetNumber)).toBeNull();
    expect(
      screen.getByText(t("result.checked", { checked: 1, skipped: 0, failed: 0 })),
    ).toBeTruthy();

    // Going back the other way renders the sheet from the very same data.
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.boss.name") }));
    await user.click(screen.getByRole("button", { name: "总览" }));
    expect(await screen.findByText(sheetNumber)).toBeTruthy();
    expect(screen.getByText(/有 1 项问题必须先处理/)).toBeTruthy();

    // Only reads of the same project and the same run; nothing started, nothing cancelled.
    expect(audit.run).not.toHaveBeenCalled();
    expect(audit.cancel).not.toHaveBeenCalled();
    for (const call of audit.history.mock.calls) expect(call[0]).toBe("p1");
    for (const call of audit.findings.mock.calls) expect(call[0]).toBe("run-9f8e7d6c");
  });

  it("switching to 小白版 shows the project list again", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("button", { name: t("boss.overview.view") });
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: t("settings.edition.easy.name") }));
    await user.click(screen.getByRole("button", { name: "项目" }));
    expect(
      await screen.findByRole("button", { name: t("home.checkLabel", { name: "alpha" }) }),
    ).toBeTruthy();
  });
});
