import type { ClientErrorCode } from "./ipc";
import zh from "./locales/zh.json";

export type MessageKey = keyof typeof zh;

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return zh[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

export function errorText(code: ClientErrorCode): string {
  return t(`error.${code}`);
}
