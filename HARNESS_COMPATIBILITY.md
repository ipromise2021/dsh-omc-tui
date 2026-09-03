# DSH TUI · Harness 兼容性契约

本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生终端 projection layer，不是独立 Agent runtime。TUI 可以自主管理终端渲染和即时交互；所有可影响 Agent、会话、工具或持久化配置的功能，必须以 Harness 官方服务和 durable event 为真相源。

## 规则

1. Agent 业务状态不在 TUI 复制：会话、运行状态、权限、模型、任务、技能与配置均从 Harness 读取。
2. 业务写入走官方 API：不要由 TUI 直接篡改 session log、权限状态、模型状态或 Harness 配置文件。
3. durable event 是可重放状态的依据：恢复会话时，应由事件重建 UI，而不是使用未持久化的内存缓存猜测状态。
4. 可选服务须 capability-detect：服务未挂载时显示明确提示或关闭该入口，不能静默伪造结果。
5. Harness 仍为 developer preview：依赖基线为 [`@deepseek-ai/dsh@0.1.2-rc.1`](https://www.npmjs.com/package/@deepseek-ai/dsh)；截至 2026-09-03，该版本位于 npm `next`，默认 `latest` 仍是 `0.1.1-rc.2`。已复核 Session、权限、附件、Agent、Jobs、命令和 preset 源码契约。每次升级后，仍须复核 patch、注入服务、命令签名、事件 payload，并运行真实 Profile 的图片与 PTY 回归。

## 已适配的 Harness 能力

| TUI 功能 | Harness 适配 | 状态来源 / 写路径 |
| --- | --- | --- |
| 创建、恢复和提交对话 | `ctx.agents`、`ctx.sessions`、`sessionQuery` | `agents.create/resume`、`agent.followup`、durable `session/event`；读取优先使用 rc.1 `snapshotEvents()`，不直接持有 persistence service |
| 流式输出、reasoning、工具调用、usage | `session/event`、`agent/status` | durable 消息/工具/usage 事件与 agent 状态 |
| 模型与 effort | `ctx.llm`、`agentDefaultModel` | `inputModalities` 视觉能力、动态 reasoning efforts、request override、通过 `saveSelection()` 持久化完整默认模型与 effort 选择 |
| Agent preset 与 plan/build | `agentPresets`、`planMode`、`subagentModelSelection` | preset mount/recompose 与 durable preset/plan 事件；Host 挂载官方 subagent model-selection settings 服务 |
| 权限审批 | `permissionPresets`、`approval/request` | rc.1 `current(session)` / `set(session, name)`、审批回调、durable permission 事件 |
| Slash 命令 | `ctx.commands` | 官方 command registry 的 find/list/execute |
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

## 目前的边界与待验证项

- `/settings` 只保存 TUI 偏好；模型、权限和 preset 均继续由各自的官方服务持久化，不应移入 TUI namespace。
- `/jobs` 的流式输出读取会消费官方单一游标，因此只在用户显式选中任务后读取。
- 插件市场/安装目前**未适配**：TUI 没有 `ctx.plugins` 或 catalog 服务，也不会直接修改 profile manifest。计划中的 `/plugins` 应只做市场发现与确认，并把安装/移除委托给官方 `dsh plugin --profile tui add/remove`；profile 重组后需重启 TUI。
- `/fork`、`/rewind`、会话内全文检索等功能，只有在 Harness 提供稳定 session/checkpoint 合约后才能实现；不能通过截断 durable log 模拟。
- Windows、真实 provider 下的技能发送与长任务生产者仍须做独立 E2E 验证。

## 发布前检查

```sh
dsh --profile tui --dump-config
DSH_HOME=<isolated-home> python3 test/pty-e2e.py
DSH_HOME=<isolated-home> python3 test/pty-interaction.py
DSH_HOME=<isolated-home> python3 test/pty-resume.py
```

任何新增的 Agent-facing 功能都应先在本表新增对应的官方服务、事件和验证项，再实现 UI。
