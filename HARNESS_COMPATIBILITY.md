# DSH TUI · Harness 兼容性契约

本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生终端 projection layer，不是独立 Agent runtime。TUI 可以自主管理终端渲染和即时交互；所有可影响 Agent、会话、工具或持久化配置的功能，必须以 Harness 官方服务和 durable event 为真相源。

## 规则

1. Agent 业务状态不在 TUI 复制：会话、运行状态、权限、模型、任务、技能与配置均从 Harness 读取。
2. 业务写入走官方 API：不要由 TUI 直接篡改 session log、权限状态、模型状态或 Harness 配置文件。
3. durable event 是可重放状态的依据：恢复会话时，应由事件重建 UI，而不是使用未持久化的内存缓存猜测状态。
4. 可选服务须 capability-detect：服务未挂载时显示明确提示或关闭该入口，不能静默伪造结果。
5. Harness 仍为 developer preview：当前源码的依赖基线为 [`@deepseek-ai/dsh@0.2.0-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh)。Session V4 的迁移由 Harness 负责，TUI 只经 `snapshotEvents()` 和 `sessionQuery` 投影；工具失败兼容读取 `message.isError` 与 `error.reason`，持久化生命周期由 `ctx.agents.create/resume()` 返回的 handle 管理。每次升级后，仍须复核 patch、注入服务、命令签名、事件 payload，并运行真实 Profile 的图片与 PTY 回归。

## 已适配的 Harness 能力

| TUI 功能 | Harness 适配 | 状态来源 / 写路径 |
| --- | --- | --- |
| 创建、恢复和提交对话 | `ctx.agents`、`ctx.sessions`、`sessionQuery` | `agents.create/resume`、`agent.followup`、durable `session/event`；读取使用官方 `snapshotEvents()`，不直接持有 persistence service |
| 流式输出、reasoning、工具调用、usage | `session/event`、`agent/status` | durable 消息/工具/usage 事件与 agent 状态 |
| 模型与 effort | `ctx.llm`、`agentDefaultModel` | `inputModalities` 视觉能力、动态 reasoning efforts、request override、通过 `saveSelection()` 持久化完整默认模型与 effort 选择 |
| Agent preset 与 plan/build | `agentPresets`、`planMode`、`subagentModelSelection` | preset mount/recompose 与 durable preset/plan 事件；Host 挂载官方 subagent model-selection settings 服务 |
| 权限审批 | `permissionPresets`、`approval/request` | rc.1 `current(session)` / `set(session, name)`、审批回调、durable permission 事件 |
| Slash 命令 | `ctx.commands` | 官方 command registry 的 find/list/execute |
| 上下文压缩 | `ctx.compaction`（`compaction-basic`）与官方 `/compact` | 阈值压力压缩在 `agent/pre-step` 内自动执行并继续当前回合（`thresholdRatio` 默认 0.8，保留原文尾部）；TUI 只投影 `compaction/start`、`compaction/summary`、`compaction/end`，不自行改写会话历史 |
| Skills | `ctx.skills` | 官方 skill registry；技能选择仅回填输入，由 Harness tool 注入 |
| 图片附件 | `ctx.attachments` | 粘贴时 `validateImage`；普通消息提交时批量 `saveImages`，命令图片由 registry admission 负责；durable ref 不携带 base64/本地路径 |
| 问卷 | `ctx.userQuestions` + `dsh-tool-ask-user` | TUI 注册 provider，支持选项、`custom` 自由文本和多行回答 |
| 后台任务 | `ctx.jobs` | list/read/kill/onJobsChanged；归一化 bash、subagent、workflow 等任务快照，不自行制造百分比进度 |
| 图片命令 | `ctx.commands` + `ctx.attachments` | 以新版 `execute(agent, line, images, signal)` 传递 `/goal`、官方 `/plan` 等命令图片附件；准入失败保留 composer draft |
| TUI 设置 | `ctx.settings` / settings-file | `dsh-omc-tui` namespace，主题与输入历史偏好持久化到 `$DSH_HOME/settings.yaml` |

Reasoning effort 必须来自具体模型的 `reasoning.efforts` 元数据。官方适配器可直接提供能力；第三方中转或本地反向代理无法暴露该元数据时，由用户在 `models[].reasoningEfforts` 中声明选择 ID 到网关值的映射。元数据缺失时使用 Provider 默认行为，TUI 显示 `PROVIDER`，不生成或发送猜测档位；能力查询本身失败时则显示真实诊断。

用户确认 effort 后，TUI 将当前 provider、model 与规范化 effort ID 作为一份完整选择交给 `agentDefaultModel.saveSelection()`。内存状态只在 Harness 设置写入成功后更新，因此新会话可通过 `currentSelection()` 恢复相同档位，写入失败也不会造成界面状态与持久化配置分叉。直接命令输入必须先匹配当前模型声明的 effort；无效值不会持久化。选择不支持 reasoning effort 的模型时，通过省略 `reasoningEffort` 的完整保存清除旧覆盖值。

## 允许保留在 TUI 本地的内容

- ANSI 主题渲染、终端尺寸、光标、选区、滚动位置、动画和当前面板选中项。
- 输入框的即时编辑状态：未提交文本、换行、历史搜索 query、文件菜单筛选与待发送附件列表。
- 仅供展示的折叠状态，例如 reasoning/tool 结果是否展开。
- 本地输入历史缓存文件；它不等同于 Harness 会话，也不影响模型上下文。

这些本地状态不得被表述为 Agent 的真实状态；重启或恢复会话后可丢失或重新计算。

## 会话恢复的读取成本与 TUI 的应对

官方 `sessionQuery` 的三个接口在成本上差异极大，恢复路径必须按成本选择：

| 接口 | 底层读取 | 实测成本 |
| :--- | :--- | :--- |
| `listSessions()` / `readSession(id)` | 枚举**全部项目**的会话（逐个开日志、解压首个 zstd 帧取 header、再 stat） | 随语料线性增长，451 个会话时**每次约 8–11 秒** |
| `agents.resume({ resumeSessionId })` | 经 `persistence.open(id)` → `findLog()` 只扫**一个项目目录**，再直读该会话日志 | 单会话 **84–458ms** |
| 首屏投影 | 只排版事件流的尾部（预览窗口） | **13–46ms** |

因此本轮做了三处调整：

- `/resume` 与 `-c` 在 `agents.resume()` 的 setup 中投影已加载的会话事件，最后一次 `agent-preset/selected` 优先于创建时的 `SessionHeader.agentPreset`；无选择事件才使用 header 或默认 preset。其他客户端可以在空会话中修改 preset，因此不能只信任创建时的 header。旧会话也不再为读取 preset 额外调用 `readSession(id)`。
- `/resume` 列表与 `-c` 的 `findResumeRecord()` 共用一个进程内列表缓存（TTL 5 分钟，支持 `force`），避免来回切换每次重新枚举。官方 `listSessions()` 包含活跃会话，因此每次读取缓存都通过官方 `sessions.list()` 核对 live 状态。旧会话成功 flush 后更新其持久化元数据、清除旧标题缓存；flush 失败或没有持久化监听器时让下次官方查询重新确认。当前会话不会进入恢复列表，新建后退出的会话也能立即出现。
- 首屏只投影事件流尾部，更早内容在滚到顶部时按需载入；`preset-read` 从 1.6–14.7 秒降至 0ms，恢复总耗时从 10–21 秒降至 109–436ms。

仍未消除的部分：`listSessions()` 首次枚举的固有成本（随会话总数增长）。官方没有"按 cwd 列举"或"按 id 直读"的会话查询接口，TUI 只能减少调用次数，不能改变实现。

## 目前的边界与待验证项

- `/settings` 只保存 TUI 偏好；模型、权限和 preset 均继续由各自的官方服务持久化，不应移入 TUI namespace。
- 压缩阈值由 profile 的 `compaction-basic.thresholdRatio` 决定（本插件 patch 显式设为 0.8），TUI 的 `contextCriticalAt` 只控制状态栏告警配色；`autoCompact` 仅是未挂载官方压缩引擎时的回退开关。
- `/jobs` 的流式输出读取会消费官方单一游标，因此只在用户显式选中任务后读取。
- 插件市场/安装目前**未适配**：TUI 没有 `ctx.plugins` 或 catalog 服务，也不会直接修改 profile manifest。计划中的 `/plugins` 应只做市场发现与确认，并把安装/移除委托给官方 `dsh plugin --profile tui add/remove`；profile 重组后需重启 TUI。
- `/fork`、`/rewind`、会话内全文检索等功能，只有在 Harness 提供稳定 session/checkpoint 合约后才能实现；不能通过截断 durable log 模拟。
- Windows、真实 provider 下的技能发送与长任务生产者仍须做独立 E2E 验证。
- TUI Profile 已关闭不需要的 HMR。生产 Chrome MCP 保持启用，启动包装器对首次 `tools/list` 的 JSON-RPC 回应设置 10 秒期限；超时后终止子进程，再由 Harness 的重连机制处理。隔离 mock Profile 的 `agentDefaultModel.saveSelection()` 和模型变体选择 PTY 回归通过；2026-10-05 用户确认，真实 Provider 与 Chrome MCP 同时启用时，模型切换可以保存。这项手动验收覆盖模型切换保存，不代表已覆盖所有 Provider、重启持久化或长期断连场景。

## 发布前检查

```sh
dsh --profile tui --dump-config
DSH_HOME=<isolated-home> python3 test/pty-e2e.py
DSH_HOME=<isolated-home> python3 test/pty-interaction.py
DSH_HOME=<isolated-home> python3 test/pty-resume.py
```

任何新增的 Agent-facing 功能都应先在本表新增对应的官方服务、事件和验证项，再实现 UI。
