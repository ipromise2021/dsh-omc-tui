# dsh-omc-tui (Oh-My-Claude) 功能盘点、兼容性与发布路线图

> 最近复核：2026-08-15。当前包为本地开发 bundle；本文件将“已实现”、“Harness 适配边界”和“公开发布条件”分开记录。

## 一、兼容性契约（发布前必须保持）

本项目必须作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的薄 UI 层运行，而不是第二个 Agent runtime。

| 能力 | 正确接入 | 当前状态 |
| --- | --- | --- |
| 会话、流式文本、状态 | `ctx.agents` / `ctx.sessions` 与 durable `session/event`、`agent/status` | 已接入 |
| 模型、effort、预设、权限 | `ctx.llm`、`agentDefaultModel`、`agentPresets`、`permissionPresets`、`planMode` | 已接入 |
| 命令、技能、附件、问卷 | `ctx.commands`、`ctx.skills`、`ctx.attachments`、`ctx.userQuestions` | 已接入 |
| 后台 jobs | `ctx.jobs.list/read/kill/onJobsChanged`；不自行推断进度 | 已接入 |
| 设置 | `ctx.settings` + settings-file namespace；不得自造配置文件 | 已接入 |

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

### P1：近期适配迭代（已完成）

- [x] 接入官方 `ctx.settings` / settings-file：注册 `tui` 命名空间 schema，支持主题与状态行密度（`detailed`/`compact`/`minimal`）即时切换与落盘。
- [x] 诊断与全局面板：新增 `/status` 全局诊断看板与 `/context` 占用分布分析。
- [x] 侧边隔离问答：新增 `/ask <问题>`，零上下文污染，保障主任务编码纯净。
- [x] 深度方案审查技能：内置 Matt Pocock 经典 `/grill-me` 架构压力测试技能。
- [x] 视觉与护眼调优：全面采用四阶柔和灰度层级（消除终端白光眩光）与 Claude 暖色调体系，菜单搜索匹配加粗高亮。
- [x] 交互与终端兼容：全面适配 SS3 终端光标方向键（`\x1bOA/B/C/D`）与 `/preset` 交互式单选圆点确认面板。
- [x] `/compact` 与 `/steer` 体验提升：平滑过渡防重入互斥锁与排队消息一键干预提拔。
- [ ] 为 jobs 补一个真实生产者 E2E，验证输出单一游标、取消、结束状态和长输出的交互语义。
- [ ] CI 矩阵固定当前 RC，并设置一条 `@deepseek-ai/dsh@latest` 预检；RC 变更先报告契约差异再升级。
- [ ] Windows 兼容性审查与实际 PTY 验证（路径、PowerShell、raw mode、图片协议降级）。

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

## 六、DSH Hub 插件市场与 TUI 安装计划（调研结论）

### 现状判断

