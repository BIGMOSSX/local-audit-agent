# Step 7-8 引擎适配：退出核对记录

范围：代码理解引擎（§112）与质量引擎（§113）的适配、沙箱、EngineService 编排。
状态标记：DONE（有证据）/ PARTIAL（部分完成，写明缺口）/ OPEN（未做或未证明）。
本文只记录已经验证的事实；没有跑过的平台与环境一律标 OPEN，不推测。

## 1. §112 代码理解退出核对

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 变更文件、直接依赖、受影响模块、影响证据 | DONE（引擎层） | `packages/engine-code-intelligence/test/impact.test.ts`（`computeImpact`，一跳影响分析）；`engine.test.ts` |
| 业务域推断 | OPEN | 需要模型步骤；`businessDomain` 恒为 `null` |
| 从界面可达 | OPEN | 没有 `audit.plan` / `audit.run`（R5）；EngineService 未注册到 `handlers.ts`，没有 IPC 方法，`IPC_METHODS` 与 `ALLOWED_METHODS` 各 17 个不变 |
| 依赖图映射（第三方图输出 → 影响上下文） | DONE（映射层） | `packages/engine-code-intelligence/test/ua.test.ts`：捕获夹具、过滤、边方向与截断、恶意输入不抛错 |
| 依赖图执行宿主 | OPEN | 见下文 |

任务 1（UA 可行性）：结论 GO-with-trim，CI run 36812434905，提交 01d7548（分支 spike/understand-anything）。

UA 执行宿主为 OPEN，具体缺少：
- `tools.install`（运行时按需拉取，绝不随包分发）；
- 在沙箱内执行；
- 读回 `.ua/` 产物；
- 把 `mapUaGraph().truncated` 转成“部分完成/未完成”的说明（目前映射层给出标志，但没有任何调用方消费它）。

UA 的规模风险：裁剪后体积未证明（估算约 51.6 MB，未裁剪 368.7 MB，E5）；macOS 上的 OS 级阻断未证明。

端到端覆盖：`engine-service.test.ts` 中“real engines: code intelligence feeds impact to the quality engine, all on the sandbox copy”使用的是测试里注入的手写夹具图，不涉及 UA。生产环境中，在 UA 执行宿主存在之前没有任何代码会构造依赖图，所以代码理解引擎会报告“不适用”。

## 2. §113 质量退出核对

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 检测测试框架 | DONE | `engine-quality/test/frameworks.test.ts` |
| 运行现有测试 | OPEN | 测试执行默认关闭（R6，§16 同意）；`runEngine` 在无同意时跳过 run-tests 任务，`engine-service.test.ts`“without consent, a run-tests task is skipped and the result is partial”；界面无路径（R5） |
| 失败分析 | OPEN | 依赖测试执行 |
| 识别缺失测试路径 | DONE（启发式，置信度低） | `engine-quality/test/coverage-gap.test.ts` |
| 规范化 Finding | DONE | audit-core 契约套件 `contract.test.ts`、`finding.test.ts` |
| 质量引擎外部工具映射 | DONE（仅覆盖率） | `engine-quality/test/aqe.test.ts`、`engine.test.ts`“measured coverage task” |

映射的真实范围：
- 只使用覆盖率这一个工具，且只采信“实测”覆盖率；“估算”覆盖率不产生任何 Finding，只留下一条“已跳过”说明。
- 其余工具不被使用：`quality_assess` 只能评估 cwd；`code_index` 报告 0 个文件；`defect_predict` 没有发现；`test_generate_enhanced` 返回的是固定名称。
- 探测证据：run 36819302596（分支 spike/agentic-qe-contract，tip 124e7fd，Linux ubuntu-latest，Node 24.21.0，agentic-qe 3.14.6）。夹具取自 Linux runner 的输出；该夹具 README 记录 macOS 与 Windows 的运行返回了相同的结构（字节数仅因路径长度不同）。均为 GitHub Actions 临时 runner，没有在真实开发者机器上运行；只抓取了 60 个文件的夹具。

