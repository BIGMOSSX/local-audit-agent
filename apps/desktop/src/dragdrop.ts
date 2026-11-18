import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface DropHandlers {
  onHover(active: boolean): void;
  onDrop(paths: string[]): void;
}

/** Subscribes to folder drops on the window; resolves to the function that unsubscribes. */
export type DropSource = (handlers: DropHandlers) => Promise<() => void>;

export const tauriDropSource: DropSource = (handlers) =>
  getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    switch (payload.type) {
      case "enter":
        handlers.onHover(true);
        break;
      case "leave":
        handlers.onHover(false);
        break;
      case "drop":
        handlers.onHover(false);
        handlers.onDrop(payload.paths);
        break;
      default:
        break;
    }
  });
