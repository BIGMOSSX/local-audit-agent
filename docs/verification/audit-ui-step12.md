# Step 12 "检查中" UI and results page — verification record (2026-10-12)

Plan: `docs/superpowers/plans/2026-10-12-step12-audit-ui.md`. Design: `docs/superpowers/specs/2026-10-12-step12-audit-ui-design.md`. Spec §10, §16, §35, §55, §83, §102.

Status: implemented, **not committed**. The user has not asked for a commit.

## What a real run shows today

No analysis engine is installed and there is no installer, so on the real daemon every run ends `completed` + `partial`, zero findings, gate `none` (grey, "这次没有完成任何检查"), with the 未做 list: engine could not run, nothing actually ran, understanding the project / generating tests / deep security analysis need an AI model. Green is unreachable without a model by construction (the orchestrator adds that 未做 item while `modelConnected` is false).

## Verified (automated, Linux)

- Gate logic (`summarize`, `bucketOf`, `sortByImportance`) as tables in `packages/audit-core/test/gate.test.ts`: four states, bucket rules (§55: a finding whose only source is model reasoning never blocks), `none` when nothing ran, `ready` only for a completed, complete run with nothing skipped, failed or not done.
- `AuditRun` schema refuses: a summary while running, a finished run without a summary, `ready` for a run that is not complete.
- Storage: migration v3 (`summary`, `code_stamp`); summaries stored when a run finishes; legacy and orphaned rows derive the summary on read and write it back once; failed/orphaned runs store a "no result" summary.
- Staleness: content stamp (sha256 of sorted `path|size|mtimeMs`) taken before the run starts; `audit.history` compares every stamped finished run with the current stamp (older runs differing from the project now read stale too); unknown stays `null`; memoized for 3 s per project with a shared in-flight promise. Sidecar e2e against a real `auditd` process: `stale === false` after a run, `stale === true` after a file edit.
- Cancel or shutdown during the stamp walk ends the run `cancelled` and never calls the service.
- Renderer: `useAuditRun` (resume, 1 s poll, cancel, error stop, follows the newest run even when started from an opened older run, re-syncs after a finished cancel reply), `RunningView` (no percentage; a gate is passed / current / waiting while running, 读懂项目 and 试运行测试 are always shown as 这次不做 with their reason, nothing is shown as done before the run has finished), `ResultView` (verdicts, honesty line, 未做 list, stale banner, three columns, advanced drawer closed by default), `FindingCard`, `fixPrompt`, `ReportsView`, `HomeView` entry.
- Fix prompt is a fixed template over validated structured fields. An injection fixture in title, message, remediation, verifyAfterFix, evidence and path never appears in the copied text.
- Degraded-run banner (§35, built after the acceptance review, user-approved): `degradation.ts` decides cancelled / failed / nothing-ran / some-skipped / partial from status, summary counts and completeness only; the remedy line says "重新检查" only where a recheck can help and says plainly when this version cannot supply the missing part. 12 tests (table + rendered copy).
- Policy: no engine, scanner or vendor names and no forbidden wording in copy; all copy via `t()`.
- No new IPC method: `allowlist.rs` (17 entries) and `capabilities/default.json` unchanged; `git diff --stat apps/desktop/src-tauri` is empty.

Final gate numbers: see "Gate results" below.

## Real window run (Linux)

What was run, on this machine (display, webkit2gtk-4.1, chromium present):

- The renderer in Chromium at 720×480 and at 1000 px wide, with faked daemon replies for every state (running at each stage, finished gate none/review/blocked/ready, cancelled, failed, stale, long file names).
- The real Tauri window with the real `auditd` sidecar on an isolated data directory: drop/open a project, press 检查, watch the four stages, read the result, open it again from 报告.

What it showed:

- Layout holds at 720×480 and 1000 px; nothing is clipped; the gate is always a word.
- A real run ends `completed` + `partial`, gate none, zero findings, with the 未做 list, as described at the top.
- Five defects, found by reading the real screens and fixed test-first in `apps/desktop/src`:
  1. 试运行测试 showed as current/passed while the quality engine reported progress, although project code is never run. It is now always 这次不做, with the reason from the 审计 intro wording; quality-engine progress counts toward 找安全漏洞.
  2. 读懂项目 could show 已经过 although it needs an AI model. It is now 这次不做 with "需要连接 AI 模型". Both facts live in one table, `SKIPPED_GATES` in `gates.ts`, with a note that it flips when a model path exists. Code-intelligence progress also counts toward 找安全漏洞 (chosen: it is reported while checking, and understanding is a model task).
  3. `result.needReview` was circular at 建议先看看. It now says what is left to do and that the gate can reach 建议先看看 at most, so it cannot be released yet.
  4. A cancelled run in which nothing ran read "这次没有完成任何检查". The headline and verdict now say the run was cancelled and no conclusion was reached; the degraded banner is kept, the gate stays `none` (never green or yellow), and a blocker already found stays red.
  5. An opened run's `stale` was only read once. It is re-read quietly on window focus and when the page becomes visible (250 ms debounce, one request in flight, only for a finished run, replies of a previous project or run ignored, errors silent), and 报告 rows show 已过期 in words when `stale` is true.

