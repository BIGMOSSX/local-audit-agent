# Foundation — manual verification (spec §111)

Automated checks cover the daemon, the IPC contract and the UI logic on Linux, and CI compiles and tests the Rust shell on macOS and Windows. These steps confirm what only a person at a real desktop can: the window, the native folder dialog and the process lifecycle. Run on **each of macOS and Windows**, from a clean checkout after `pnpm install && pnpm build`, using `pnpm --filter @audit/desktop tauri dev`.

Record the result of each line (pass / fail + note) and the OS version.

1. [ ] The window opens; the title, the empty state ("还没有项目…") and the "选择项目文件夹" button are visible; no console error in the webview devtools.
2. [ ] Click the button: the native folder dialog opens. Cancel it — nothing changes and no error banner appears.
3. [ ] Pick a folder whose path contains Chinese characters and a space (for example `测试 项目`) that contains a `package.json`. The project appears in the list with the right name and the "node" ecosystem.
4. [ ] Pick the same folder again: the list still has one entry (no duplicate).
5. [ ] Quit the app completely and start it again: the project is still listed.
6. [ ] With the app running, find the `node` process running `auditd/dist/main.js` (Activity Monitor / Task Manager) and kill it. Pick another folder: the call succeeds (the shell restarted the daemon). No window flashes and no console window appears on Windows.
7. [ ] Quit the app: no `node` process running `auditd` is left behind (macOS/Linux: also no `audit-*` directory left in the temp dir).
8. [ ] Pick a folder, then delete it in the file manager, then reopen the app: the list loads; the entry is present (its "folder missing" state belongs to a later plan). No crash.
9. [ ] In the webview devtools console run `await window.__TAURI_INTERNALS__.invoke("ipc_call", { method: "shell.exec", params: { cmd: "id" } })` → rejects with code `method_not_allowed`.
10. [ ] `apps/desktop/src-tauri/tauri.conf.json` has no updater section, and `pnpm check:policy` prints seven `ok` lines.

Known and accepted at this stage: the placeholder app icon and identifier, unsigned/unbundled builds (`bundle.active` is false), Tailwind 4 needing a WebView of Safari 16.4 / Chromium 111 or newer (the minimum macOS version is decided in the packaging plan).

## Not yet verified by anyone (state as of the foundation hand-off)

None of the items above has been run yet, and the following were not exercised on any machine when this checklist was written. Each is an open item for a human; tick a box only after running it and recording the OS version.

- [ ] The Rust in `apps/desktop/src-tauri` compiles. It has never been compiled, and has not been through `cargo fmt` or `cargo clippy` either; expect one round of fixes on the first CI run. After the first green compile, commit `Cargo.lock`, add `--locked` to `cargo test`, and add `cargo fmt --check` and `cargo clippy -- -D warnings` as CI gates.
- [ ] The Rust integration tests pass on macOS (arm64) and on Windows. macOS x64 is not covered by CI at all.
- [ ] The Node test suite passes on macOS and Windows runners (the POSIX-only cases skip themselves on Windows; a Windows failure is a real signal about named pipes and must be fixed, not skipped).
- [ ] Sidecar respawn works on a real desktop: killing the `auditd` process is followed by a successful call (checklist line 6), with no console window on Windows.
- [ ] The webview content security policy does not block the UI: HeroUI and Tailwind inline styles render correctly in the packaged webview on macOS (WKWebView) and Windows (WebView2), with no CSP violation in the devtools console.
- [ ] The native folder dialog still opens and returns a path now that `core:default` has been dropped from the capability file (checklist lines 2 and 3 exercise this; if the dialog is denied, grant only the specific dialog permission, never a broad default).
- [ ] Windows named pipe access control: a Windows pipe has no `0700` equivalent, so the session token is the only barrier there. Confirm that another local user account cannot connect to the pipe, and that a connection without the token is rejected.
- [ ] Wrong or missing session token is rejected by the daemon on macOS and Windows, and the token appears in no log or file on either OS.