- TUI 当前已经能作为 Harness `dsh.bundle` 被 profile 安装，也能在启动后消费已安装 bundle 提供的命令、技能、工具和服务。
- TUI 当前没有插件 catalog、安装 broker 或 `ctx.plugins` 服务，因此**还没有**在 TUI 内浏览并安装市场插件的功能。
- 官方 `dsh plugin --profile <name> add/remove ...` 是 profile 级 pnpm 委托器；安装后通过 `dsh.bundle.patch` 重新计算 bundle 栈。首版必须要求重启 TUI，不能承诺当前进程热加载。
- DSH Hub（[catalog](https://dshhub.org/#catalog)）可提供发现数据和可复制安装命令，但当前未确认有稳定、版本化的公开 JSON API；不要把 HTML 抓取耦合进核心渲染器。

### 推荐产品形态

将 TUI 定位为“市场前端 + 官方安装委托”，而不是第二个包管理器：

1. `/plugins`（或 `/market`）只读浏览、搜索、分类/兼容性筛选；`Enter` 查看详情。
2. 详情展示来源仓库、固定 revision、包名/版本、许可证、更新时间、星标、兼容性、bundle/服务摘要和风险提示。
3. `i`/`Tab` 进入确认，确认后调用官方 `dsh plugin --profile tui add <source>`；安装输出、退出码和构建脚本提示原样反馈。
4. `/plugins installed` 读取 profile manifest/lock；移除操作同样委托 `dsh plugin ... remove` 并二次确认。
5. 成功后提示“profile 已更新，重启 TUI 后生效”；首版不做进程内动态挂载。

### 分期路线

#### P0：市场发现（无副作用）

- [ ] 定义可替换 catalog adapter 与版本化 schema；优先维护者 JSON 索引，带缓存、TTL、超时、离线和损坏数据降级。
- [ ] 增加 `/plugins` 面板、搜索、筛选、详情、已安装视图和无 catalog 服务时的 capability 提示。
- [ ] 用 mock catalog 与快照/PTY 测试验证窄终端、长描述、无许可证、待验证条目。

#### P1：官方安装委托

- [ ] 增加 host install broker，仅调用 `dsh plugin --profile tui add/remove`，使用结构化 argv，禁止 shell 拼接。
- [ ] 安装前显示来源、revision、许可证、包路径、prepare/allowBuilds 风险并要求显式确认。
- [ ] 捕获 pnpm stdout/stderr/退出码；支持取消、超时、无 pnpm、网络失败和安装失败后的可恢复提示。
- [ ] 成功后标记 profile dirty，提供重启提示；不直接编辑 `package.json`、`cordis.yml` 或 `dsh.profile.bundles`。

#### P2：发布与安全验证

- [ ] 在隔离 `DSH_HOME` 做 npm、GitHub、GitHub 子目录、固定 commit、卸载/重装验收。
- [ ] 验证 profile 隔离、bundle 重排、prepare 脚本 allowBuilds、Windows 路径和第三方代码风险提示。
- [ ] 若 DSH Hub 提供稳定 API，再将其作为默认 adapter；否则维持维护的镜像/索引，不在 TUI 中嵌入脆弱 DOM 抓取。

### 设计约束

- 市场插件是第三方可执行代码，安装是外部副作用；没有来源、许可证或兼容性证据时默认高风险。
- TUI 只管理本地视图与确认状态；profile、依赖和 bundle 真相源始终由官方 dsh CLI/pnpm/Harness 负责。
- 任何新增 Agent-facing 能力，先更新 `HARNESS_COMPATIBILITY.md` 的服务/事件映射，再实现 UI。

## 七、代码架构重构与 DSH / Cordis 规范化方案（已落地）

为彻底符合 DSH 官方仓库规范与 Cordis 插件生命周期规范，已将早期单体式的 `src/index.js` 拆解为高内聚、低耦合的子系统模块化架构：


```
src/
├── core/                  # Cordis 插件装载与生命周期管理
│   ├── plugin.js          # Cordis Plugin 入口 (apply, inject, schema)
│   ├── context.js         # DSH 上下文服务解构与守护
│   └── lifecycle.js       # 终端进程退出、信号捕获与清理
├── renderer/              # ANSI 终端渲染子系统
│   ├── ansi.js            # ANSI 样式 Token、256色 / TrueColor 定义
│   ├── themes.js          # 主题注册表 (claude, deepseek, mono, light)
│   ├── statusline.js      # 状态行三阶密度渲染 (detailed, compact, minimal)
│   ├── markdown.js        # Markdown 轻量语法解析与分词换行渲染
│   └── diff.js            # 行级 unified diff 语法高亮
├── input/                 # 终端键盘与交互捕获
│   ├── tokenizer.js       # 输入分词器 (含 ANSI、SS3 \x1bOA-D、Bracketed Paste)
│   ├── history.js         # 提示词历史持久化与查询
│   └── autocomplete.js    # @ 文件引用与 / 命令自动补全
├── panels/                # 浮层交互面板控制器
│   ├── base.js            # 面板通用状态与滚动槽位逻辑
│   ├── preset-picker.js   # Agent Preset 选择与二次确认面板
│   ├── model-picker.js    # 模型与推理档位面板
│   ├── skills-panel.js    # 技能与生态面板
│   ├── jobs-panel.js      # 后台长任务面板
│   ├── settings-panel.js  # TUI 配置面板
│   └── question-panel.js  # 用户交互问卷 (ask_user_question) 面板
└── commands/              # 本地命令路由与执行器
    ├── registry.js        # 本地命令分发中心
    ├── ask.js             # /ask 临时隔离问答执行器
    ├── compact.js         # /compact 平滑压缩执行器
    ├── status.js          # /status 诊断看板
    └── steer.js           # /steer 消息提升与实时干预
```

### 核心规范要求：
1. **纯粹的 Cordis 依赖注入**：严禁静态导入 `@deepseek-ai/*`，所有平台能力（`agents`、`sessions`、`commands`、`skills`、`llm`、`settings`）统一通过 `inject` 注入；
2. **单一真相源（Single Source of Truth）**：严禁在 UI 层复制会话状态机，所有状态严格源自 Harness durable event 与平台服务；
3. **单元测试与 PTY 双层保障**：各子模块具备独立的单元测试，同时保持全套 PTY 端到端回归测试 100% 通过。
