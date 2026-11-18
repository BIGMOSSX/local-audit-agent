# Local Audit Agent — working rules

Discipline: Requirement → Test → Implementation → Security Review → Run → Verify. "UI exists" is not "feature done".

Hard rules
- No engine, scanner or model-vendor name on any website surface; never write "白话/大白话"; the product is never called "自研模型".
- Renderer → daemon calls go only through the renderer-to-daemon allowlist. Never add a generic exec/shell method.
- No `tauri-plugin-updater` until the signed pipeline exists. No shell/fs/opener plugin permissions for the webview.
- Never log or persist the auditd session token. Secrets go through `@audit/shared` `redactSecrets` before any log write.
- Package scope is `@audit/*`. Internal packages export TypeScript source.

Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:policy`.
