import { beforeEach, describe, expect, it, vi } from "vitest";

const { onDragDropEvent } = vi.hoisted(() => ({ onDragDropEvent: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent }) }));

import { tauriDropSource } from "./dragdrop";

type Payload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

const at = { x: 1, y: 2 };

describe("tauriDropSource", () => {
  let emit: (payload: Payload) => void;
  const unlisten = vi.fn();
  beforeEach(() => {
    unlisten.mockClear();
    onDragDropEvent.mockReset();
    onDragDropEvent.mockImplementation(async (cb: (e: { payload: Payload }) => void) => {
      emit = (payload) => cb({ payload });
      return unlisten;
    });
  });

  it("maps enter / leave to hover and drop to the dropped paths", async () => {
    const handlers = { onHover: vi.fn(), onDrop: vi.fn() };
    await tauriDropSource(handlers);
    emit({ type: "enter", paths: ["/a"], position: at });
    expect(handlers.onHover).toHaveBeenLastCalledWith(true);
    emit({ type: "leave" });
    expect(handlers.onHover).toHaveBeenLastCalledWith(false);
    emit({ type: "drop", paths: ["/a", "/b c/测试 (副本)"], position: at });
    expect(handlers.onHover).toHaveBeenLastCalledWith(false);
    expect(handlers.onDrop).toHaveBeenCalledWith(["/a", "/b c/测试 (副本)"]);
  });

  it("ignores the position-only 'over' event", async () => {
    const handlers = { onHover: vi.fn(), onDrop: vi.fn() };
    await tauriDropSource(handlers);
    emit({ type: "over", position: at });
    expect(handlers.onHover).not.toHaveBeenCalled();
    expect(handlers.onDrop).not.toHaveBeenCalled();
  });

  it("resolves to the unlisten function, and rejects when subscribing fails", async () => {
    const stop = await tauriDropSource({ onHover: vi.fn(), onDrop: vi.fn() });
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    onDragDropEvent.mockRejectedValueOnce(new Error("not allowed"));
    await expect(tauriDropSource({ onHover: vi.fn(), onDrop: vi.fn() })).rejects.toThrow(
      "not allowed",
    );
  });
});
