# DSH OMC (Oh-My-Claude TUI) 工程化与发布前缺陷记录

> **更新日期**：2026-08-17  
> **当前状态**：`PRE-RELEASE HARDENING`（**暂不具备公开发布条件，缺陷收敛中**）  
> **基线分支**：`main` (`dsh-omc-tui`)

本文档记录 TUI 的工程判断、当前已落地的模块架构、以及**阻碍公开发布的已知缺陷清单（Bug Backlog）**。在缺陷全部闭环并通过全套回归测试之前，严禁直接对外发布或提交至 DSH Hub。

---

## 1. 当前发布阻断缺陷清单 (Release Blocker Bugs)

以下为真实运行中捕获并确认的待修复缺陷，必须全部修复并通过 PTY 回归后才可进入发布流程：

| 缺陷/特性编号 | 描述 | 触发场景 / 现象 | 严重程度 | 修复状态 |
| :--- | :--- | :--- | :---: | :---: |
| **BUG-00** | **`@` 文件包含内部代码块时气泡溢出** | 引用 Markdown（如 README）等包含 ` ``` ` 代码块的文件时，正则过早匹配首个内嵌代码块导致后半段文件内容溢出打印在用户气泡中。 | 🔴 **P0 (阻断)** | ✅ **已修复**（引入结构化标记 `<!-- dsh:file_ref_start/end -->` 精确折叠） |
| **BUG-01** | **中断退出时出现双重 `interrupted` 与多余空白行** | 用户在工具运行中按 `Ctrl+C`/`Esc` 中断，`onTurnEnd` 与 `transcript.js` 事件重复输出 `∅ interrupted`。 | 🔴 **P0 (阻断)** | ✅ **已修复**（统一由 Transcript `turn/end` durable 事件单点渲染） |
| **BUG-02** | **恢复会话 (`-c`) 历史文本中夹杂 Footer/输入框残影** | 长会话分块异步输出时，后台定时器触发 `render()` 导致输入框被画在滚动历史文本中间。 | 🔴 **P0 (阻断)** | ✅ **已修复**（引入 `isCommittingScrollback` 提交锁与一次性批量同步写入） |
| **BUG-03** | **窗口拉伸与全屏切换导致 Footer 重复堆叠** | 窗口宽度缩窄触发终端被动换行导致行高失真，以及全屏切换时视口滚动导致相对行擦除失效。 | 🔴 **P0 (阻断)** | ✅ **已修复**（状态栏全响应式断阶 + `onResize` 触发 `this.repaint(true)` 全视口自适应重绘） |
| **FEAT-01** | **Thinking 与 Tool 调用实时动态流式 + 结束自动折叠** | 模型思考与工具执行时不再静态卡顿，动态输出最近 2~3 行思维链/命令预览，节点结束后瞬间收起为单行徽标。 | 🟢 **特性优化** | ✅ **已落地**（`flushThinking` + 动态草稿实时投影） |

---

## 2. 项目定位与工程准则

DSH OMC 是一个 DeepSeek Harness `dsh.bundle`，不是独立 Agent，也不是 Web UI 的复制品。

核心职责只有三类：
1. **服务与事件映射**：将 Harness 的 `ctx.*` 服务和 Durable Session Events 映射到终端交互；
2. **局部视图与交互**：管理输入编辑、命令面板、问卷、审批和局部视图状态；
3. **原生追加渲染**：将思考、工具、技能、Hook 和回答流式追加到普通终端 Scrollback。

> ⚠️ **核心红线**：会话、权限、工具、MCP、Skills、任务和持久化的真相源（SSOT）必须继续由 Harness 官方服务提供。TUI 严禁在本地维护第二套平行会话状态机。

---

## 3. 当前模块架构（已落地）

已完成从单体 `src/index.js` 向高内聚子系统的解耦拆分：

```text
src/
├── core/                  # Cordis 插件装载与生命周期管理
│   ├── events.js          # durable event 统一折叠、紧凑引用与格式化
│   └── index.js           # 核心事件工具导出
├── renderer/              # ANSI 终端渲染子系统
│   ├── ansi.js            # ANSI 样式 Token、宽度计算、截断与转义
│   ├── themes.js          # 主题注册表 (claude, deepseek, mono, light)
│   ├── statusline.js      # 状态行三阶密度渲染 (detailed, compact, minimal)
│   ├── markdown.js        # Markdown 轻量语法解析与分词换行渲染
│   ├── diff.js            # 行级 unified diff 自适应高亮
│   ├── transcript.js      # 会话流式事件与操作日志格式化
│   └── welcome.js         # 欢迎卡片与版本信息渲染
├── input/                 # 终端键盘与交互捕获
│   ├── autocomplete.js    # @ 文件引用与目录树补全
│   └── index.js           # 输入工具集中导出
├── panels/                # 浮层交互面板控制器
│   ├── help.js            # 快捷键帮助面板 (Ctrl+G 外部编辑)
│   ├── approval-panel.js  # 行内安全审批卡片
│   ├── file-picker.js     # @ 文件路径交互面板
│   ├── model-picker.js    # 两步式模型选择器
│   ├── preset-picker.js   # Agent Preset 选择与二次确认
│   ├── question-panel.js  # ask_user_question 问卷面板
│   ├── jobs-panel.js      # 后台长任务监控面板
│   └── settings-panel.js  # TUI 配置面板
├── commands/              # 本地命令路由与执行器
│   ├── index.js           # 本地命令分发中心
│   ├── ask.js             # /ask 隔离临时提问
│   ├── compact.js         # /compact 平滑压缩
│   ├── recap.js           # /recap 统计
│   └── status.js          # /status 全局诊断看板
├── image-protocol.js      # iTerm2 OSC 1337 / Kitty 双图形协议解析
└── index.js               # TuiApp 调度器与 Cordis apply 插件入口
```

---

## 4. 依赖策略与框架边界

- **纯原生追加模式**：坚决不引入 Ink、Blessed 等全屏重绘框架，避免破坏 VS Code 终端原生鼠标滚轮与划选复制。
- **Node.js 22 运行时**：与 DSH/Cordis 保持完全一致，严禁静态引入 `@deepseek-ai/*`。
- **轻量依赖**：保持零运行时第三方 npm 包，所有功能依赖 Node.js 内置模块与 Cordis 依赖注入。

---

## 5. 发布前验收路线图 (Release Readiness Roadmap)

- [ ] **Phase 1 (缺陷清零)**：彻底解决 BUG-01、BUG-02、BUG-03，消除中断与会话恢复时的布局残留。
- [ ] **Phase 2 (PTY 回归)**：运行全套 6 个 PTY 自动化脚本，确保 100% 通过无报错。
- [ ] **Phase 3 (干净环境验收)**：在隔离 `$DSH_HOME` 下通过官方 `dsh plugin --profile tui add ...` 进行完整生命周期验证（安装、多轮会话、中断、恢复、卸载）。
- [ ] **Phase 4 (正式发布)**：推送代码至 GitHub 并提交至 DSH Hub 目录收录。