Could not be done: a real cancel (the run ends in under a second, so there is no window to press 取消 in) and real findings (no engine can be installed yet), so cards, columns and red/green verdicts are still shown only with fixtures.

## Not verified

- **No real finding has ever passed through this UI.** Cards, the three columns, red/yellow/green verdicts and fix prompts are exercised only with fake clients and fixtures.
- Real window runs exist only for Linux (see "Real window run (Linux)"). macOS and Windows windows, the drag-drop path, and a cancel under a real daemon (a real run ends in under a second here) are still owed. Rows 8–11 of `scripts/manual-check/bundle/MANUAL-CHECKLIST.md` are for the user to run.
- `stale` accuracy depends on `mtimeMs` and size; a same-size edit within one mtime tick is not detected. Over-cap or unreadable projects give `unknown`, which shows nothing.
- Test-first was strict for `gate.ts`, the audit schema, the repo and orchestrator changes. `fixPrompt` and the view tests were written together with their implementation.

## Not built (deliberate)

- **BOSS 版** was missing from the first version of this list (an omission, not a decision). It was built afterwards as a second presentation over the same runs; see `docs/verification/boss-edition.md`. 小白版 is unchanged by it.

- **Consent UI and per-OS isolation provider** (§16). `userCode.allowed` is the constant `false`; a consent dialog in front of it would be a fake guarantee. "运行项目测试" shows as 未做 with the real reason.
- `audit.plan` and scope/depth options, `finding.suppress`, export, 让 AI 帮我修 launcher and deep links (only 复制修复提示词), engine installer, model connection, single-daemon lock.
- A fourth gate state `none` is **not in the spec** (§35 has three). It is a deliberate addition so that a run in which nothing ran is never yellow or green.

## Security review notes

- Renderer → daemon only through existing `audit.run / audit.cancel / audit.history / finding.list / finding.detail`; params strict, a smuggled `userCode` is `invalid_params`.
- Session token is never logged or stored. Engine text is redacted at write time (Step 11) and appears only in the 高级 drawer.
- React text nodes only; no `dangerouslySetInnerHTML`; no clipboard content other than the fixed-template prompt.
- Stamp walk reuses the sandboxed `listProjectFiles` (no symlink following, same caps) and only reads metadata; paths are never logged.
- The copied fix prompt contains no code quote and no free text from the project or engine.

## Independent review (Fable 5.1) and what was fixed

1. **Plan review** (before coding): findings on the 2000-cut ordering, model reasoning blocking, running-state claims, stamp cost and the quote in the fix prompt were all applied to the design and plan before implementation.
2. **Acceptance review** (after coding): 4 must-fix and 10 should-fix.
   - Fixed: polling reverted to the opened older run after 重新检查; "必须先修 N 件事" contradicted the empty 必须先修 column; `stale` lost after a finished cancel reply; verification note written; real-daemon fixture and e2e assertions; dead `gates.ts` code; model hint promised a 设置 action that does not exist; timer overwrite; Reports list not refreshed after returning; gate names aligned with §35 and the checklist; cancel during the stamp walk; the 3.3 s sleep in the sidecar test; staleness semantics pinned by a test and written into the design; degraded-run banner added to the not-built list.
   - A Fable 5.1 re-verification pass confirmed all of them and found no regression; its remaining notes were two wording errors in this note (fixed) and `cancellingRef` staying set while a cancel that timed out is still winding down (kept: the abort is already signalled, so the button stays on 取消中).

## Gate results

Run on Linux after the acceptance-review fixes:

- `pnpm typecheck`, `pnpm build`, `pnpm check:policy` (7 ok), `pnpm exec biome check apps scripts packages docs`: all pass.
- `@audit/audit-core` 154/154, `@audit/desktop` 210/210, `@audit/auditd` 459 passed / 2 skipped (needs `pnpm --filter @audit/auditd build` first).
- `git diff --stat apps/desktop/src-tauri` is empty.
- `pnpm lint` still fails only on the git-ignored `.claude/settings.local.json`, which is not ours.
