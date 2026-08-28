# DSH OMC (Oh-My-Claude TUI) · 设计亮点与功能详解

> DSH OMC 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的终端 TUI 插件（`dsh.bundle`），提供 **Claude Code CLI 风格**的键盘优先交互界面，直接消费 Harness 底层的 Agent、工具与会话能力。

---

## 📸 终端实际界面预览 (Actual Terminal Screenshots)

<div align="center">

### 1. 启动与状态栏 (Welcome & 4-Row Statusline)
![DSH OMC 真实终端启动与运行界面](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/welcome.png)
*图 1：实际运行终端截图 · 欢迎卡片、4 行 Statusline 指示器与护眼调色板*

---

### 2. 流式思维链与行级 Diff 高亮 (Stream, Thinking & Diff View)
![流式回答与 Diff 高亮](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/stream-and-diff.png)
*图 2：真实对话流式渲染 · 折叠式 Thinking 思维链（`Ctrl+O` 穿透）、Markdown 语法渲染与行级红绿 Diff 高亮*

---

### 3. `@` 工作区路径逐级补全 (Path Autocomplete Picker)
![@ 文件补全面板](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/file-picker.png)
*图 3：`@` 交互式文件树补全面板 · 实时字符过滤、子目录钻取与文件大小感知*

---

### 4. 行内安全审批卡片 (Interactive Security Approval Card)
![行内安全审批卡片](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/approval-card.png)
*图 4：行内安全审批卡片（Approval Needed）· 行级红绿 Diff 差异预览与单键快速审批*

---

### 5. 交互式多选决策与 Submit 提交面板 (Multi-Tab Decision Panel)
![多选项决策与 Submit 提交面板](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/ask-user-question.png)
*图 5：`ask_user_question` 交互面板 · 多 Tab 勾选状态指示、答案明细审查与单键快速提交/取消*

---

