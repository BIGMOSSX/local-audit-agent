# Desktop home screen — verification record (2026-10-08)

Plan: `docs/superpowers/plans/2026-10-08-desktop-home-screen.md`.

## Verified (commands run, output read)

- `pnpm --filter @audit/desktop test`: 5 files, 75 tests pass (App 26, i18n 16, ipc 19, session hook 11, drag-drop mapping 3). The App tests cover drop, the already-listed notice, the sidebar, the privacy sentence, the busy-drop hint and the 20-folder cap. The long-path/name tests assert the wrapping classes and tooltip only; real overflow needs the window.
- `pnpm typecheck`, `pnpm build`: clean. The built CSS contains the `border-dashed`, `break-all` and `color-mix` rules the new layout uses.
- `pnpm check:policy`: all seven checks ok. `scripts/check-policy.test.mjs`: 202 pass, including that `core:event:allow-emit`, `core:event:default` and the devtools toggle are rejected.
- `cargo test --locked`, `cargo clippy -D warnings`, `cargo fmt --check` on `apps/desktop/src-tauri`: pass; the build validates the two new permission identifiers.
- `pnpm lint`: only `.claude/settings.local.json` fails (a local, globally git-ignored file that is not part of the repo); `biome check apps scripts packages docs` is clean.

## Independent review

fable 5.1 reviewed the working tree (verdict: accept with fixes) and re-ran the gates itself. Its seven findings were fixed test-first: dedupe and 20-folder cap per drop, busy-drop hint and no section switch, stale notice cleared on dialog cancel/failure, long project names wrap, the plan's Review Focus 4 aligned with the tests, `.gitignore` entries anchored to the repo root, checklist row 3 updated.

## Not verified

- A real OS drag-and-drop on macOS and on Windows. jsdom tests inject a fake `DropSource`; the Tauri event itself is only mocked. Manual-check rows 6 and 7 cover it.
- Whether the two `core:event:*` permissions are sufficient at runtime on the real WebView. If a real drag fails with a permission error, the fix is to add the missing `core:event:*` identifier, never `core:default`.
- Layout at 720×480 on a real window.
- Windows entirely (spec §111 needs the user's cloud Windows).

## Security review

1. New IPC surface: none. `ipc_call` allowlist untouched; dropped paths only reach `project.open`, which the daemon validates (`invalid_path`).
2. New webview permissions: `core:event:allow-listen`, `core:event:allow-unlisten`. The page can subscribe to events; it cannot emit, spawn, read files or open URLs. `core:default` (which includes a devtools toggle) is not used.
3. A drop hands the page absolute paths of what the user dropped; they go to the local daemon and are stored like a picked folder. No logging was added.
4. CSP unchanged; no updater, shell, fs or opener plugin added.
