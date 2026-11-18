#!/bin/bash
# Double-click in Finder. Runs the machine-checkable part of the desktop checklist against the real daemon.
HERE="$(cd "$(dirname "$0")" && pwd)"
# This file may sit in a small add-on folder; find the full bundle (the folder holding lib.sh and package.json) above it.
ROOT="$HERE"
while [ ! -f "$ROOT/scripts/manual-check/lib.sh" ] || [ ! -f "$ROOT/package.json" ]; do
  [ "$ROOT" = "/" ] && { echo "错误：在上层目录里找不到完整的检查包（audit-mac-check）。请把本文件夹放进它里面再双击。"; read -r _ </dev/tty; exit 1; }
  ROOT="$(dirname "$ROOT")"
done
cd "$ROOT" || exit 1
SAMPLES="$HERE/sample-projects"
[ -d "$SAMPLES" ] || SAMPLES="$ROOT/sample-projects"
CHECK_JS="$HERE/scripts/manual-check/desktop-auto-check.mjs"
[ -f "$CHECK_JS" ] || CHECK_JS="$ROOT/scripts/manual-check/desktop-auto-check.mjs"
# shellcheck source=/dev/null
. "$ROOT/scripts/manual-check/lib.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$ROOT/report/desktop-auto-$STAMP"
LOGDIR="$REPORT/logs"
mkdir -p "$LOGDIR"
SUMMARY="$REPORT/summary.txt"

say "自动桌面检查：启动真实的后台服务，按桌面应用的方式逐项检查（约 1 分钟，装好环境后）。"
say ""

ensure_toolchain

run_step install pnpm install --frozen-lockfile
run_step build pnpm build

{
  echo "== 桌面自动检查 $STAMP =="
  echo "macOS: $(sw_vers -productVersion 2>/dev/null) CPU: $(uname -m)  Node: $(node -v)"
  echo "仓库提交: $(cat "$ROOT/COMMIT.txt" 2>/dev/null || echo 未记录)"
  echo ""
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_RC[$i]}" -ne 0 ]; then echo "准备步骤失败：${STEP_NAMES[$i]}（日志在 $LOGDIR）"; fi
  done
} >"$SUMMARY"

if [ "${STEP_RC[0]:-1}" -eq 0 ] && [ "${STEP_RC[1]:-1}" -eq 0 ]; then
  node "$CHECK_JS" "$SAMPLES" "$SUMMARY" "$ROOT"
else
  tail -n 60 "$LOGDIR"/*.log >>"$SUMMARY" 2>/dev/null
fi

{
  echo ""
  echo "未自动检查（需要人看窗口，见 MANUAL-CHECKLIST.md）：首屏白屏时长、选文件夹弹窗、红框文字、没有更新入口、窗口缩放。"
} >>"$SUMMARY"

(cd "$REPORT/.." && zip -qr "$REPORT.zip" "desktop-auto-$STAMP") 2>/dev/null || true
DESK="$HOME/Desktop/桌面检查报告-$STAMP.txt"
cp "$SUMMARY" "$DESK" 2>/dev/null && say "报告文件：$DESK"
pbcopy <"$SUMMARY" 2>/dev/null && say "报告已复制到剪贴板，回到对话里直接粘贴即可。"
say ""
cat "$SUMMARY"
open "$REPORT" 2>/dev/null || true
pause_and_exit 0