### 6. `/status` 全局看板 (System Diagnostic Dashboard)
![/status 诊断看板](https://raw.githubusercontent.com/ipromise2021/dsh-omc-tui/main/assets/status.png)
*图 6：`/status` 全局体检看板 · 模型配置、Token 消耗分布、扩展组件与会话健康度综合分析*

</div>

---

## 💡 核心交互设计与问题记录 (Key Interaction Design)

### 1. 追加式普通缓冲区（Zero Alternate Screen）
- **问题**：备用屏幕（Alternate Screen）方案下，VS Code / iTerm2 的滚轮事件会被终端误解析为方向键，触发输入历史切换；同时鼠标无法框选复制文本。
- **方案**：采用**标准缓冲区增量追加模型（Scrollback Stream）**——已生成的消息、工具执行与 Diff 直接追加进终端原生历史，仅在底部保留输入区与状态行。
- **效果**：保留终端原生滚轮回看与划选复制能力，交互与普通命令行一致。

---

### 2. 护眼四阶灰度与 Claude 暖色调体系 (Anti-Glare Palette)
- **问题**：高对比度纯白文本（ANSI 37）长时间盯屏易眼疲劳、产生眩光感。
- **方案**：采用**四阶柔和灰度与暖色调**：
  - **回答正文**：`250` 雅致浅灰（柔和可读，不刺眼）；
  - **标题/高亮**：`251` 柔和亮灰白；
  - **代码/次要**：`245` 中灰；
  - **Thinking 思维链**：`241` 深石板灰；
  - **主色调**：Claude 标志性 Terracotta 赤陶色 (`209`) 与温润琥珀金 (`214`)。
- **可配置**：内置 `claude`（默认）、`deepseek`、`mono`、`light` 四款调色板，通过 `/settings` 热切换。

---

### 3. 过程透明与即时穿透：Thinking 动态折叠与 `Ctrl+O` 全屏展开
- **流式阶段**：实时显示平滑点阵动画与耗时：`⠋ Thinking... (1.2s · ↓ tokens)`，大幅降低等待焦虑；
- **收尾折叠**：模型开始输出正文后，思维链自动收缩为优雅的一行徽标 `✻ thinking · 18 lines · 1.2s`；
- **全屏穿透**：按 **`Ctrl+O`** 即可瞬间展开当前会话中的所有思考全文与并行工具组；再次按下全局收起。

```text
YOU · 14:32
╭────────────────────────────────────────────────────────────────────╮
│ 重构 src/renderer/diff.js 中的 approvalDiffLines 函数               │
╰────────────────────────────────────────────────────────────────────╯
  ◫ 上下文注入 · skill-catalog (11 skills)

DSH  deepseek-v4-flash · 14:32

  ⚛ thinking · 18 lines · 1.2s
  已完成对 approvalDiffLines 的参数重构，使其支持自适应提取：

diff --git a/src/renderer/diff.js b/src/renderer/diff.js
--- a/src/renderer/diff.js
+++ b/src/renderer/diff.js
@@ -31,3 +31,11 @@
-export function approvalDiffLines(request, args, columns, ANSI = defaultAnsi) {
+export function approvalDiffLines(request, argsOrColumns, columnsOrAnsi, ANSI = defaultAnsi) {
+  let args = typeof argsOrColumns === 'object' && argsOrColumns !== null ? argsOrColumns : undefined
+  let columns = typeof argsOrColumns === 'number' ? argsOrColumns : (typeof columnsOrAnsi === 'number' ? columnsOrAnsi : 80)
+  let ansiTheme = typeof columnsOrAnsi === 'object' && columnsOrAnsi !== null ? columnsOrAnsi : (ANSI ?? defaultAnsi)

  ✻ finished in 1.8s · 1 tool
```

---

### 4. 上下文效率设计：`@` 路径逐级下钻与双图形协议图片直贴
- **`@` 路径逐级补全**：输入 `@` 即可唤起当前工作区目录树。支持实时过滤、`Enter` 选定或下钻子目录、`Esc`/`Backspace` 返回上级。提交时自动读取正文格式化为带语言高亮的代码块注入，而对话回显仅保留紧凑的 `@path`，避免大文本刷屏。
- **图片双协议原生解析**：支持在终端直接按 `Cmd/Ctrl+V` 粘贴图片，底层状态机自动解析 **iTerm2 OSC 1337** 与 **Kitty Graphics** 协议，通过 Harness 官方 attachment 服务落盘校验。对纯文本模型自动降级为文本占位符，防止 API 报错。

```text
❯ 检查 @src/
  FILES · @src/ · 7 matching

>  commands/
   core/
   input/
   panels/
   renderer/
   image-protocol.js
   index.js

  ↑↓ navigate  ·  Enter open/select  ·  Esc up/close
```

---

### 5. 零污染轻量级侧边提问：`/btw <query>`
- **场景**：主任务编码中需要临时查询概念性问题（如 `"/btw JS 中的 Map 与 Object 遍历性能差异"`）。
- **实现**：`/btw` 在后台创建独立的 `ephemeral` 会话，回答完立即销毁。**完全不污染主任务 Session 的上下文与 Token 预算**。

---

### 6. 全景状态指示器与系统体检看板（Statusline & `/status`）
- **四行全景 Statusline**：
  - **第 1 行（身份行）**：`BUILD/PLAN 模式 | [模型名] | 工作目录 | 会话标题`，带动态探索动画（`◉ Exploring`）；
  - **第 2 行（Token 经济学）**：块状进度条 `█████░░░░░░░░░ 38%`、In / Out / Cache 命中率；
  - **第 3 行（生态看板）**：已挂载 Skills 数、MCP 服务数、Hook 拦截点、最近工具结果、后台运行 Jobs；
  - **第 4 行（权限控制）**：当前权限预设（`workspace-write` 等），支持 `Shift+Tab` 一键轮转。
- **`/status` 全局体检看板**：一键输出环境、Token 用量、扩展与配置体检报告。

```text
❯ /status
  ⎿ Model:        deepseek-official/deepseek-v4-flash · effort DEFAULT
  ⎿ Mode:         BUILD · Preset: standard
  ⎿ Directory:    /Users/yy0812024/work/dsh-plugin/dsh-omc-tui
  ⎿ Session:      9c16d39a · "重构 approvalDiffLines" (4 turns, 28 events)
  ⎿ Context:      12.4k / 200k tokens (6%) · in 11.2k, out 1.2k, cache 8.4k
  ⎿ Permission:   workspace-write
  ⎿ Extensions:   11 skills · 5 MCPs · 0 hooks · 0 active jobs
  ⎿ Preferences:  theme: claude · history: on
```

---

## 🛡️ 安全审批卡片设计 (Interactive Inline Approval)

当模型调用修改文件或执行危险 Shell 命令时，TUI 会弹出安全的行内审批卡片，直接呈现改动文件的行级红绿 Diff 预览：

```text
  • Executing edit...
    └ 📄 src/renderer/diff.js
│ ! approval needed · edit
│ file src/renderer/diff.js
│ - export function approvalDiffLines(request, args, columns, ANSI = defaultAnsi) {
│ + export function approvalDiffLines(request, argsOrColumns, columnsOrAnsi, ANSI = defaultAnsi) {
 Y · allow once   N · deny   Esc · deny
←→ choose  ·  Enter confirm  ·  y/n also work
```

---

## 🧭 常用功能矩阵与快捷键速查 (Feature & Keybinding Matrix)

| 命令 / 快捷键 | 功能类别 | 交互行为与产品价值 |
| :--- | :--- | :--- |
| `Enter` | 基础交互 | 发送输入内容；命令菜单/浮层打开时选定执行 |
| `Ctrl+J` | 编辑器 | 在当前输入框内插入真实换行符（支持多行复杂输入） |
| `Ctrl+C` | 运行干预 | 运行中安全中断当前回合（保留已生成内容）；空闲时退出 |
| `Esc` | 交互撤销 | 运行中即时中断；空闲时清空输入、关闭浮层或清除选区 |
| `Ctrl+O` | 视图展开 | 一键展开 / 收起全会话的 Thinking 思考全文及并行工具组 |
| `Ctrl+G` | 外部编辑 | 使用系统 `$EDITOR`（Vim / VS Code 等）编辑超长 Prompt |
| `Ctrl+F` / `Ctrl+R` | 历史搜索 | 打开交互式输入提示词模糊搜索面板 |
| `Ctrl+P` | 命令面板 | 快速过滤并运行任意命令或 Skill |
| `Shift+Tab` | 权限控制 | 在只读、工作区读写、全权限预设间无缝轮转 |
| `Ctrl+A` / `Ctrl+E` | 光标定位 | 光标快速跳至当前行首或行尾 |
| `Alt+←` / `Alt+→` | 按词跳转 | 按单词粒度左右移动光标 |
| `Ctrl+W` | 快速编辑 | 删除光标前的一个单词 |
| `Ctrl+U` | 清空输入 | 一键清空输入框内容 |
| `Ctrl+V` | 粘贴输入 | 剪贴板图片（iTerm2 OSC 1337 / Kitty）直贴为附件；纯文本插入输入框 |
| `Ctrl+B` | 后台任务 | Bash 模式执行中一键转入后台，`/jobs` 查看输出与取消 |
| `Ctrl+L` | 刷新清屏 | 仅清空与重绘终端屏幕，保留当前会话上下文与历史 |
| `/clear` | 清空会话 | 创建新会话并重置上下文，等同 `/new` 快速模式 |
| `Ctrl+D` | 快速退出 | 输入框为空时直接干净退出 TUI |
| `!` + 命令 | 本地 Bash | 本地直接执行 Shell 命令并捕获回显 |
| `@` | 文件引用 | 打开工作区文件与目录浏览补全面板 |
| `?` | 帮助菜单 | 空输入时打开/关闭快捷键提示卡片 |
| `/btw <问题>` | 辅助查询 | 隔离侧边提问，不污染主会话上下文与 Token 预算 |
| `/compact` | 上下文压缩 | 对齐 Claude Code 的平滑压缩，防重入锁与 Token 节省统计 |
| `/steer` | 动态干预 | 运行时干预模型方向，或一键提拔已排队消息为实时指示 |
| `/model` | 模型切换 | 两步式模型选择器（Provider → Model → 思考档位） |
| `/provider` | 提供方管理 | 交互式模型提供方管理（预设厂商、自定义端点、端点模型一键探测） |
| `/preset` | 预设管理 | Agent 预设组合（空会话直接生效，有内容自动触发确认） |
| `/jobs` | 任务管理 | 监控后台异步长任务，支持游标读取输出、`k` 取消、`r` 刷新 |
| `/status` | 系统看板 | 输出模型、会话、Token 分布、扩展组件与运行态体检报告 |
| `/settings` | 本地偏好 | 交互式配置主题配色与状态栏密度（Detailed / Compact / Minimal） |

---

## 🏗️ 系统架构与设计契约 (Architecture & SSOT)

```mermaid
graph TD
    A[用户输入 / 键盘事件] --> B[Input Tokenizer & Editor]
    B --> C{命令 / 消息路由}
    C -->|本地交互 / 浮层| D[Panels / Local Commands]
    C -->|Agent 提问 / Steer| E[DSH Harness Agent Service]
    E --> F[Durable Session Log]
    F -->|session/event| G[TuiApp Event Adapter]
    G --> H[Scrollback Stream Buffer]
    G --> I[Statusline & Footer Renderer]
    H --> J[终端标准输出 ANSI Output]
    I --> J
```

1. **纯粹的 Cordis 依赖注入**：严禁静态 import `@deepseek-ai/*`，依赖解析与宿主环境完全解耦；
2. **单一真相源（SSOT）**：会话历史、权限、Token 用量全部以 Harness durable event 为准，UI 本地只保留纯粹的渲染状态；
3. **分层节流与 Memoization**：Token 流式批处理（56ms）与状态栏 Key 缓存，保证长时间高密度输出下不卡顿、不闪烁。
