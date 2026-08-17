# DSH OMC (Oh-My-Claude TUI) 工程化与发布前缺陷记录

> **更新日期**：2026-08-17  
> **当前状态**：`PRE-RELEASE HARDENING`（**暂不具备公开发布条件，缺陷收敛中**）  
> **基线分支**：`main` (`dsh-omc-tui`)

本文档记录 TUI 的工程判断、当前已落地的模块架构、以及**阻碍公开发布的已知缺陷清单（Bug Backlog）**。在缺陷全部闭环并通过全套回归测试之前，严禁直接对外发布或提交至 DSH Hub。

---

## 1. 当前发布阻断缺陷清单 (Release Blocker Bugs)

以下为真实运行中捕获并确认的待修复缺陷，必须全部修复并通过 PTY 回归后才可进入发布流程：

| 缺陷编号 | 缺陷描述 | 触发场景 / 现象 | 严重程度 | 修复方案 / 目标 |
| :--- | :--- | :--- | :---: | :--- |
| **BUG-01** | **中断退出时出现双重 `interrupted` 与多余空白行** | 用户在工具（如 `bash`）运行中按 `Ctrl+C` 或 `Esc` 中断，终端回显出现两次 `∅ interrupted` 且伴随多行空白行残留。 | 🔴 **P0 (阻断)** | 收敛 `TuiApp` 的中断信号处理与事件广播，确保中断仅输出一次清晰的日志并干净清理底部绘制槽。 |
| **BUG-02** | **工具折叠组（Tool Group）在中断时格式错位** | 连续多工具调用（`⚙ TOOLS · 2 · bash ×2`）遇到用户中断时，未完成工具的状态折叠留有宽字符填充与多余行。 | 🟠 **P1 (高)** | 在 `formatEvents` 中规范未完成工具组的中断状态渲染，统一尾部换行与折叠规则。 |
| **BUG-03** | **退出与 Resume 提示的终端光标复位** | TUI 退出时输出 `Resume this session with: ...` 前后，终端光标与鼠标报告模式清理需确保幂等，防止在部分终端留下脏状态。 | 🟠 **P1 (高)** | 统一 `teardown()` 逻辑，确保 `showCursor()` 与 `TERMINAL_MOUSE_OFF` 仅执行一次。 |
| **BUG-04** | **Windows 平台真实 PTY 与 PowerShell 路径实测** | 目前主要在 macOS xterm / VS Code 环境完成验证，Windows 下的 raw mode 与路径解析尚未进行端到端实机验证。 | 🟡 **P2 (中)** | 建立 Windows CI 矩阵或专门实机回归，验证 `COMSPEC` 与 SS3 键位映射。 |

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
