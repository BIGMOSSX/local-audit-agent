#!/bin/bash
# Double-click in Finder. Starts the desktop app in dev mode so the manual checklist can be done by hand.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
# shellcheck source=/dev/null
. "$ROOT/scripts/manual-check/lib.sh"

say "启动桌面应用（开发模式）。第一次需要编译 Rust，可能要十几分钟。"
say "出现窗口后，按 MANUAL-CHECKLIST.md 逐项操作。关闭窗口或在此按 Ctrl+C 结束。"
say ""

ensure_toolchain
pnpm install --frozen-lockfile || die "pnpm install 失败。"
pnpm build || die "pnpm build 失败。"
pnpm --filter @audit/desktop exec tauri dev
pause_and_exit $?
