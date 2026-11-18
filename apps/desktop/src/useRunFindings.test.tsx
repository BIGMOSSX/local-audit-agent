import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IpcCallError } from "./ipc";
import { fakeAudit, makeFinding } from "./test-support/audit";
import { useRunFindings } from "./useRunFindings";

describe("useRunFindings", () => {
  it("asks nothing without a run id and stays not ready", () => {
    const audit = fakeAudit();
    const { result } = renderHook(() => useRunFindings(audit, null));
    expect(result.current.findings).toBeNull();
    expect(result.current.failure).toBeNull();
    expect(result.current.ready).toBe(false);
    expect(audit.findings).not.toHaveBeenCalled();
  });

  it("loads the whole list once per run id", async () => {
    const list = [makeFinding(), makeFinding()];
    const audit = fakeAudit({ findings: vi.fn(async () => list) });
    const { result, rerender } = renderHook(({ id }) => useRunFindings(audit, id), {
      initialProps: { id: "run-1" as string | null },
    });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.findings).toEqual(list);
    rerender({ id: "run-1" });
    expect(audit.findings).toHaveBeenCalledTimes(1);
  });

  it("never shows the previous run's list under a new run id", async () => {
    const first = [makeFinding({ title: "第一个" })];
    const second = [makeFinding({ title: "第二个" })];
    let release: (v: typeof second) => void = () => {};
    const audit = fakeAudit({
      findings: vi.fn((id: string) =>
        id === "run-1"
          ? Promise.resolve(first)
          : new Promise<typeof second>((resolve) => {
              release = resolve;
            }),
      ),
    });
    const { result, rerender } = renderHook(({ id }) => useRunFindings(audit, id), {
      initialProps: { id: "run-1" as string | null },
    });
    await waitFor(() => expect(result.current.findings).toEqual(first));
    rerender({ id: "run-2" });
    expect(result.current.findings).toBeNull();
    expect(result.current.ready).toBe(false);
    await act(async () => release(second));
    expect(result.current.findings).toEqual(second);
  });

  it("ignores a reply that arrives after the run id changed", async () => {
    const late: ((v: ReturnType<typeof makeFinding>[]) => void)[] = [];
    const audit = fakeAudit({
      findings: vi.fn(
        () =>
          new Promise<ReturnType<typeof makeFinding>[]>((resolve) => {
            late.push(resolve);
          }),
      ),
    });
    const { result, rerender } = renderHook(({ id }) => useRunFindings(audit, id), {
      initialProps: { id: "run-1" as string | null },
    });
    rerender({ id: "run-2" });
    const stale = [makeFinding({ title: "旧的" })];
    const fresh = [makeFinding({ title: "新的" })];
    await act(async () => late[1]?.(fresh));
    await act(async () => late[0]?.(stale));
    expect(result.current.findings).toEqual(fresh);
  });

  it("keeps a failure as a failure, not as an empty list, and retries", async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new IpcCallError("sidecar_unavailable", "no daemon"))
      .mockResolvedValueOnce([makeFinding()]);
    const audit = fakeAudit({ findings: find });
    const { result } = renderHook(() => useRunFindings(audit, "run-1"));
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.findings).toBeNull();
    expect(result.current.ready).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.failure).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });
});
