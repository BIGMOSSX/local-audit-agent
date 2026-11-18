# Captured agentic-qe 3.14.6 output (fixtures)

Real responses of the MCP stdio server `node node_modules/agentic-qe/dist/mcp/bundle.js`, captured on an
ephemeral GitHub Actions runner (never on a developer machine).

- Source: orphan branch `spike/agentic-qe-contract`, commit `124e7fd`, workflow run `36819302596`.
- Runner: ubuntu-latest, Node 24.21.0, `agentic-qe@3.14.6`. The macOS and Windows runs returned the same
  shapes (byte counts differ only by path length).
- Input: a generated 60-file TypeScript project (`src/modNN.ts`, a test for every third file, vitest manifest).
  `*.estimated.json` ran on a project with no coverage report; `*.measured.json` on a copy with `coverage/lcov.info`.
- Server env: reduced PATH, HOME/TMP in temp dirs, `AQE_LLM_ROUTER_DISABLED=1`, `AQE_COVERAGE_NO_EXEC=1`, cwd = a
  separate empty temp dir. Linux network was blocked at OS level (`unshare -n`) and the connect-level hook saw
  0 non-loopback connections, 0 child processes, 0 writes into the project.
- Files are the full JSON-RPC response (`result.content[0].text` is a JSON string `{success, data}`).
  Absolute paths inside the responses are the generated project paths (`/tmp/aqe-contract-WAPKVx/...`).

## Facts that shape the adapter

- Every tool takes `target` (string). `quality_assess` has NO project argument (only `runGate`); it scans the
  server's cwd, so it saw 0 files here. It is therefore not allowlisted.
- `code_index` reported `filesIndexed: 0` and only writes into AQE's own result folder. No usable output; not allowlisted.
- `defect_predict` found nothing on the fixture and `test_generate_enhanced` returned canned names
  (`ComponentA`). Neither is allowlisted (R11: kept only if the output proves useful).
- `coverage_analyze_sublinear` with no coverage report on disk returns `estimated: true, measured: false` and
  says so itself ("STATIC ESTIMATE ... must not be reported as measured coverage"). With a report on disk
  (`coverage/lcov.info`) it returns `measured: true, estimated: false, coverageMethod: "instrumented-report"`.
  Without `AQE_COVERAGE_NO_EXEC=1` it would run the project's test runner (`npx vitest ...`); the env var is mandatory.
- Paths in responses are absolute (under the target). The adapter must turn them into repo-relative paths and drop
  anything outside the project.
- A response for 60 files is about 100 KB (`gaps` and `gapAnalysis.gaps` duplicate each other); cap what is read.
- All tools are annotated `readOnlyHint:false, destructiveHint:true, openWorldHint:true`. Results are written to
  `<cwd>/.agentic-qe/results/` (cwd is a throwaway directory).

## Not proven by this capture

- The macOS and Windows OS-level network blocks did not take effect in the probe (macOS `pfctl` wrapper gave no
  effect; Windows already refused the control connection), so only Linux has valid block evidence. The
  connect-level hook still saw 0 non-loopback connections on all three.
- The 60-file fixture is small; large-project behaviour and timing are untested.
