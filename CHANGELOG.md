# DSH OMC TUI · 工作记录与变更日志 (Worklog & Changelog)

本文档记录了 `dsh-omc-tui` 的重要问题排查、架构决策、性能优化及视觉体验迭代历史。

---

## 🏷️ 版本记录 (Version History)

| 版本 | 日期 | 说明 |
| :--- | :--- | :--- |
| **v0.2.9** | 2026-09-03 | **DSH v0.1.2-rc.1 兼容适配与交互可靠性升级**。统一使用 rc.1 `snapshotEvents()` 会话快照与 `permissionPresets.current(session)` 权限契约，并保留集中式旧契约回退；补挂 preset 所需的 subagent model-selection Host 服务，移除失效 patch，19 个 DSH peer 对齐 rc.1；真实隔离 Profile 启动、`/status` 与权限轮换通过。同时加入安全会话导出、TUI 版本状态、未知 slash prompt 修复、视觉模型选项标识，以及 Jobs/Shell 输出、取消、竞态和小窗口布局加固。完整上游报告见 `DSH_V0.1.2_RC1_ADAPTATION.md`。 |
| **v0.2.8** | 2026-08-29 | **Reasoning effort 默认选择持久化**。通过 Harness `agentDefaultModel.saveSelection()` 保存完整 provider、model 与 effort，确保新会话恢复已选等级；直接 `/effort <id>` 会按模型能力校验，拒绝持久化无效值；设置写入失败时保持当前模型和 effort 不变。文档同步明确官方 npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 截至 2026-08-29 的 `latest` / `next` 均为 `0.1.1-rc.2`。 |
| **v0.2.7** | 2026-08-29 | **Reasoning effort 能力投影与第三方中转配置增强**。移除能力查询失败时生成的猜测档位，仅接受具体模型通过 Harness `reasoning.efforts` 声明的值；区分“模型未声明能力”与“能力查询失败”，状态栏以 `PROVIDER` 表示沿用模型或网关默认行为；切换模型时过滤不受支持的旧 effort；补充第三方中转和本地反向代理通过 `models[].reasoningEfforts` 自定义映射的文档及 Gemini `low/medium/high` 示例，并增加对应回归测试。 |
| **v0.2.6** | 2026-08-28 | **DSH rc.2 适配、双模态视觉直通与终端输入可靠性升级**。将 18 个 Harness peer 依赖统一提升至 `^0.1.1-rc.2`，复核附件保存、Agent 创建与 durable `session/event` 契约；新增 `resolveModelVisionSupport` 双模态分流引擎，原生视觉模型直传 image content block，纯文本模型保持 `analyze_image` Sidecar 路由；新增 `downscaleImageBuffer` 跨平台高分屏缩放引擎及 2048px 安全基准线，保持 MIME、尺寸、base64 与落盘引用一致；纯文本消息不再为模型目录检索阻塞；输入路由完整消费 SGR/X10/URXVT 鼠标报告，避免空闲后协议字节泄漏为乱码；多行粘贴折叠为不可分割占位符，提交时逐字符恢复原文并保护 `$&` 等替换字面量；`Ctrl+L` 仅刷新屏幕并保留上下文，`/clear` 使用 Harness 官方 API 创建新会话并重置上下文；补齐视觉、鼠标、粘贴和会话生命周期回归测试。 |
| **v0.2.5** | 2026-08-26 | **会话历史回顾(/recap)、15分钟空闲自动总结与全景架构文档上线**。新增 `/recap` 内置斜杠命令与 `buildSessionRecapSummary` 历史摘要算法；支持 15 分钟空闲自动生成 `※ recap: ...` 呼吸总结并联动 `/settings` 中 `autoRecap` 开关；会话恢复（-c / /resume）时初始化稳定持久回顾；引入独立 `localId/localKey` 体系与 `appendLocalLogEntry` 限制 200 条上限，彻底杜绝跨整数序号冲突与内存膨胀；完善文件展开异常、取消提交、图片失败、网络异常全生命周期计时器恢复；统一普通模式与备用屏幕的 ANSI.rule 边框样式；新增全景架构设计与全功能实现文档 `ARCHITECTURE.md`，清理过期的临时渲染分析报告。 |
| **v0.2.4** | 2026-08-26 | **模型检索、生命周期加固、Windows 防护与分层转写投影全量闭环**。Model Picker 交互式搜索过滤（简单连续子串匹配、命中高亮、空态与计数提示）；分层转写投影优化（`base + live` 状态感知抑制中间冗余 Turn Header，彻底消除多步思考与工具循环中的标题闪现与重复，仅在回合顶部保留唯一标题）；Windows PowerShell / CMD 危险命令拦截加固（`Remove-Item` / `rm` / `del` / `rd` 等参数缩写、布尔修饰、`\\?\UNC\` 扩展 UNC 共享根与驱动器根目录删除拦截）；Provider 配置事务化写入与数据保真（成功编辑与失败回滚均无损保留 Provider 级扩展属性与模型自定义字段，缺失旧配置时安全中止）；会话生命周期加固（stop 幂等、并发单次释放、ignoreJobErrors 保护与任务失败后重试退出）；followup 失败回滚并保留 Bash 上下文；ScreenRenderer 行尾 SGR reset 防止样式外溢；`/status` 准确识别 `recentInput = 0`。 |
| **v0.2.3** | 2026-08-26 | **模型检索、生命周期加固与 Windows 防护基线**。Model Picker 交互式搜索过滤；Windows PowerShell / CMD 危险命令拦截基线；会话生命周期加固；shell rc 严格 `export` 解析；`/compact` 用量即时刷新、`/clear` alt-screen 感知清屏、`/btw` 旁路代理禁用工具调用；预览用量兜底消除 Context 误报。 |
| **v0.2.2** | 2026-08-26 | **npm 安装方式上线**。发布至 npm registry，README 安装指引改为 npm 包名直装优先（`dsh plugin --profile tui add dsh-omc-tui`），GitHub 源码安装作为备选；无需 pnpm 对 Git 依赖的构建授权步骤。 |
| **v0.2.1** | 2026-08-26 | **危险命令守卫（Danger Guard）上线与加固**。新增 `src/core/danger-guard.js` 原生 watchdog，挂载 Harness `tools/pre-execute` 拦截点与 `ctx.tools.guard()`：结构化 AST/Tokenizer 识别 `rm -rf /`、`chmod -R 777 /`、`git push -f`、`mkfs`/`dd` 直写磁盘、fork 炸弹、`find -delete` 等破坏性命令；支持子 shell 注释感知提取、`sh -c` 引号/粘连载荷、包装命令带值选项解析、ANSI-C 全转义解码与路径规范化逃逸拦截；`.dsh/danger-rules.json` 自定义 block/allow 全段锚定；递归深度与命令长度 fail-closed 保守拦截；会话生命周期全程接管与释放。 |
| **v0.2.0** | 2026-08-26 | **视口投影渲染架构升级与性能优化**。Document + Viewport 纯投影渲染管线（`projectTranscript` → 视口差分重绘与语义锚点）；流式活动状态投影进视口 + 单 spinner 活动 HUD（耗时 / tokens / tok/s / effort 标注）；base 转写缓存 + live 尾流分层合并，流式阶段不再全量重投影；Alt/Meta 导航键回归修复；拖拽选区边缘自动滚动；`autocomplete` 路径穿越防护；会话切换/恢复失败回滚加固；live reasoning 列宽自适应与折叠交互。 |
| **v0.1.1** | 2026-08-25 | **功能与稳定性增强**。新增自主决策 Vision 旁路视觉 Subagent 路由 (`/vision`)；深度集成 Git 与扩展状态的 4 行 Statusline HUD；新增交互式 `/provider` 管理与配置向导；托管专用浏览器生命周期；Shell 模式系统历史与常用命令智能补全；终端 Resize 回放与权限预设多项健壮性修复；文档与快捷启动别名完善。 |
| **v0.1.0** | 2026-08-17 | **首个正式版本标签**。完成从 0 到 1 的开发：Claude Code 级 Markdown 渲染引擎、流式打字机原子单次写入（0 闪烁 / 0 垂直跳跃）、树遍历状态机（Thinking / 工具组自动编排折叠）、行内安全审批、`/btw` 旁路问答、`/compact` 压缩、Bash 直通与后台 Jobs、四款护眼主题 + 四行全景 Statusline、会话恢复极速直出（< 50ms），以及 README / CHANGELOG / Issue 模板文档完善。 |
| v0.1.0-baseline | — | 早期开发基线（初版骨架）。 |

---

## 📝 日常开发记录（2026-08-15 → 08-24）

以下按日期汇总日常开发记录，涉及架构、渲染、交互、视觉、上游适配与文档等方面。每个专题的详细记录见下文各节。

### 📅 2026-08-15 · 初建与集成（3 commits）

- 建立 DeepSeek Harness 原生终端 TUI 骨架（`ef33deb`）；
- Harness 集成打通与工程路线图记录（`2cfe511`、`d86fdf7`）。

### 📅 2026-08-16 · 渲染架构与命令体系（26 commits）

- **流式渲染架构**：实时 Markdown 打字机流 + Scrollback 历史固化流水线（`e261c3b`）、逐行搭积木式增量上屏与 Thinking 动态指示流（`fbf4e14`）、打字机 Footer 滚动优化（`5905cdd`）；
- **命令体系**：`/status` 全局概览（`8780323`）、`/steer` 实时干预与排队消息提升（`847fb59`）、`/compact` 对齐 Claude Code（`93a3de1`）、`/ask` 侧边零污染问答（`21f7fa4`）、内置 `/grill-me` 架构深度拷问技能并升级为 Matt Pocock 决策树法则（`1a9e0c2`、`8771fd6`）；
- **视觉体系**：Claude 暖色调体系统一（`570b9d7`）、柔和浅灰消除刺眼白光（`b537934`）、⚛ 思考图标与 ✻ 完成图标对齐 Claude Code（`795f8a8`、`dfeaf24`）、用户气泡右移与上下文注入独立呈现（`35fef17`）；
- **交互细节**：两步式模型选择器（`ff6338c`）、statusline 密度模式配置（`0284632`）、预设切换确认面板（`d3da36b`）、SS3 方向键支持（`befa17e`）。

### 📅 2026-08-17 · 功能完善与性能优化（95 commits）

- **架构与性能**：单体 TUI 模块化重构为子系统（`4e2a301`）、Cordis 注入解耦与后台 MCP 异步初始化（`f64bc02`、`3adb49d`）、启动延迟与分块回放优化（`b69fc72`、`b784ec9`）、会话恢复原子直出 < 50ms（详见第 9 节）；
- **品牌与发布**：重命名 `dsh-omc-tui`（Oh-My-Claude）（`4ff5009`）、MIT 开源与 npm 发布元数据（`a1768de`）；
- **Markdown 渲染引擎**：Claude Code 级 4 边闭合代码卡片 + Unicode 表格网格 + 标题排版（`8535770`、`afe9db7`、`b09c73d`）、流式缓冲多行表格 / 代码块单遍无缝渲染（`f755f65`）；
- **Bash 模式**：`!` 前缀与琥珀金主题（`eeb0e60`、`3fbd4b1`、`5664b0a`）、Bash 命令输出自动注入下一轮上下文（`363ca9f`）、Bash 完成自动触发模型（`130ae31`）、Bash 模式专用状态行指示（`36e6216`）；
- **审批与 Diff**：审批卡片 4 角闭合框 + Tab 切换（`10f06af`、`dd0646a`）、问题面板 Submit 升级与未答警告（`3b5ec6b`）、Write 工具磁盘对比 Diff（`b822cf5`）、Diff 行底色增强可读性（`dcfb060`）；
- **工具链编排**：树遍历状态机模型（详见第 6 节）、连续混合工具自动聚合与工具组自动收起（`41ec6bc`、`d261455`、`759df6d`）；
- **流式渲染稳定性**：文字重复与标题重复刷屏修复（详见第 7 节）、Scrollback 提交原子单次写入 0 闪烁（`d78c1f6`、`293c54f`）、回合结束高度差精确锚定（`0c00abf`、`e43a9e4`）、4 行活动抽屉锁定整轮（`103fe52`、`66a649d`）；
- **文档与规范**：README 重做 + 产品宣传白皮书（`007d27e`、`9edd4da`）、AGENTS.md / CLAUDE.md 项目规范（`ca6a6cc`）、CHANGELOG 体系建立（`2d55c19`）、文档事实校正与 GitHub Issue 模板（详见第 10 节）。

### 📅 2026-08-20 → 08-24 · 上游适配、Provider 生态、Vision 路由与生命周期管理（9 commits）

- **Provider 管理与交互向导**：新增 `/provider` 命令及交互式 Provider 管理面板，支持自定义端点、鉴权与模型列表配置（`44dffcc`）；
- **渲染与会话健壮性**：CJK 与 ANSI 宽字符截断强化、`/btw` 独立会话流程稳固、自动化 PTY 端到端测试套件（`95780a1`）；
- **Statusline 深度上下文 HUD**：集成实时 Git 分支、工作区变更及 ahead/behind 监控（`src/core/git.js`），支持活跃 Jobs、MCP、Hooks、Skills 多维度指标可视化（`2643d3b`）；
- **Harness rc.1 契约适配**：全面对齐 `@deepseek-ai/dsh@0.1.1-rc.1`，适配模型 Reasoning Effort 级联与预设重组（`f94d400`）；
- **Vision 旁路视觉路由**：新增 `src/vision-router.js` 与 `/vision` 命令，实现主模型无视觉时自主调度旁路 Agent 识别图片（`45dd5c8`）；
- **渲染与交互微调**：高对比度 Markdown 代码块与表格边框渲染优化、Context 消耗预警与 Skills 开关修复（`4d0cecc`）；
- **托管 Browser 租约与生命周期**：新增 `src/browser-lease.js` 托管专用浏览器生命周期，退出时保留专用 Chrome（供用户完成登录与安全重连），多选/自定义问卷交互提升（`7f276fd`）；
- **输入控制与 Jobs 交互增强**：输入历史去重与导航增强、Jobs 面板支持流式输出读取与任务取消、退出确认面板（`src/panels/exit-confirm.js`）及退出时后台 Jobs 安全终止（`b328df5`）。

---

## 📅 2026-08-17 · 终端排版引擎、时序对齐与极速直出优化

### 🎯 核心问题与优化记录清单

---

### 1. 启动异常与未定义方法修复 (Fix Runtime Errors)
* **问题现象**：
  * 终端启动时偶发报错 `ReferenceError: truncateAnsi is not defined` 导致无法进入主界面。
  * 轮次结束 `turn/end` 时抛出 `TypeError: this.refresh is not a function` 导致进程退出（Exit code 130）。
* **根因分析**：
  * `src/index.js` 顶部引入 renderer 模块时遗漏了 `truncateAnsi` 的解构导出。
  * 早期重构遗留了旧代码 `this.refresh(false)`，实际状态更新与 Footer 渲染由 `onTurnEnd` 和 `scheduleRender` 负责。
* **解决方案**：
  * 在 `src/index.js` 补全 `truncateAnsi` 导入。
  * 移除 `turn/end` 阶段的冗余调用，统一收敛至标准事件调度生命周期。

---

### 2. `workspace-write` 权限预设持久化修复 (Permission Preset Persistence)
* **问题现象**：
  * 在交互式授权弹窗中选择 `2. Yes, allow workspace-write during this session (shift+tab)` 后，后续工具执行仍然反复弹出审批弹窗。
* **根因分析**：
  * 审批响应分支错误调用了不存在的 `permissionPresets.select()` 方法，导致设置静默失败。
* **解决方案**：
  * 修正为官方 Harness 接口 `this.ctx.permissionPresets.set(this.agent.session, 'workspace-write')`，触发 durable event 落盘，实现会话级权限真正生效。

---

### 3. 用户输入气泡框样式与 CJK 安全对齐 (User Message Bubble & CJK Alignment)
* **演进历程**：
  * **初代**：简易粗体文本，缺乏层次感。
  * **尝试**：背景色胶囊方案（`ANSI.userBg`），但在暗色/透明终端下稍显突兀。
  * **定版**：完整恢复经典圆角气泡卡片（`YOU · HH:MM` + `╭──────╮` / `│ 内容 │` / `╰──────╯`），气泡宽度自适应终端列数，使用 `widthOf()` / `visibleOf()` 严格保证中英文字符在终端中绝对对齐不破框。

---

### 4. 本地日志与会话历史的时序倒置修复 (Chronological Log Ordering)
* **问题现象**：
  * 用户在输入新消息前执行 `Shift+Tab` 切换权限、或者输入 `/status` 查看状态，但在终端重绘（Resize）或会话恢复后，这些本地日志竟然跳到了新消息的下方。
* **根因分析**：
  * `repaint()` 逻辑先遍历并格式化了所有的 `agent.session.events`，最后才把 `this.localLog` 追加到最尾部。
* **解决方案**：
  * 在 [src/index.js](src/index.js) 中将 `session.events` 与 `localLog` 统一按绝对时间戳 `time` 进行**全局归并排序**，并在 [src/renderer/transcript.js](src/renderer/transcript.js) 增加 `case 'local/log'` 处理，确保操作时序绝对准确。

---

### 5. 流式思考抽屉动态效果与终端安全 (Live Thinking Drawer & Safe Truncation)
* **优化内容**：
  * 将底部思考动态抽屉扩展为 **3 行实时思考流预览**，末尾带有脉冲提示光标 `▋`。
  * 消除抽屉高度动态剧烈跳动导致的视口闪烁，渲染使用 `${truncateAnsi(line, columns - 1)}\x1b[K` 代替右侧空格填充，彻底解决 macOS / iTerm2 / VS Code 下因为终端自动换行导致的“幽灵空行”与布局错位。

---

### 6. 树遍历状态机模型与工具链自动收起 (Tree Traversal & Node Transitions)
* **问题现象**：
  * 模型执行多步排查（如 `Read` -> `Edit` -> `Bash`）时，每次工具前都有 1 行过渡碎碎念，几轮下来终端被中间过渡和工具日志堆满，正式回答被推至屏幕外。
* **架构设计（Tree Traversal State Machine）**：
  * 将 Agent 交互流形式化为树遍历状态机：
    * **Thinking 节点**：思考结束退出 ➔ 原地收起为 `  ⚛ Thought for Ns (ctrl+o to expand)` ➔ 插入空行。
    * **Lead-in 过渡节点**：前置说明文字以淡灰紧凑行显示 ➔ 插入空行。
    * **Tools 工具组节点**：叶子工具在底部抽屉执行，全部工具执行完毕回归根节点时 ➔ 自动合并收纳为 `  ⚙ TOOLS · N · ... (ctrl+o to expand)` ➔ 插入空行。
    * **Response 回答节点**：模型的**正式回答（Final Answer）100% 完整舒展展开**，不折叠。

---

### 7. 流式输出文字重复与 DSH 标题重复刷屏修复 (Deduplicate Streaming Text)
* **问题现象**：
  * 流式生成中，模型输出的文字每隔几秒就会被重复打印两遍，且伴随重复出现 `DSH deepseek-v4-flash · 22:56` 标题行。
* **根因分析**：
  * `flushStreamBuffer` 已经将流式文本逐行写入了 stdout；随后 `tool/result` 触发 `commitUnprintedEvents` 时，又把包含同一段文字的 `assistant/message` 再次传进 `formatEvents` 渲染，造成二次重复输出。
* **解决方案**：
  * 在 [src/index.js](src/index.js) 中明确职责：流式阶段的文字由 `flushStreamBuffer` 独占流式提交；`commitUnprintedEvents` 仅过滤并提交真正的工具事件（`tool/call`、`tool/result`、`approval`），彻底消除重复内容与重复 Header。

---

### 8. 连续混合工具自动聚合 (Unified Tool Grouping)
* **优化内容**：
  * 在 [src/renderer/transcript.js](src/renderer/transcript.js) 引入 Lookahead 前瞻判定，连续执行的 `Read`、`Edit`、`Write`、`Bash`、`grep` 等混合工具链，即使中间夹杂微小状态流，也统一聚合成单个卡片（如 `  ⚙ TOOLS · 7 · edit ×4 · read · bash ×2 (ctrl+o to expand)`），不再出现单条与多条平级碎裂割裂。

---

### 9. 会话恢复（`-c`）极速原子直出 (Instant Render for Session Resume)
* **问题现象**：
  * 执行 `dsh-omc-tui -c` 恢复会话时，内容像搭积木一样一条条缓慢刷屏，且整屏历史被重复打印两次。
* **根因分析**：
  * 会话恢复时调用了 `for (const event of session.events) this.onSessionEvent(...)`，强行把历史事件当成实时流重新发射了一遍；随后又全量分块输出了一次。
* **解决方案**：
  * 移除事件模拟流，直接在内存中完成状态与 `reasoningBlocks` 索引（耗时 < 1ms）。
  * 通过 `this.formatEvents(session.events, columns)` 完成一次性排版，并执行**单次原子系统调用写入**（`process.stdout.write(pastRows.join('\n') + '\n')`）。
* **性能实测**：
  * 800 个事件（2,200 行终端对话历史）全量排版与输出耗时 **仅 36.7ms**，常规会话进入耗时 **< 3ms**，实现秒开直出。

---

### 10. 官方文档事实与规范校正 (Documentation Accuracy & TOC Fixes)
* **校正内容**：
  1. `README.md` L213：修正 `!` Bash 模式颜色描述为“输入区与提示符变琥珀金”（原文档误写为“边框变绿”）。
  2. `README.md` L203：修正 `Ctrl+K` 快捷键描述为“删除光标至当前行行尾”（符合 Emacs 规范，原误写为“删除当前行”）。
  3. `README.md` L35 / L303：修正 TOC 锚点为 `#反馈与贡献-feedback-contributing`（与 GitHub slugger 规则 100% 对齐）。
  4. 新增 Roadmap（规划中）、反馈与贡献指引、以及标准 GitHub Issue 模板（Bug 反馈与 Feature Request）。

---

### 11. 动态生成抽屉扩展为 4 行并锁定整轮状态
* **优化内容**：
  * 将底部实时预览抽屉升级为**恒定 4 行**（1 行状态指标 + 3 行丰富实时推理流，带脉冲光标 `▋`）。
  * 状态绑定为轮次主生命周期，整个生成过程中高度 100% 恒定，输入框位置稳固。

---

### 12. 流式原子双缓冲写入与轮次结束位置精确锚定
* **问题现象**：
  * 文本流式输出过程中，终端伴随高频闪烁；
  * 回答完全输出结束（`turn/end`）瞬间，输入框和状态栏整体往上跳动了数行。
* **根因分析**：
  * **闪烁根因**：流式提交新行时分为 `clearFooter` -> `write` -> `render` 三次独立系统调用，在清屏与重绘之间向终端暴露了空白帧，高频并发下产生明显闪烁。
  * **跳跃根因**：生成期间 4 行抽屉展开使 Footer 高达 11 行；结束时抽屉关闭，Footer 降为 7 行，高度差导致 7 行 Footer 被绘制在原先抽屉所在的高位。
* **解决方案**：
  * **原子单次写入**：将 `erase`、`content`、`footerText` 与 `cursorMove` 合并为单个 ANSI 缓冲区，通过单次 `process.stdout.write(buffer)` 原子输出，彻底根除任何中间空白帧，**流式输出 0 闪烁**。
  * **差值精确滚动推进**：在 `turn/end` 抽屉关闭的瞬间，计算新旧高度差（`heightDiff`），将完成行指标（`✻ finished in 15.7s · 3 tools`）与差值空行原子压入滚动区，正好抵消 4 行高度差，**输入框与 Statusline 绝对保持在原位，0 垂直跳跃**。

---

### 13. 交互式模型 Provider 管理与自定义 Provider 向导 (`/provider`)
* **架构演进**：
  * 新增 [src/panels/provider-panel.js](src/panels/provider-panel.js)，提供全交互式 Provider 管理入口。
  * 支持查看当前 Provider 状态、切换默认 Provider，并提供步进式向导添加兼容 OpenAI/Anthropic/DeepSeek 接口规范的自定义端点与模型。
  * 自动持久化配置至 Harness 官方模型配置服务，保持无缝生态兼容。

---

### 14. 旁路 Vision 视觉路由体系 (`/vision`)
* **核心设计**：
  * 引入 [src/vision-router.js](src/vision-router.js)，解决主会话模型不支持多模态视觉时的图片识别诉求。
  * 机制：当向主模型发送图片且当前模型仅支持纯文本时，TUI 自主调度已配置的独立视觉 Agent（通过 `/vision <provider>/<model>` 设置）提取图片描述与 OCR 关键信息，将结果作为旁路工具输出无缝注入主会话上下文，既保证主模型无需切换，又赋予强大的多模态感知。

---

### 15. 状态栏 Git 深度状态与动态上下文 HUD
* **增强内容**：
  * 在 [src/core/git.js](src/core/git.js) 实现轻量级非阻塞 Git 状态探测引擎，精准采集当前分支、未提交变更统计（`staged`/`modified`/`untracked`）以及远程分支 `ahead/behind` 指标。
  * Statusline 在 `detailed` 与 `compact` 模式下集成动态上下文 HUD：直观展示已挂载 MCP 工具服务、活跃 Hook、后台 Jobs 计数及 Skills 启停状态，并具备 Context 消耗水位预警。

---

### 16. 托管 Browser 租约生命周期与优雅退出保护
* **健壮性保障**：
  * 引入 [src/browser-lease.js](src/browser-lease.js)，管理 Playwright / Browser 工具会话的租约状态与生命周期。专用 Chrome 实例在退出后保留，通过 PID、端口、用户目录与受管标记在下次启动时安全重连，保障用户登录态不中断。
  * 新增 [src/panels/exit-confirm.js](src/panels/exit-confirm.js) 退出确认面板，防止后台长任务或活跃连接误退出；在退出时可靠终止活跃本地与远程后台 Jobs。
  * 升级 Jobs 管理面板（[src/panels/jobs-panel.js](src/panels/jobs-panel.js)），支持实时流式阅读任务输出与一键取消。

---

### 📊 性能基准测试数据 (Benchmarks)

| 场景 | 指标 / 数据 |
| :--- | :--- |
| **ESM 模块加载** | **0.43 ms**（零外部 UI 依赖） |
| **800 事件格式化 (2,200 行)** | **36.74 ms**（纯内存 CPU 字符串计算） |
| **会话恢复 (-c) 直出时间** | **< 50 ms**（单次 `process.stdout.write` 系统调用） |
| **CJK 宽度计算吞吐** | **> 1,000,000 字符 / 秒** |
