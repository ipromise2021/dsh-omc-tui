# DSH TUI · Harness 兼容性契约

本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生终端 projection layer，不是独立 Agent runtime。TUI 可以自主管理终端渲染和即时交互；所有可影响 Agent、会话、工具或持久化配置的功能，必须以 Harness 官方服务和 durable event 为真相源。

## 规则

1. Agent 业务状态不在 TUI 复制：会话、运行状态、权限、模型、任务、技能与配置均从 Harness 读取。
2. 业务写入走官方 API：不要由 TUI 直接篡改 session log、权限状态、模型状态或 Harness 配置文件。
3. durable event 是可重放状态的依据：恢复会话时，应由事件重建 UI，而不是使用未持久化的内存缓存猜测状态。
4. 可选服务须 capability-detect：服务未挂载时显示明确提示或关闭该入口，不能静默伪造结果。
5. Harness 仍为 developer preview：每次升级 `@deepseek-ai/dsh` 后，须复核 patch、注入服务、事件 payload，并运行 mock/PTy 回归。

## 已适配的 Harness 能力

| TUI 功能 | Harness 适配 | 状态来源 / 写路径 |
| --- | --- | --- |
| 创建、恢复和提交对话 | `ctx.agents`、`ctx.sessions`、`sessionPersistence`、`sessionQuery` | `agents.create/resume`、`agent.followup`、durable `session/event` |
| 流式输出、reasoning、工具调用、usage | `session/event`、`agent/status` | durable 消息/工具/usage 事件与 agent 状态 |
| 模型与 effort | `ctx.llm`、`agentDefaultModel` | 模型列表/信息、request override、默认模型选择 |
| Agent preset 与 plan/build | `agentPresets`、`planMode` | preset mount/recompose 与 durable preset/plan 事件 |
| 权限审批 | `permissionPresets`、`approval/request` | 预设服务、审批回调、durable permission 事件 |
| Slash 命令 | `ctx.commands` | 官方 command registry 的 find/list/execute |
| Skills | `ctx.skills` | 官方 skill registry；技能选择仅回填输入，由 Harness tool 注入 |
| 图片附件 | `ctx.attachments` | `saveImage` 生成官方 attachment ref，再随消息提交 |
| 问卷 | `ctx.userQuestions` + `dsh-tool-ask-user` | TUI 注册 provider，回答交由官方工具回合继续处理 |
| 后台任务 | `ctx.jobs` | list/read/kill/onJobsChanged；不自行制造百分比进度 |
| TUI 设置 | `ctx.settings` / settings-file | `dsh-omc-tui` namespace，主题与输入历史偏好持久化到 `$DSH_HOME/settings.yaml` |

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
