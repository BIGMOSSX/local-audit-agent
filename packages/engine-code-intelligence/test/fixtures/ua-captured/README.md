# ua-captured

Real output of Understand Anything's deterministic pipeline, captured for the Task 9 Part B type definitions. Do not hand-edit `graph.json`; regenerate it by re-running the spike if the pinned upstream commit changes.

- Source: GitHub Actions run `36812434905`, job `probe (ubuntu-latest)`, between the `GRAPH_BEGIN` / `GRAPH_END` log markers. Evidence is the run log, not an artifact.
- Probe branch: `spike/understand-anything` at commit `01d7548`.
- Upstream: `Egonex-AI/Understand-Anything` at `b05cc3b20990afca537b4fc0a49b4d7fbdc65bb0` (plugin v2.9.7).
- Input: a generated 60-file TypeScript fixture (`src/m<i%20>/f<i>.ts`; each file exports one constant and one function `fn<i>` and imports 2-3 other files across 20 subdirectories by extensionless relative path) plus a `package.json`. 174 known imports, 174 found as `imports` edges.
- Produced by: `scan-project.mjs` -> `extract-import-map.mjs` -> `extract-structure.mjs` -> core `GraphBuilder` + `saveGraph` (the last step is spike glue, not an upstream script). The file is what `.ua/knowledge-graph.json` contained.
- Shape: `version: "1.0.0"`, `project`, `nodes` (types seen: `file`, `function`), `edges` (types seen: `imports`, `contains`), empty `layers` and `tour` (those need the LLM stages and were not exercised). `summary`, `tags` and `complexity` are placeholders (`""`, `[]`, `"simple"`); `project.analyzedAt` is the capture time and `gitCommitHash` is the dummy `0000000`.
- Node ids are `file:<posix path>` and `function:<posix path>:<name>`; no Windows path separators were observed on any OS.
