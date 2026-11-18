import type { Project } from "@audit/audit-core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportsView } from "./ReportsView";
import { fakeAudit, finishedRun } from "./test-support/audit";

const project = (id: string, name: string): Project => ({
  id,
  name,
  path: `/tmp/${name}`,
  ecosystems: [],
  packageManager: null,
  isMonorepo: false,
  isGitRepo: false,
  addedAt: 1,
  lastOpenedAt: 1,
});
const projects = [project("p1", "alpha"), project("p2", "beta")];

describe("ReportsView", () => {
  it("marks a row 已过期 in words when its run is stale, and only then", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [
        finishedRun({
          id: `run-${id}`,
          projectId: id,
          stale: id === "p1" ? true : id === "p2" ? false : null,
        }),
      ]),
    });
    render(<ReportsView audit={audit} projects={projects} />);
    const alpha = (await screen.findByText("alpha")).closest("li") as HTMLElement;
    const beta = screen.getByText("beta").closest("li") as HTMLElement;
    expect(within(alpha).getByText("已过期")).toBeTruthy();
    expect(within(beta).queryByText("已过期")).toBeNull();
  });

  it("shows nothing for an unknown staleness", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [finishedRun({ id: `run-${id}`, projectId: id })]),
    });
    render(<ReportsView audit={audit} projects={projects.slice(0, 1)} />);
    await screen.findByText("alpha");
    expect(screen.queryByText("已过期")).toBeNull();
  });

  it("a cancelled row says cancelled, not 没有完成任何检查", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [
        finishedRun({ id: `run-${id}`, projectId: id, status: "cancelled", engines: [] }),
      ]),
    });
    render(<ReportsView audit={audit} projects={projects.slice(0, 1)} />);
    await screen.findByText("alpha");
    expect(screen.getByText("这次检查已取消，没有得出结论")).toBeTruthy();
    expect(screen.queryByText("这次没有完成任何检查")).toBeNull();
  });
});
