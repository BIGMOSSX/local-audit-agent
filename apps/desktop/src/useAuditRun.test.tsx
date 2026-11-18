import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcCallError } from "./ipc";
import {
  fakeAudit,
  finishedRun,
  MODEL_MISSING,
  makeFinding,
  runningRun,
} from "./test-support/audit";
import { useAuditRun } from "./useAuditRun";

const tick = async (ms = 1000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAuditRun", () => {
  it("is idle when the project has no run yet", async () => {
    const audit = fakeAudit();
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    expect(result.current.phase).toBe("loading");
    await tick(0);
    expect(result.current.phase).toBe("idle");
    expect(audit.history).toHaveBeenCalledWith("p1", 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes a run that is already running, polls once a second and loads findings once when it finishes", async () => {
    const found = [makeFinding()];
    const done = finishedRun({ findings: found, notDone: [MODEL_MISSING] });
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun({ stage: "reading" })])
        .mockResolvedValueOnce([
          runningRun({ stage: "checking", progress: { engine: "quality", done: 1, total: 4 } }),
        ])
        .mockResolvedValue([done]),
      findings: vi.fn(async () => found),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(result.current.phase).toBe("running");
    expect(result.current.run?.stage).toBe("reading");
    expect(audit.history).toHaveBeenCalledTimes(1);
    await tick(1000);
    expect(audit.history).toHaveBeenCalledTimes(2);
    expect(result.current.run?.progress).toEqual({ engine: "quality", done: 1, total: 4 });
    await tick(1000);
    expect(result.current.phase).toBe("finished");
    expect(result.current.findings).toEqual(found);
    expect(audit.findings).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the newest finished run without starting anything", async () => {
    const audit = fakeAudit({ history: vi.fn(async () => [finishedRun()]) });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(result.current.phase).toBe("finished");
    expect(audit.run).not.toHaveBeenCalled();
    expect(result.current.findings).toEqual([]);
    expect(audit.findings).not.toHaveBeenCalled();
  });

  it("can open a specific older run by id", async () => {
    const older = finishedRun({ id: "old" });
    const audit = fakeAudit({
      history: vi.fn(async () => [finishedRun({ id: "new" }), older]),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1", "old"));
    await tick(0);
    expect(audit.history).toHaveBeenCalledWith("p1", 50);
    expect(result.current.run?.id).toBe("old");
  });

  it("start() twice in one tick sends one run request", async () => {
    let release: (r: ReturnType<typeof runningRun>) => void = () => {};
    const audit = fakeAudit({
      run: vi.fn(
        () =>
          new Promise<ReturnType<typeof runningRun>>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    act(() => {
      void result.current.start();
      void result.current.start();
    });
    expect(result.current.phase).toBe("starting");
    expect(audit.run).toHaveBeenCalledTimes(1);
    await act(async () => release(runningRun()));
    expect(result.current.phase).toBe("running");
    act(() => {
      void result.current.start();
    });
    expect(audit.run).toHaveBeenCalledTimes(1);
  });

  it("a busy reply is reported and the hook returns to idle", async () => {
    const audit = fakeAudit({
      run: vi.fn(async () => {
        throw new IpcCallError("busy", "Another audit is already running.");
      }),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.failure?.code).toBe("busy");
  });

  it("a failed poll stops polling and refresh() resumes it", async () => {
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockRejectedValueOnce(new IpcCallError("sidecar_io", "gone"))
        .mockResolvedValue([finishedRun()]),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await tick(1000);
    expect(result.current.failure?.code).toBe("sidecar_io");
    expect(vi.getTimerCount()).toBe(0);
    await tick(5000);
    expect(audit.history).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.failure).toBeNull();
    expect(result.current.phase).toBe("finished");
  });

  it("cancel() shows cancelling until the run is finished", async () => {
    const cancelled = finishedRun({
      status: "cancelled",
      notDone: [{ what: "审计", reason: "已取消，结果不完整" }],
    });
    const audit = fakeAudit({
      history: vi.fn(async () => [runningRun()]),
      cancel: vi.fn(async () => cancelled),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      await result.current.cancel();
    });
    expect(audit.cancel).toHaveBeenCalledWith("run-1");
    expect(result.current.phase).toBe("finished");
    expect(result.current.run?.status).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel that is not finished yet keeps the cancelling state and keeps polling", async () => {
    const audit = fakeAudit({
      history: vi.fn().mockResolvedValueOnce([runningRun()]).mockResolvedValue([runningRun()]),
      cancel: vi.fn(async () => runningRun()),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.phase).toBe("cancelling");
    await tick(1000);
    expect(audit.history).toHaveBeenCalledTimes(2);
  });

  it("a cancel error surfaces and the run keeps being shown as running", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [runningRun()]),
      cancel: vi.fn(async () => {
        throw new IpcCallError("not_found", "No such audit run.");
      }),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.failure?.code).toBe("not_found");
    expect(result.current.phase).toBe("running");
  });

  it("cancel reply and the next poll both delivering the finished run load findings once", async () => {
    const found = [makeFinding()];
    const done = finishedRun({ findings: found });
    let releaseFindings: (f: typeof found) => void = () => {};
    const audit = fakeAudit({
      history: vi.fn().mockResolvedValueOnce([runningRun()]).mockResolvedValue([done]),
      cancel: vi.fn(async () => done),
      findings: vi.fn(
        () =>
          new Promise<typeof found>((resolve) => {
            releaseFindings = resolve;
          }),
      ),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      void result.current.cancel();
    });
    await tick(1000);
    await act(async () => releaseFindings(found));
    expect(audit.findings).toHaveBeenCalledTimes(1);
    expect(result.current.findings).toEqual(found);
  });

  it("a late 'running' poll reply cannot undo a finished run", async () => {
    let releasePoll: (r: ReturnType<typeof runningRun>[]) => void = () => {};
    const done = finishedRun({ status: "cancelled" });
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releasePoll = resolve;
            }),
        ),
      cancel: vi.fn(async () => done),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await tick(1000);
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.phase).toBe("finished");
    await act(async () => releasePoll([runningRun()]));
    expect(result.current.phase).toBe("finished");
    expect(result.current.run?.status).toBe("cancelled");
  });

  it("a findings load failure keeps the verdict and offers a retry", async () => {
    const done = finishedRun({ findings: [makeFinding()] });
    const audit = fakeAudit({
      history: vi.fn(async () => [done]),
      findings: vi
        .fn()
        .mockRejectedValueOnce(new IpcCallError("internal", "boom"))
        .mockResolvedValueOnce([makeFinding()]),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(result.current.phase).toBe("finished");
    expect(result.current.findings).toBeNull();
    expect(result.current.findingsFailure?.code).toBe("internal");
    await act(async () => {
      await result.current.retryFindings();
    });
    expect(result.current.findings).toHaveLength(1);
    expect(result.current.findingsFailure).toBeNull();
  });

  it("starting a new run from a finished result shows the new run", async () => {
    const audit = fakeAudit({
      history: vi.fn(async () => [finishedRun({ id: "old" })]),
      run: vi.fn(async () => runningRun({ id: "new" })),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("running");
    expect(result.current.run?.id).toBe("new");
    expect(result.current.findings).toBeNull();
  });

  it("start() from an opened older run follows the new run and keeps polling it", async () => {
    const older = finishedRun({ id: "old" });
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([older])
        .mockResolvedValueOnce([runningRun({ id: "new" }), older])
        .mockResolvedValue([finishedRun({ id: "new" }), older]),
      run: vi.fn(async () => runningRun({ id: "new" })),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1", "old"));
    await tick(0);
    expect(result.current.run?.id).toBe("old");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.run?.id).toBe("new");
    expect(result.current.phase).toBe("running");
    await tick(1000);
    expect(result.current.run?.id).toBe("new");
    expect(result.current.phase).toBe("running");
    await tick(1000);
    expect(result.current.run?.id).toBe("new");
    expect(result.current.phase).toBe("finished");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel reply that is already finished is followed by one history read, so stale shows", async () => {
    const done = finishedRun({ status: "cancelled" });
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockResolvedValue([{ ...done, stale: true }]),
      cancel: vi.fn(async () => done),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(result.current.run?.stale).toBeNull();
    await act(async () => {
      await result.current.cancel();
    });
    await tick(0);
    expect(audit.history).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("finished");
    expect(result.current.run?.stale).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel reply that arrives while a poll is in flight leaves exactly one timer, and none after unmount", async () => {
    let releasePoll: (r: ReturnType<typeof runningRun>[]) => void = () => {};
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releasePoll = resolve;
            }),
        )
        .mockResolvedValue([runningRun()]),
      cancel: vi.fn(async () => runningRun()),
    });
    const { result, unmount } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await tick(1000);
    await act(async () => {
      await result.current.cancel();
    });
    await act(async () => releasePoll([runningRun()]));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting mid-poll leaves no timer and no state update", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let releasePoll: (r: ReturnType<typeof runningRun>[]) => void = () => {};
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([runningRun()])
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releasePoll = resolve;
            }),
        ),
    });
    const { unmount } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    await tick(1000);
    unmount();
    await act(async () => releasePoll([runningRun()]));
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("switching project resets the state", async () => {
    const audit = fakeAudit({
      history: vi.fn(async (projectId: string) => (projectId === "p1" ? [finishedRun()] : [])),
    });
    const { result, rerender } = renderHook(({ id }) => useAuditRun(audit, id), {
      initialProps: { id: "p1" },
    });
    await tick(0);
    expect(result.current.phase).toBe("finished");
    rerender({ id: "p2" });
    await tick(0);
    expect(result.current.phase).toBe("idle");
    expect(result.current.run).toBeNull();
  });
});