质量引擎宿主配置：`qualityEngineHostConfig(entry)` 的 `allowedTools` 来自 `AQE_ALLOWED_TOOLS`。`AQE_COVERAGE_NO_EXEC=1` 不再由质量引擎配置携带，而是 `buildChildEnv` 固定块的一部分，对每个引擎宿主的子进程无条件生效（配置里没有 `env` 时同样如此）。`McpEngineConfig.env` 在 `buildChildEnv` 之后合并，且保留键（沙箱变量、加载器钩子）一律拒绝，不能覆盖。测试：`sandbox-env.test.ts`（固定块含 `AQE_COVERAGE_NO_EXEC`）；`engine-service.test.ts`“AQE_COVERAGE_NO_EXEC=1 reaches every host's child, with and without a config env”、“extra env cannot override the sandbox's own variables, and loader hooks are refused before any spawn”。

## 3. 明确保持开放的退出标准（R3）

- 质量引擎的 Tauri 打包：OPEN。
- 原生模块与体积影响：OPEN。
- 干净机器（无 Node、无工具链）在 macOS 与 Windows 上运行：OPEN。
- 桌面“打开文件夹”在真实 macOS / Windows 上：OPEN。
- Windows 命名管道 ACL：OPEN。
- Step 6.5 打包：OPEN。
- 干净机器验收标准：OPEN。
- 未注册任何真实引擎、未安装任何真实工具、无 UA 执行宿主；本任务没有运行任何第三方代码（测试只使用本仓库的假 MCP 服务器和本仓库引擎）。
- macOS 与 Windows 的 CI 运行：已完成，不再开放。任务 5–10 的代码与 Rust 作业已在 macOS 与 Windows 的 GitHub Actions 上运行，run 36841810710（提交 291b725）五个作业全部通过（见第 6 节）。但这不等于这些平台上的行为已验证，下面仍未验证：
  - auditd 中 33 个在 Windows 上 `skipIf(win32)` 的测试没有在 Windows 上运行（分组与原因见第 6 节）。
  - macOS 的 pf、Windows 与 macOS 上引擎的网络封锁（第 4 节）没有有效证据。
  - 质量引擎适配器中 8.3 短名与长名的路径写法没有处理，也没有测试。
  - M1（同步 `taskkill` 阻塞事件循环）仍搁置。
  - 真实桌面 / §111 手工检查清单没有执行。
  - UA 执行宿主不存在。

已知并有意搁置的小项（未修复，不是已解决）：
- M1：Windows 上同步的 `taskkill` 最长会阻塞事件循环 5 秒。
- M3：notDone 与任务标题中中英文混用；显示名称的统一属于 Orchestrator / UI 阶段。
- M6：无人使用的公开接口（`runProcess`、`McpClient.listTools`）。

已知缺口（未修复；注册生产引擎的人必须处理）：
- `deps.engines` 为空列表时，`run` 返回 `complete` 且没有任何 notDone，与“不适用的引擎”同类问题（没检查任何东西却显示完成）。
- 非法或超出上限（5000）的 `changedFiles` 被静默丢弃，没有 notDone：只含非法路径的“按变更范围”请求会退化为整库扫描而没有任何说明；并且 `engine.impact()` 仍收到原始（未清理的）列表。

## 4. 沙箱与执行限制（逐条，不弱化）

