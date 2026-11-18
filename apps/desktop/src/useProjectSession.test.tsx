import type { Project } from "@audit/audit-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IpcCallError, type ProjectClient } from "./ipc";
import { useProjectSession } from "./useProjectSession";

const make = (path: string): Project => ({
  id: `id:${path}`,
  path,
  name: path.split("/").pop() ?? path,
  ecosystems: [],
  packageManager: null,
  isMonorepo: false,
  isGitRepo: false,
  addedAt: 1,
  lastOpenedAt: 1,
});

function client(initial: Project[] = []) {
  let stored = [...initial];
  const open = vi.fn(async (path: string) => {
    if (path.includes("BAD")) throw new IpcCallError("invalid_path", `Not a directory: ${path}`);
    const found = stored.find((p) => p.path === path) ?? make(path);
    stored = [found, ...stored.filter((p) => p.id !== found.id)];
    return found;
  });
  const list = vi.fn(async () => [...stored]);
  const impl: ProjectClient = { list, open };
  return { impl, open, list };
}

describe("useProjectSession", () => {
  it("opens several paths in order and lists them", async () => {
    const { impl, open } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(() => result.current.openPaths(["/a", "/b"]));
    expect(open.mock.calls.map((c) => c[0])).toEqual(["/a", "/b"]);
    expect(result.current.projects?.map((p) => p.path)).toEqual(["/b", "/a"]);
    expect(result.current.alreadyListed).toBe(false);
  });

  it("one bad path in several does not stop the others, and only the first error is kept", async () => {
    const { impl } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(() => result.current.openPaths(["/a", "/BAD1", "/b", "/BAD2"]));
    expect(result.current.projects?.map((p) => p.path)).toEqual(["/b", "/a"]);
    expect(result.current.failure).toEqual({
      code: "invalid_path",
      detail: "Not a directory: /BAD1",
    });
    expect(result.current.alreadyListed).toBe(false);
  });

  it("dropping the same new folder twice in one go is not reported as already listed", async () => {
    const { impl } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(() => result.current.openPaths(["/a", "/a"]));
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.alreadyListed).toBe(false);
  });

  it("alreadyListed is true only when every opened path was already known", async () => {
    const { impl } = client([make("/a"), make("/b")]);
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    await act(() => result.current.openPaths(["/a", "/b"]));
    expect(result.current.alreadyListed).toBe(true);
    await act(() => result.current.openPaths(["/a", "/new"]));
    expect(result.current.alreadyListed).toBe(false);
  });

  it("a drop during an open in flight is ignored", async () => {
    const { impl, open } = client();
    let release: () => void = () => {};
    open.mockImplementationOnce(
      (path: string) =>
        new Promise<Project>((resolve) => {
          release = () => resolve(make(path));
        }),
    );
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.openPaths(["/a"]);
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(() => result.current.openPaths(["/b"]));
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.busy).toBe(false);
  });

  it("an empty list of paths does nothing", async () => {
    const { impl, open } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(() => result.current.openPaths([]));
    expect(open).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("a first list that arrives after a drop does not wipe the opened project", async () => {
    const { impl, list } = client();
    let finish: (value: Project[]) => void = () => {};
    list.mockImplementationOnce(
      () =>
        new Promise<Project[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useProjectSession(impl));
    expect(result.current.projects).toBeNull();
    await act(() => result.current.openPaths(["/a"]));
    expect(result.current.projects?.map((p) => p.path)).toEqual(["/a"]);
    await act(async () => finish([]));
    expect(result.current.projects?.map((p) => p.path)).toEqual(["/a"]);
  });
  it("the same path twice in one drop is opened once", async () => {
    const { impl, open } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(() => result.current.openPaths(["/a", "/a", "/b"]));
    expect(open.mock.calls.map((c) => c[0])).toEqual(["/a", "/b"]);
  });

  it("a huge drop opens only the first 20 and says so", async () => {
    const { impl, open } = client();
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    const many = Array.from({ length: 25 }, (_, i) => `/p${i}`);
    await act(() => result.current.openPaths(many));
    expect(open).toHaveBeenCalledTimes(20);
    expect(result.current.tooMany).toBe(true);
    await act(() => result.current.openPaths(["/p1"]));
    expect(result.current.tooMany).toBe(false);
  });

  it("a cancelled dialog clears the previous notice, and a dialog failure replaces it", async () => {
    const { impl } = client([make("/a")]);
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await act(() => result.current.openPaths(["/a"]));
    expect(result.current.alreadyListed).toBe(true);
    await act(() => result.current.pickAndOpen(async () => null));
    expect(result.current.alreadyListed).toBe(false);
    await act(() => result.current.openPaths(["/a"]));
    await act(() =>
      result.current.pickAndOpen(async () => {
        throw new Error("dialog exploded");
      }),
    );
    expect(result.current.alreadyListed).toBe(false);
    expect(result.current.failure?.code).toBe("internal");
  });

  it("isBusy reports an open in flight", async () => {
    const { impl, open } = client();
    let release: () => void = () => {};
    open.mockImplementationOnce(
      (path: string) =>
        new Promise<Project>((resolve) => {
          release = () => resolve(make(path));
        }),
    );
    const { result } = renderHook(() => useProjectSession(impl));
    await waitFor(() => expect(result.current.projects).toEqual([]));
    expect(result.current.isBusy()).toBe(false);
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.openPaths(["/a"]);
    });
    expect(result.current.isBusy()).toBe(true);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current.isBusy()).toBe(false);
  });
});
