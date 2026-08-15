# dsh-tui 功能盘点、兼容性与发布路线图

> 最近复核：2026-08-15。当前包为本地开发 bundle；本文件将“已实现”、“Harness 适配边界”和“公开发布条件”分开记录。

## 一、兼容性契约（发布前必须保持）

本项目必须作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的薄 UI 层运行，而不是第二个 Agent runtime。

| 能力 | 正确接入 | 当前状态 |
| --- | --- | --- |
| 会话、流式文本、状态 | `ctx.agents` / `ctx.sessions` 与 durable `session/event`、`agent/status` | 已接入 |
| 模型、effort、预设、权限 | `ctx.llm`、`agentDefaultModel`、`agentPresets`、`permissionPresets`、`planMode` | 已接入 |
| 命令、技能、附件、问卷 | `ctx.commands`、`ctx.skills`、`ctx.attachments`、`ctx.userQuestions` | 已接入 |
| 后台 jobs | `ctx.jobs.list/read/kill/onJobsChanged`；不自行推断进度 | 已接入 |
| 设置 | `ctx.settings` + settings-file namespace；不得自造配置文件 | 未接入 |

规则：业务状态只能来自官方服务或 durable event；TUI 自己只保存光标、滚动、面板、选中项等渲染状态。可选服务必须 feature-detect，缺失时给出明确提示。上游 RC 升级时重新验证 patch、服务注入、事件形状和 PTY 回归；不得用静态 `@deepseek-ai/*` import 破坏 `link:` 安装。

## 二、当前能力（已验证）

- 实际 Harness agent 的流式文本、reasoning/tool-call 草稿、结构化工具结果、回答耗时与 `/recap`；`/clear` 只清本地视图。
- 审批与权限闭环：审批队列、diff 预览与 `Shift+Tab` 三档权限预设。
- 真实服务驱动的 `/model`、`/effort`、`/preset`、`/resume`、`/jobs`、`/mcp`、`/hooks`、`/export`、`/steer` 等命令。
- `/jobs` 可列出、读取和取消官方后台任务；没有通用百分比时展示状态、摘要和输出，不伪造进度条。
- `ask_user_question` 数字键/多选/plan-review 面板；`@` 文件引用、图片粘贴并经 `ctx.attachments` 入库。
- 多行编辑、上下行光标、历史、外部编辑器、鼠标、`?`、slash 与 Ctrl+P 面板；四行 statusline 与活动提示。
- mock bundle 与 PTY 脚本覆盖流式、审批、会话恢复、图片、文件、菜单及功能回归；真实 provider 已做过基础 smoke test。

## 三、DSH Hub 对照结论

DSH Hub 当前是公开 GitHub 仓库的发现与安装目录：提交入口只要求公开仓库 URL，条目从仓库提取 README、许可证、包名、版本、安装命令与兼容性信息。当前目录中 `dsh-cc-tui` 和 `dsh-tianshu-tui` 都以 `dsh plugin ... add github:<owner>/<repo>` 形式安装；后者明确声明 DSH `0.1.0-rc.6` 兼容版本、LICENSE 和测试入口。

本项目的 bundle 结构、`dsh.bundle.patch` 和 peer dependency 对齐方式符合 Harness 的本地安装模式；但它仍是私有开发包，尚不满足可公开收录的交付质量。不要为了追平竞品把纯展示层做成第二套 runtime：应学习其“可复现安装、明确版本、公开许可证、截图/说明、测试与来源声明”，而不是盲目复制动画、复杂布局或不稳定的会话改写功能。

## 四、发布计划

### P0：公开收录前阻断项

- [ ] 确定公开 GitHub 仓库和最终包名；将 README 的本地路径替换为 `github:<owner>/<repo>` 安装命令。
- [ ] 选择并加入 LICENSE；若 package 使用 `files` 白名单，连同 `LICENSE` 一并打包。
- [ ] 从 `package.json` 移除 `private: true`（仅在准备 npm 发布时）；若只走 GitHub 安装，也要保留清晰的版本和仓库元数据。
- [ ] 写明支持的 `@deepseek-ai/dsh` RC 版本与升级策略，提供 `--dump-config`、mock 安装及完整 PTY 测试命令。
- [ ] 在干净 `DSH_HOME` 做 GitHub 安装验收：安装、启动、`--dump-config`、mock PTY、卸载/重装。
- [ ] 提交公开 GitHub URL 到 DSH Hub；该站当前未显示必须 `dsh-plugin` topic 的硬性要求，topic 可作为发现性增强而非发布阻断。

### P1：下一个适配迭代

- [ ] 接入官方 `ctx.settings` / settings-file：先注册命名空间和默认值，再做 `/settings` 面板；无服务时降级为只读说明。
- [ ] 为 jobs 补一个真实生产者 E2E，验证输出单一游标、取消、结束状态和长输出的交互语义。
- [ ] CI 矩阵固定当前 RC，并设置一条 `@deepseek-ai/dsh@latest` 预检；RC 变更先报告契约差异再升级。
- [ ] Windows 兼容性审查与实际 PTY 验证（路径、PowerShell、raw mode、图片协议降级）。
- [ ] 真实 provider 手动验证技能回填、preset 差异与 settings 保存；测试不得读取或打印凭据。

### P2：用户价值明确后再做

- [ ] 会话内全文搜索、消息选择与更多会话管理；只使用官方 session/query 能力，不能通过本地截断篡改 durable log。
- [ ] 图片终端内联预览或发送前压缩；先保持 attachment ref 与原图语义正确。
- [ ] `/fork` / `/rewind` 仅在 Harness 提供稳定的 session/checkpoint 契约后实施；否则不要伪造回退。
- [ ] 性能基准和长会话渲染策略；出现可测量瓶颈后再考虑虚拟化。

### 不作为目标

- 不 fork OpenCode，也不复制 Web host。
- 不将像素动画、皮肤中心、TPS 仪表作为兼容性工作；它们可以是独立的可选 UI 增强。
- 不添加脱离 Harness 的模型、权限、任务或 settings 状态机。

## 五、可对外说明的差异化

- 纯 ANSI、键盘优先且不依赖 Web UI；直接消费 Harness 会话与服务。
- 无凭据 mock bundle + PTY 回归链，覆盖审批、附件、问卷、会话与 jobs 基础交互。
- 审批 diff 预览、工具结果结构化、图片粘贴协议解析、模型原位切换。
- 所有能力以 Harness 适配为优先级，RC 变更可通过明确的契约检查发现，而非静默漂移。