网络与平台
- 没有 OS 级断网（R4）。依赖的是环境变量白名单与引擎自身行为。
- 网络阻断证据按探测分别记录，二者不可互相替代：
  - UA 可行性探测（run 36812434905）：Linux `unshare -n` 已验证（封锁期 ENETUNREACH，之前与之后均可连通）；Windows `netsh` 规则已验证（封锁期 EACCES，之前与之后均可连通；该规则只覆盖 node.exe）；macOS 的 pf 未验证（验证包装失败，封锁期没有有效观测）。三个平台的 hook 连接数均为 0，正向对照命中数均 ≥ 1。详见 `docs/architecture/engine-feasibility-understand-anything.md`。
  - 质量引擎契约抓取（run 36819302596，夹具 README `packages/engine-quality/test/fixtures/aqe-captured/README.md`）：README 记录 Linux 上用 `unshare -n` 做了 OS 级封锁，connect 级钩子看到 0 次非回环连接、0 个子进程、0 次写入项目；macOS 的 `pfctl` 包装没有生效，Windows 已拒绝对照连接，所以只有 Linux 有有效的阻断证据。该 README 没有记录“真实连接确实会被该钩子捕获”的正向对照（未记载，不等于没有）。
  - 质量引擎较早的可行性探测（run 36733890926、36735103799、36735813279，见 `docs/architecture/engine-feasibility-agentic-qe.md` 的“网络与副作用”）：通过 `NODE_OPTIONS=--require netlog.cjs` 在进程内猴子补丁 `net.Socket.connect`、`dns.lookup`、`child_process`，没有“真实连接确实会被捕获”的正向对照；非 node 子进程与 worker 线程不在覆盖范围，安装阶段也没有被记录。因此它只说明“这些命令没有被观察到联网”，不证明不联网；代码中仍存在联网路径（同一文档列出）。
- Windows 没有 Job Object，正常退出的父进程会留下孤儿孙进程。

进程回收
- `setsid` / `setpgid` 可以逃出进程组击杀。
- 等待进程组消失的时间上限为 2 秒；`EPERM` 视为已消失。
- 残余风险：宿主关闭的等待上限为 2 秒，短于 `proc.done`（进程组等待加 stdio 排空）。关闭超时后，stderr 尾部可能不完整，且沙箱清理可能在进程组清扫仍在进行时开始。
- 强杀（硬终止）时，脱离的孙进程会成为孤儿。
- 超时仍会杀掉守护进程（R9）：已在 `apps/desktop/src-tauri/src/sidecar.rs` 核实，IO 超时时执行 `discard`。

复制与隔离
- 不遵守 `.gitignore` / `.auditignore`，只做 R13 按名称的排除；`secrets.*`、`credentials*` 文件被过度排除。
- 命名奇怪的文件里的密钥仍会被复制进沙箱。
- 只读副本不是安全边界。

脱敏
- `redactSecrets` 已知缺口：JSON 嵌套 3 层及以上。`sk-` 一项已基本关闭：紧跟下划线或其他非字母数字字符的 `sk-` 密钥现在会被遮盖（提交 6baf5a1，`packages/shared/test/redact.test.ts`），仍未覆盖的只有与字母数字直接粘连的形式（如 `xsk-…`）；`task-…`、`risk-…` 一类普通单词刻意不处理。
- `runEngine` 会把 notDone 文本截断到 300 字符。EngineService 现在在把引擎交给 `runEngine` 之前先包装引擎与 ToolHost：detect/plan/execute/normalize 抛出的错误、`ToolHost.call` 的拒绝、以及 `execute` 结果里的 `note`，都先经 `redactSecrets` + `sanitizeEngineText`（上限 2000 字符，先于 300 字符截断）再重新抛出，因此跨越截断点的密钥已被整体遮盖。原有的事后脱敏保留作为纵深防御。`normalize` 产出的候选 Finding 的文本字段（标题、消息、修复建议、验证步骤）同样在进入 `runEngine` 之前脱敏；字段清单由 audit-core 的 `mapFindingText` 统一给出，`runEngine` 的清理器与服务共用。引擎推导出的影响上下文（`businessDomain`、证据文本）在写入 `ServiceResult.impact` 之前也经同样的脱敏，路径、数字与标识保持不变。测试：`engine-service.test.ts`“a secret straddling runEngine's 300-char cut…”（抛出的消息）与“…in a result note, or in a tool-call rejection…”；去掉包装后两者失败。
- stderr 尾部在脱敏之前先按字节裁剪到 64 KiB，因此起点位于裁剪点之前的密钥会丢失其 `api_key=` 一类前缀，模式脱敏可能漏掉它（已配置的字面量密钥仍会被遮盖）。
- 来自 MCP 服务器的错误文本只做脱敏和净化，没有过滤上游工具/厂商名称，名称过滤只对网站表面有硬性要求，本文件与日志不属于网站表面。

