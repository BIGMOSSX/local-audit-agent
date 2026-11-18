# Step 11 Orchestrator — verification record (2026-10-08)

Plan: `docs/superpowers/plans/2026-10-08-orchestrator-step11.md`. Spec §14, §16, §19, §83.

## Verified (automated, Linux)

- `audit.run` / `audit.cancel` / `audit.history` / `finding.list` / `finding.detail` work through the real dispatch path and through a real `auditd` process (`test/sidecar.test.ts`).
- `audit.run` returns at once. Double click on one project returns the same run; another project while one is active gives `busy`.
- Cancel gives `cancelled` + `partial`; shutdown aborts and waits at most 1.5 s (below the shell's 2 s quit grace).
- A run killed with the daemon is `failed` with an honest notDone at the next start.
- Honesty: a run where no task actually ran `ok` (no engines, or all skipped) is `partial` with a notDone, never `complete`. Skipped project-code checks are reported as 未做.
- `finding.list` is paged (`offset`, `limit` ≤ 50; reply carries `total`, `offset`); a page of 50 large findings stays far below the IPC line limit. At most 2000 findings are stored per run; the cut is stated in notDone.
- Storage: migration v2 (`audit_runs`, `findings`, STRICT, FK cascade, `PRAGMA foreign_keys = ON` explicitly), newest 50 runs kept per project, corrupt rows give a generic `internal` reply.
- Failure paths: a failure in the middle of the result transaction rolls back and the run ends `failed`; if even that fails, `failRun` force-fails the row so no phantom `running` run blocks later starts. A result discarded because the run was already finished elsewhere is logged.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:policy`, biome, cargo test / clippy / fmt all green.

## Not verified / not built

- No analysis engine is installed and there is no installer (`tools.install`): in the real daemon every run ends `completed` + `partial` with a notDone. No real finding has ever passed through this path.
- The code-intelligence engine is not registered (needs an import graph, Step 9/10).
- Running a project's own code (§16): per-project consent and a per-OS isolation mechanism do not exist; `userCode.allowed` is the constant `false`.
- Two daemons on one data directory: the second's `failOrphans()` would mark the first's live run failed (its result is then discarded and logged). Single-instance locking is not implemented; the desktop shell starts one daemon.
- `audit.plan` and `finding.suppress` remain `method_not_implemented`. Gate colour logic and staleness marking are deferred.
- No UI for audits (Step 12). Nothing on macOS or Windows was run for this step.

## Security review

- No new IPC method; all five are in the §83 allowlist. Params are `strictObject`; a smuggled `userCode` is `invalid_params`.
- The session token is not logged or stored. Engine text is redacted before storage and log; log lines go through `redactSecrets` and are capped.
- Stored findings are re-validated with `FindingSchema` on read.
- Reviewed by an independent fable 5.1 pass; its findings (unbounded `finding.list`, shutdown wait vs. kill grace, phantom running row, `complete` with nothing run, implicit foreign keys, missing mid-transaction test, plan text) were fixed test-first, except single-daemon locking (recorded above).
