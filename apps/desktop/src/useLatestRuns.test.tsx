import type { Project } from "@audit/audit-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeAudit, finishedRun } from "./test-support/audit";
import { useLatestRuns } from "./useLatestRuns";

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
const alpha = project("p1", "alpha");
const beta = project("p2", "beta");
const gamma = project("p3", "gamma");

describe("useLatestRuns", () => {
  it("is loading and asks nothing while the project list itself is loading", () => {
    const audit = fakeAudit();
    const { result } = renderHook(() => useLatestRuns(audit, null));
    expect(result.current.loading).toBe(true);
    expect(result.current.rows).toBeNull();
    expect(audit.history).not.toHaveBeenCalled();
  });

  it("asks for the latest single run of each project and sorts newest first", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [
        finishedRun({
          id: `run-${id}`,
          projectId: id,
          finishedAt: id === "p1" ? 1000 : id === "p2" ? 3000 : 2000,
        }),
      ]),
    });
    const projects = [alpha, beta, gamma];
    const { result } = renderHook(() => useLatestRuns(audit, projects));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(result.current.rows?.map((r) => r.project.name)).toEqual(["beta", "gamma", "alpha"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.failure).toBeNull();
    expect(audit.history).toHaveBeenCalledTimes(3);
    expect(audit.history).toHaveBeenCalledWith("p1", 1);
  });

  it("leaves a project without a run out of the rows", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) =>
        id === "p1" ? [finishedRun({ id: "run-p1", projectId: "p1" })] : [],
      ),
    });
    const projects = [alpha, beta];
    const { result } = renderHook(() => useLatestRuns(audit, projects));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(result.current.rows?.map((r) => r.project.name)).toEqual(["alpha"]);
  });

  it("keeps the rows that did load and reports the failure of the one that did not", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => {
        if (id === "p2") throw new Error("boom");
        return [finishedRun({ id: `run-${id}`, projectId: id })];
      }),
    });
    const projects = [alpha, beta];
    const { result } = renderHook(() => useLatestRuns(audit, projects));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(result.current.rows?.map((r) => r.project.name)).toEqual(["alpha"]);
    expect(result.current.failed).toBe(true);
    expect(result.current.failure).not.toBeNull();
    expect(result.current.failure?.detail).toContain("boom");
  });

  it("keeps the earlier failure while a re-read is in flight, and clears it only when the new result lands", async () => {
    let healthy = false;
    const releases: Array<() => void> = [];
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => {
        if (!healthy) {
          if (id === "p2") throw new Error("boom");
          return [finishedRun({ id: `run-${id}`, projectId: id })];
        }
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return [finishedRun({ id: `run-${id}`, projectId: id })];
      }),
    });
    const projects = [alpha, beta];
    const { result } = renderHook(() => useLatestRuns(audit, projects));
    await waitFor(() => expect(result.current.failed).toBe(true));
    healthy = true;
    act(() => result.current.refetch());
    await waitFor(() => expect(audit.history).toHaveBeenCalledTimes(4));
    // The read is in flight: the old failure still stands, so nothing can read as "fine".
    expect(result.current.failed).toBe(true);
    expect(result.current.rows?.map((r) => r.project.name)).toEqual(["alpha"]);
    await act(async () => {
      for (const release of releases) release();
    });
    await waitFor(() => expect(result.current.failed).toBe(false));
    expect(result.current.rows).toHaveLength(2);
  });

  it("does not read while disabled and reads again when it is enabled", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [finishedRun({ id: `run-${id}`, projectId: id })]),
    });
    const projects = [alpha];
    const { result, rerender } = renderHook(
      ({ enabled }) => useLatestRuns(audit, projects, { enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {});
    expect(audit.history).not.toHaveBeenCalled();
    expect(result.current.rows).toBeNull();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(audit.history).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(audit.history).toHaveBeenCalledTimes(2));
  });

  it("refetch reads everything again", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (id: string) => [finishedRun({ id: `run-${id}`, projectId: id })]),
    });
    const projects = [alpha];
    const { result } = renderHook(() => useLatestRuns(audit, projects));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.refetch());
    await waitFor(() => expect(audit.history).toHaveBeenCalledTimes(2));
  });

  it("ignores a reply that arrives after the projects changed", async () => {
    let releaseFirst: (runs: ReturnType<typeof finishedRun>[]) => void = () => {};
    const history = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementation(async (id: string) => [finishedRun({ id: `run-${id}`, projectId: id })]);
    const audit = fakeAudit({ history });
    const { result, rerender } = renderHook(({ list }) => useLatestRuns(audit, list), {
      initialProps: { list: [alpha] },
    });
    rerender({ list: [beta] });
    await waitFor(() => expect(result.current.rows?.map((r) => r.project.name)).toEqual(["beta"]));
    await act(async () => {
      releaseFirst([finishedRun({ id: "run-p1", projectId: "p1" })]);
    });
    expect(result.current.rows?.map((r) => r.project.name)).toEqual(["beta"]);
  });
});