质量引擎外部工具的行为
- 在其 cwd（即沙箱，之后丢弃）写入 `.agentic-qe/results`。
- 把每个工具都标注为 destructive / open-world。
- 需要 `AQE_COVERAGE_NO_EXEC=1`，否则覆盖率工具会执行项目测试。
- `quality_assess` 无法评估 cwd 以外的项目。
- 响应约 100 KB / 60 个文件；解析文本上限 4 MiB，因此很大的项目会得到“结果不可读”的说明。目前只抓取了 60 个文件的夹具，大项目行为未验证。

UA
- `tools.install` 时拉取，永不随包分发；结论 GO-with-trim；裁剪后体积（E5）未证明；macOS OS 阻断未证明。

功能面
- 测试执行关闭（R6；§16 同意）；没有 UI 路径（无 `audit.plan` / `audit.run`，R5）。

## 5. 安全评审记录

已核对并有测试支撑：
- 子进程环境为白名单：`sandbox-env.test.ts`（不继承父进程密钥、HOME/TMP 指向沙箱、额外键必须在白名单内、白名单不含像密钥的名称）。
- 工具白名单在写入之前强制：`sandbox-mcp-client.test.ts`；`engine-service.test.ts`“refuses a tool that is not on the allowlist”。
- stderr 排空与脱敏：`sandbox-mcp-client.test.ts`；`engine-service.test.ts`“logs the engine's stderr tail after it exited…”、“a noisy engine's log line is capped…”（先关闭宿主并有界等待退出，再读取尾部，再记录；脱敏包含 `secrets` 字面量；输出经净化并设上限）。
- 取消后不再启动后续引擎：每个引擎开始前检查 `signal.aborted`，已取消则只记一条 notDone，不调用 `impact`、`hostFor`，不派生进程（`engine-service.test.ts`“an abort during engine 1 stops engine 2…”；去掉检查后该测试失败）。
- 所有离开服务的文本（notDone、McpServerError、日志行）都经 `redactSecrets` + `sanitizeEngineText`：`engine-service.test.ts`“redacts secrets in notDone text…”、“strips hidden characters…”、“redacts and sanitizes server-supplied error text (McpServerError)”、“a host factory that throws becomes a notDone with no secret…”。
- 沙箱：排除与符号链接替换：`sandbox-workspace.test.ts`；EngineService 对 `too_large`、`io`、抛错、中止、关闭失败都会清理沙箱（`engine-service.test.ts` 相应用例，使用私有 TMPDIR 观察残留）。
- 引擎只看到沙箱副本，真实项目不被修改：“engines are given the sandbox copy, never the real project”、“does not modify the real project”。
- `projectDir` 为 realpath：沙箱根在创建后做 realpath，符号链接临时根下的测试覆盖（去掉修复后该测试失败，已做变异验证）。
- 中止：中止监听器关闭宿主，之后移除；用真实假 MCP 服务器和永不应答的工具验证快速结束、部分结果、`liveChildCount() === 0`、沙箱被删除（去掉监听器后该测试失败，已做变异验证）。已中止的运行不创建沙箱和宿主。
- `run` 永不抛错；EngineService 未被 `handlers.ts` 导入（测试“is not reachable through IPC”）；`pnpm check:policy` 通过，17 个方法对等性不变。
- `startMcpHost` 端到端：echo 可用；noisy 给出有界且已脱敏的尾部；关闭后无子进程；握手失败后无子进程。
- 仅 POSIX 的用例用 `it.skipIf(process.platform === "win32")`。