describe("useAuditRun — staleness re-sync on focus", () => {
  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  afterEach(() => setVisibility("visible"));

  const focus = () => window.dispatchEvent(new Event("focus"));

  it("re-reads an opened finished run when the window gets focus again and takes its new stale flag", async () => {
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([finishedRun({ stale: false })])
        .mockResolvedValue([finishedRun({ stale: true })]),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(result.current.run?.stale).toBe(false);
    act(() => focus());
    await tick(500);
    expect(audit.history).toHaveBeenCalledTimes(2);
    expect(result.current.run?.stale).toBe(true);
    expect(result.current.phase).toBe("finished");
    expect(audit.findings).not.toHaveBeenCalled();
  });

  it("also re-reads when the page becomes visible again, but not when it becomes hidden", async () => {
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([finishedRun({ stale: false })])
        .mockResolvedValue([finishedRun({ stale: true })]),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(500);
    expect(audit.history).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(500);
    expect(audit.history).toHaveBeenCalledTimes(2);
    expect(result.current.run?.stale).toBe(true);
  });

  it("a burst of focus events is one request, and no second one starts while it is in flight", async () => {
    let release: (list: ReturnType<typeof finishedRun>[]) => void = () => {};
    const history = vi
      .fn()
      .mockResolvedValueOnce([finishedRun({ stale: false })])
      .mockImplementation(
        () =>
          new Promise<ReturnType<typeof finishedRun>[]>((resolve) => {
            release = resolve;
          }),
      );
    const audit = fakeAudit({ history });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    act(() => {
      focus();
      focus();
      focus();
    });
    await tick(500);
    expect(history).toHaveBeenCalledTimes(2);
    act(() => focus());
    await tick(500);
    expect(history).toHaveBeenCalledTimes(2);
    await act(async () => release([finishedRun({ stale: true })]));
    expect(result.current.run?.stale).toBe(true);
    act(() => focus());
    await tick(500);
    expect(history).toHaveBeenCalledTimes(3);
  });

  it("does nothing while a run is still running (the poll already keeps it fresh)", async () => {
    const audit = fakeAudit({ history: vi.fn(async () => [runningRun()]) });
    renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    expect(audit.history).toHaveBeenCalledTimes(1);
    act(() => focus());
    await tick(500);
    expect(audit.history).toHaveBeenCalledTimes(1);
  });

  it("ignores a reply that belongs to the previous project", async () => {
    let release: (list: ReturnType<typeof finishedRun>[]) => void = () => {};
    const history = vi.fn(async (id: string) => [finishedRun({ projectId: id, id: `r-${id}` })]);
    const audit = fakeAudit({ history });
    const { result, rerender } = renderHook(({ id }) => useAuditRun(audit, id), {
      initialProps: { id: "p1" },
    });
    await tick(0);
    history.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof finishedRun>[]>((resolve) => {
          release = resolve;
        }),
    );
    act(() => focus());
    await tick(500);
    rerender({ id: "p2" });
    await tick(0);
    expect(result.current.run?.id).toBe("r-p2");
    await act(async () => release([finishedRun({ projectId: "p1", id: "r-p1", stale: true })]));
    expect(result.current.run?.id).toBe("r-p2");
    expect(result.current.run?.stale).toBeNull();
  });

  it("a failed re-read keeps what is shown and raises no error", async () => {
    const audit = fakeAudit({
      history: vi
        .fn()
        .mockResolvedValueOnce([finishedRun({ stale: false })])
        .mockRejectedValue(new IpcCallError("sidecar_io", "gone")),
    });
    const { result } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    act(() => focus());
    await tick(500);
    expect(result.current.failure).toBeNull();
    expect(result.current.run?.stale).toBe(false);
    expect(result.current.phase).toBe("finished");
  });

  it("stops listening when the hook unmounts", async () => {
    const audit = fakeAudit({ history: vi.fn(async () => [finishedRun()]) });
    const { unmount } = renderHook(() => useAuditRun(audit, "p1"));
    await tick(0);
    unmount();
    act(() => focus());
    await tick(500);
    expect(audit.history).toHaveBeenCalledTimes(1);
  });
});
