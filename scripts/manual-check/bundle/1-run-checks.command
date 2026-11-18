#!/bin/bash
# Double-click in Finder. Runs the full gate on this Mac and writes a report you can paste back.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
# shellcheck source=/dev/null
. "$ROOT/scripts/manual-check/lib.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$ROOT/report/mac-check-$STAMP"
LOGDIR="$REPORT/logs"
mkdir -p "$LOGDIR"

say "本机检查：只运行本仓库自己的代码和测试，不运行任何第三方引擎。"
say "报告会放在：$REPORT"
say ""

export CI=1
ensure_toolchain

run_step install pnpm install --frozen-lockfile
run_step lint pnpm lint
run_step typecheck pnpm typecheck
run_step build pnpm build
run_step test step_test
run_step check-policy pnpm check:policy
run_step rust-fmt step_rust_fmt
run_step rust-clippy step_rust_clippy
run_step rust-test step_rust_test
run_step sandbox-run-x5 step_flake

SUMMARY="$REPORT/summary.txt"
{
  echo "== Mac 检查报告 $STAMP =="
  echo "macOS: $(sw_vers -productVersion) ($(sw_vers -buildVersion))  CPU: $(uname -m)  $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  echo "Node: $(node -v)  pnpm: $(pnpm -v)  $(rustc --version 2>/dev/null)"
  echo "仓库提交: $(cat "$ROOT/COMMIT.txt" 2>/dev/null || echo 未记录)"
  echo ""
  printf '%-16s %-6s %s\n' 步骤 结果 耗时
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_RC[$i]}" -eq 0 ]; then r=通过; else r="失败(${STEP_RC[$i]})"; fi
    printf '%-16s %-6s %ss\n' "${STEP_NAMES[$i]}" "$r" "${STEP_SECS[$i]}"
  done
  echo ""
  echo "未覆盖：macOS 的 pf 网络阻断、桌面界面（见 2-open-desktop.command 和 MANUAL-CHECKLIST.md）。"
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_RC[$i]}" -ne 0 ]; then
      echo ""
      echo "----- ${STEP_NAMES[$i]} 的日志末尾 120 行 -----"
      tail -n 120 "$LOGDIR/${STEP_NAMES[$i]}.log"
    fi
  done
} >"$SUMMARY"

(cd "$REPORT/.." && zip -qr "$REPORT.zip" "mac-check-$STAMP") 2>/dev/null || true
pbcopy <"$SUMMARY" 2>/dev/null && say "报告已复制到剪贴板，回到对话里直接粘贴即可。"
say ""
cat "$SUMMARY"
open "$REPORT" 2>/dev/null || true
say ""
say "报告文件夹：$REPORT"
pause_and_exit 0