加固（Task 13 与最终修复）：
- 抛出值不是 Error 的情况（含空原型对象）不会让服务本身抛错：错误文本提取带保护。
- `runEngine`：id 相同但内容不同的 Finding 保留先出现的一条，并记一条 notDone（完全相同的重复静默丢弃）；声称属于其他引擎的 Finding 被丢弃并记一条 notDone。（`packages/audit-core/test/run-engine.test.ts`）
- 服务端对规范化后的 Finding 文本和影响上下文做脱敏（见第 4 节）。
- 不适用的引擎现在记为 notDone（`<id>: 全部检查`，原因“不适用于此项目”），因此什么都没检查的运行是 `partial`，不再显示 `complete`；`ServiceResult.engines` 给出每个引擎的 `{id, applicable, tasks}`，任务只含 id 与状态。
- 调用方传入的 `changedFiles` 先经 `RepoPathSchema` 校验并去重，即使没有任何引擎能计算影响图，也会作为影响上下文的变更范围。
- `AQE_COVERAGE_NO_EXEC=1` 是每个子进程环境的固定部分。
- 在 MCP 握手期间中止会立即结束子进程，而不是等到握手超时；已中止的信号不会启动宿主。
- 超过 10 MiB 而未被复制进沙箱的文件会产生一条 notDone（“超大文件”）。
- 沙箱子进程的 `APPDATA`、`LOCALAPPDATA`、`XDG_*` 路径用 `path.join` 生成，对应目录在创建沙箱时一并创建（权限 0700）。
- 测试验证范围：只有中止握手（去掉修复后服务测试超时）与 Rust 字符字面量的 `u` 标志（去掉后天文字符测试失败）两项做过“去掉修复、测试失败”的变异验证；其余新增行为的测试是按推理设计为能区分新旧行为、并覆盖新增代码，没有逐项做变异验证。

## 6. 运行与验证记录

在 Linux 本机，提交 5d4710e 上运行完整门禁 `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:policy`，全部通过（`pnpm test` 汇总；turbo 缓存命中的包沿用先前同源码的结果）：

| 包 | 测试 |
| --- | --- |
| @audit/auditd | 335 通过，1 跳过（共 336；含 engine-service 53 个） |
| @audit/audit-core | 110 通过 |
| @audit/engine-quality | 99 通过 |
| @audit/engine-code-intelligence | 78 通过 |
| @audit/desktop | 28 通过 |
| @audit/shared | 21 通过 |
| @audit/design-tokens | 7 通过 |
| @audit/ui | 3 通过 |
| @audit/web | 1 通过 |
| scripts（策略脚本自身） | 198 通过 |

- Rust（`apps/desktop/src-tauri`）：`cargo test` 18 + 10 通过，`cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check` 无告警。
- `pnpm build` 生成 `packages/auditd/dist/main.js`，启动后只输出一行握手；sidecar 测试针对构建产物通过。
- `pnpm check:policy`：全部 ok（含 allowlist-parity、no-updater、capabilities、plugins、rust-surface、no-shell-exec、web-copy）；策略脚本自身的测试为 198 项通过。
- 稳定性记录：一次完整门禁曾因 stderr 尾部断言在高负载下不稳而失败，已改为确定性的小写入用例并在负载下重复 8 次稳定；随后完整门禁通过。已知的 sidecar“two daemons … SQLITE_BUSY”偶发失败已修复（提交 4a36f57）：根因是首次切换 `journal_mode=WAL` 时的 BUSY 不遵守 `busy_timeout`，现在对该错误做带抖动的退避重试；之后又补充识别 BUSY 的扩展结果码（261、517、773）。`SQLITE_LOCKED` 有意不重试（等待无法解除）。该项不再属于“未改动”。

