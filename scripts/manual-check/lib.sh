#!/bin/bash
# Sourced by the launchers in the bundle root. $ROOT must be set by the caller.
# Everything this script installs goes under $ROOT/.tools (no sudo). Delete that folder to undo it.

TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"
export TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
export npm_config_store_dir="$TOOLS/pnpm-store"

if [ -t 1 ]; then CURL_OPTS=(-fL --progress-bar); else CURL_OPTS=(-fsSL); fi

say() { printf '%s\n' "$*"; }

ask() {
  [ "${AUTO_YES:-0}" = "1" ] && return 0
  local reply
  printf '%s [Y/n] ' "$1"
  read -r reply </dev/tty || return 0
  case "$reply" in n | N | no | NO) return 1 ;; *) return 0 ;; esac
}

die() {
  say "错误：$*"
  pause_and_exit 1
}

pause_and_exit() {
  if [ "${NO_PAUSE:-0}" != "1" ]; then
    printf '\n按回车关闭窗口… '
    read -r _ </dev/tty || true
  fi
  exit "${1:-0}"
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] 2>/dev/null
}

ensure_clt() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "未安装 Xcode 命令行工具，正在弹出系统安装窗口。"
    say "请在弹窗里点“安装”，等它装完后，再双击本脚本重新运行。"
    xcode-select --install 2>/dev/null || true
    pause_and_exit 1
  fi
}

ensure_node() {
  [ -x "$TOOLS/node/bin/node" ] && export PATH="$TOOLS/node/bin:$PATH"
  node_ok && return 0
  ask "没有找到 Node 24 或更高版本。下载到 .tools/node（约 40 MB，不需要管理员密码）？" || die "没有 Node 无法继续。"
  local arch sums line file sha
  case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) die "不认识的 CPU：$(uname -m)" ;; esac
  sums="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)" || die "下载 Node 校验文件失败，请检查网络。"
  line="$(printf '%s\n' "$sums" | grep "darwin-$arch.tar.gz$" | head -1)"
  [ -n "$line" ] || die "校验文件里没有找到 darwin-$arch 的包。"
  sha="${line%% *}"
  file="${line##* }"
  say "下载 $file …"
  curl "${CURL_OPTS[@]}" -o "$TOOLS/$file" "https://nodejs.org/dist/latest-v24.x/$file" || die "下载 Node 失败。"
  [ "$(shasum -a 256 "$TOOLS/$file" | cut -d' ' -f1)" = "$sha" ] || die "Node 压缩包校验不通过，已停止。"
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node"
  tar -xzf "$TOOLS/$file" -C "$TOOLS/node" --strip-components 1 && rm -f "$TOOLS/$file"
  export PATH="$TOOLS/node/bin:$PATH"
  node_ok || die "Node 安装后仍不可用。"
}

ensure_pnpm() {
  [ -x "$TOOLS/pnpm/node_modules/.bin/pnpm" ] && export PATH="$TOOLS/pnpm/node_modules/.bin:$PATH"
  [ "$(pnpm -v 2>/dev/null)" = "9.12.0" ] && return 0
  say "安装 pnpm 9.12.0 到 .tools/pnpm …"
  npm install --prefix "$TOOLS/pnpm" pnpm@9.12.0 --no-audit --no-fund --loglevel=error || die "安装 pnpm 失败。"
  export PATH="$TOOLS/pnpm/node_modules/.bin:$PATH"
}

rust_ok() { command -v cargo >/dev/null 2>&1 && cargo clippy --version >/dev/null 2>&1 && command -v rustfmt >/dev/null 2>&1; }

ensure_rust() {
  if [ -d "$TOOLS/cargo" ]; then
    export RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo"
    export PATH="$TOOLS/cargo/bin:$PATH"
  fi
  rust_ok && return 0
  ask "没有找到 Rust（含 clippy、rustfmt）。下载安装到 .tools（约 300 MB，不需要管理员密码）？" || die "没有 Rust 无法跑桌面端检查。"
  local triple
  case "$(uname -m)" in arm64) triple=aarch64-apple-darwin ;; x86_64) triple=x86_64-apple-darwin ;; *) die "不认识的 CPU：$(uname -m)" ;; esac
  export RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo"
  curl "${CURL_OPTS[@]}" -o "$TOOLS/rustup-init" "https://static.rust-lang.org/rustup/dist/$triple/rustup-init" || die "下载 rustup 失败。"
  chmod +x "$TOOLS/rustup-init"
  "$TOOLS/rustup-init" -y --no-modify-path --profile minimal -c clippy -c rustfmt || die "安装 Rust 失败。"
  rm -f "$TOOLS/rustup-init"
  export PATH="$TOOLS/cargo/bin:$PATH"
  rust_ok || die "Rust 安装后仍不可用。"
}

ensure_toolchain() {
  xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
  ensure_clt
  ensure_node
  ensure_pnpm
  ensure_rust
}

STEP_NAMES=()
STEP_RC=()
STEP_SECS=()

# run_step <name> <command...>: run in $ROOT, log to $LOGDIR/<name>.log, never abort the whole run.
run_step() {
  local name="$1" start pid rc
  shift
  start=$SECONDS
  say "▶ $name"
  (cd "$ROOT" && "$@") >"$LOGDIR/$name.log" 2>&1 &
  pid=$!
  local ticks=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    ticks=$((ticks + 1))
    [ $((ticks % 30)) -eq 0 ] && say "   … $name 仍在运行（$((SECONDS - start)) 秒）"
  done
  wait "$pid"
  rc=$?
  STEP_NAMES+=("$name")
  STEP_RC+=("$rc")
  STEP_SECS+=("$((SECONDS - start))")
  if [ "$rc" -eq 0 ]; then say "   通过（$((SECONDS - start)) 秒）"; else say "   失败，退出码 $rc（$((SECONDS - start)) 秒）"; fi
}

step_test() {
  local status=0
  pnpm exec turbo run test --continue=always --force || status=1
  pnpm exec vitest run --dir scripts || status=1
  return $status
}

step_flake() {
  local i status=0
  for i in 1 2 3 4 5; do
    echo "--- sandbox-run 第 $i 次 ---"
    pnpm --filter @audit/auditd exec vitest run test/sandbox-run.test.ts || status=1
  done
  return $status
}

step_rust_test() { cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml; }
step_rust_fmt() { cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check; }
step_rust_clippy() { cargo clippy --locked --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings; }