CI 与平台：
- CI run id：36812434905（UA 可行性，ubuntu / macos / windows 三系统矩阵，见 UA 可行性文档）与 36819302596（质量引擎契约抓取，夹具取自 ubuntu-latest；其 README 记录 macOS 与 Windows 的运行返回相同结构），另有质量引擎较早的探测 run 36733890926、36735103799、36735813279。它们是 GitHub Actions 临时 runner 上的可行性探测，不是本任务代码的测试运行，也不是真实开发者机器；macOS 上的 pf 阻断没有证据。
- macOS 与 Windows 上的任务 5–10 代码和 Rust 作业：run 36841810710（提交 291b725）全部通过，五个作业为 node ubuntu / macOS / windows 与 rust macOS / windows。这是 GitHub Actions 临时 runner，不是真实开发者机器。此前三次失败的 run（均由 `gh run view` 的作业结论与日志确认失败）：
  - 36838345577（提交 39577d7）：ubuntu、macOS、windows 的 node 作业失败，两个 rust 作业通过。暴露的问题：质量引擎 100k 条文件列表的“线性时间”测试依赖绝对耗时（macOS 上 `expected 9719 to be less than 8000`，ubuntu 上 5000 ms 超时），改为按规模比例判断（提交 5315ef0）。Windows 上质量引擎测试大面积失败（如 `no task may fail`、`Bad escaped character in JSON`）：测试的重定根辅助函数把带反斜杠的目录直接粘进嵌套的 JSON 文本，适配器的 `toRepoRelative` 也读不了 Windows 的路径写法（盘符与目录大小写、扩展长度前缀 `\\?\`）；提交 727a680 让适配器在所有系统上按字符串读取这些写法（只做 ASCII 大小写折叠，非 ASCII 目录名的大小写不折叠），辅助函数改为解析后重定根再序列化，Windows 写法的测试在所有系统上运行。同一轮之后把 CI 改为 `--continue=always`（900e68f），让一个包失败时其余包仍会运行；auditd 沙箱环境测试对路径分隔符的断言改为接受反斜杠（cd91c99，在 36839555807 之前提交；我没有逐条核对它是在哪一轮的日志里首次出现）。
  - 36839555807（提交 cd91c99）：加上 `--continue` 后，其他包都通过，只剩：所有系统上 engine-code-intelligence 的 `mapUaGraph` 截断测试在 5000 ms 超时，改为文件级 60 秒超时且不依赖耗时（18fa503）；仅 Windows 上 auditd 的 db 锁测试在清理临时目录时 EPERM，改为等待持锁进程退出并让 `cleanupTmp` 带重试删除（aff2d35）；仅 Windows 上 `McpClient` “服务器关闭 stdout 但继续运行”的真实子进程测试超时，该测试现在在 win32 上 `skipIf`，并新增一个在所有系统上运行的假进程测试覆盖同一行为（ca5350e）。
  - 36840785414（提交 ca5350e）：只有 macOS 的 node 作业失败，sandbox-run 的“done 在整个进程组死亡后才完成”测试断言一个已被杀死的孙进程仍然存活。改为用 `isProcessLive` 把僵尸进程（`ps` 状态 Z）视为已死，其他状态仍视为存活，并保留“去掉组击杀后测试必然失败”的变异验证（291b725）。
- 本地门禁在 291b725：auditd 341 通过、1 跳过，engine-quality 109、engine-code-intelligence 78、audit-core 110、shared 21、desktop 28、scripts 198、design-tokens 7、ui 3、web 1，全部通过；`pnpm build`、`pnpm check:policy` 通过（表中的数字是 5d4710e 时的，保留不改）。
- 诊断的证据强度（请按此理解，不要当作已证明）：下面三项诊断都来自 CI 日志与代码、操作系统语义的推理，没有在对应系统上复现。
  - Windows 上 db 锁测试 EPERM：原因判断为 Windows 上 `holder.kill()` 是异步的，持锁进程还没退出，`cleanupTmp` 的 `rmSync` 又没有重试；约 80% 把握。`openDb` 失败时会关闭自己的句柄，所以判断为测试清理问题，不是产品问题。
  - Windows 上 `McpClient` 真实子进程测试超时：判断为夹具问题，libuv 在 Windows 上从不关闭 0–2 号标准描述符，所以真实子进程无法在保持运行的同时关闭自己的 stdout；约 75% 把握。产品代码本来就监听 stdout 的 end/close/error，我也没有把同步 `taskkill` 确认为原因（M1 保持搁置）。在 Linux 上我试过用 `process.stdout._handle.close()` 代替，对方没有看到 EOF，所以没有采用。结果是该真实子进程测试在 Windows 上不再运行，由假进程测试代替。
  - macOS 上进程组测试偶发失败：判断为探测问题，`process.kill(pid, 0)` 对已被杀死但尚未回收的僵尸进程也成功，而 macOS 上进程组列表比 launchd 回收更早不再列出它；约 75–80% 把握，未证明。依据：失败测试耗时 814 ms（超时设为 800 ms），说明等待进程组消失的步骤立即返回，不是撞到 2 秒上限；该测试在上一轮同样代码下通过，所以是偶发。产品代码 `run.ts` 没有改动。如果判断错了，该测试在 macOS 上仍可能偶发失败，下一步是在断言信息里打印 `ps` 状态。
- 仍未在 Windows 上验证的 auditd 测试（33 个 `skipIf(win32)`，Linux 上跳过 1 个；macOS 上 sidecar“会话令牌不出现在进程参数与环境里”因只在 Linux 运行也被跳过）：
  - `logger.test.ts`（2）：目录 0700、日志文件 0600，POSIX 权限位。
  - `db.test.ts`（2）：数据目录 0700、数据库与 WAL 文件 0600，既有数据库收紧到 0600，POSIX 权限位。
  - `server.test.ts`（3）：套接字 0600 且目录 0700、拒绝组/其他可访问的目录、listen 失败时清理目录，POSIX 套接字与权限语义。
  - `endpoint.test.ts`（10）：sun_path 长度（1）与“prepareEndpoint (POSIX)”“disposeEndpoint (POSIX)”两个 describe（9）；Unix 套接字与权限。Windows 命名管道的那一项只在 Windows 运行。
  - `sandbox-run.test.ts`（2）：进程组全部死亡后 `done` 才完成（Windows 的 taskkill 在系统拆除进程前返回）、正常退出父进程留下的孤儿被清扫（Node 在 Windows 没有 Job Object）。
  - `sandbox-workspace.test.ts`（6）：不跟随符号链接、不可读子目录被跳过（root 下也跳过）、副本只读（root 下也跳过）、清理不沿攻击者放置的符号链接 chmod、`makeWritableTree` 不动符号链接目标、`copyRegularFile` 的 TOCTOU 符号链接检查。需要符号链接或 POSIX 权限。
  - `sidecar.test.ts`（2）：经符号链接与真实路径只得一行项目（符号链接）；会话令牌不出现在进程参数与环境里（只在 Linux 运行，读 /proc，所以 macOS 与 Windows 都没有覆盖）。
  - `engine-service.test.ts`（1）：临时根目录是符号链接时引擎看到沙箱的真实路径。
  - `detect.test.ts`（4）：符号链接与其目标算一个项目、`package.json` 是 FIFO 时不阻塞、悬空符号链接、无读权限的文件夹（root 下也跳过）。
  - `sandbox-mcp-client.test.ts`（1）：上面所说的真实子进程 closeout 测试。
  - 因此进程组与孤儿回收、POSIX 权限与套接字、符号链接与 FIFO 处理、sidecar 令牌不出现在 argv 的检查，在 Windows 上没有 CI 覆盖。
