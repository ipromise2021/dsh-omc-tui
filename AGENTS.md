# DSH OMC TUI · Agent 指令与开发规范

本项目是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的原生全功能终端交互界面（TUI 投影层）。在参与本项目的开发、重构或调试时，必须严格遵守以下工程规范与契约。

---

## 🎯 核心架构与设计哲学

### 1. 契约原则：Runtime 归 Harness，Projection 归 TUI
* **TUI 是投影层而非独立 Runtime**：会话、Agent 状态、模型列表、技能（Skills）、权限（Permissions）、任务（Jobs）和持久化配置，均以 Harness 官方服务与 durable event 为唯一真相源。
* **业务写入走官方 API**：严禁在 TUI 本地私自伪造状态、截断 durable log 或绕过官方接口直接篡改底层配置。
* **无状态恢复（Event Sourcing）**：恢复会话（`dsh-omc-tui -c` / `dsh --resume`）时，所有 UI 均由持久化事件（`session/event`）重新投影构建。

---

## 🛠️ 技术栈与编码铁律

1. **纯原生 ESM JavaScript**
   * 运行环境：Node.js >= 20（以 `package.json` engines 为准），使用标准 ES Modules（`import` / `export`）。
2. **零重型外部 UI 库（Zero Dependencies for UI）**
   * 严禁引入 `chalk`、`blessed`、`ink`、`cli-boxes`、`strip-ansi` 等第三方终端库。
   * 所有 ANSI 256 色/TrueColor 颜色、光标控制、样式格式化均通过 `src/renderer/` 原生实现。
3. **东亚宽字符（CJK）与终端对齐安全**
   * 计算字符串视觉宽度必须使用 `src/renderer/ansi.js` 中的 `widthOf()` 与 `visibleOf()`，严禁使用 `.length` 直接作为终端列数，确保中文与宽字符不产生布局错位。
4. **主题系统（Themes）**
   * 所有前景色、背景色、分割线、Badge 均使用 `src/renderer/themes.js` 中定义的语义 Token（如 `ANSI.blue`、`ANSI.amber`、`ANSI.coral`、`ANSI.ink`、`ANSI.rule`）。

---

## 📁 目录结构与职责分工

* `src/renderer/`: 纯 ANSI 终端渲染与排版引擎
  * `ansi.js`: ANSI 解析、宽度计算、CJK 换行截断与辅助函数。
  * `markdown.js`: Claude Code 级别的 Markdown 渲染引擎（4 边闭合代码卡片、Unicode 表格网格 `┌┬┐├┼┤└┴┘`、列表与加粗）。
  * `themes.js`: 语义化色彩体系（`claude`、`deepseek`、`mono`、`light` 等）。
  * `transcript.js`: 会话历史（User Message、Thinking 链、Tool Call、Diff）的 ANSI 渲染与折叠。
  * `statusline.js`: 底部 4 行紧凑状态栏（Token 进度条、Context 消耗、权限档位、模型信息）。
  * `welcome.js`: 首屏引导卡片。
* `src/panels/`: 交互面板与选择器（Jobs 管理、设置、技能、模型选择、命令面板等）。
* `src/commands/`: 内置斜杠命令
  * `compact.js`: `/compact` 会话压缩与极简加载动效。
  * `btw.js`: `/btw` 旁路问答（不污染主会话上下文）。
  * `status.js`: `/status` 全局诊断面板。
  * `registry.js`: 统一命令注册与分发。
* `src/core/`: 事件定义、Token 解析与基础工具。
* `src/index.js`: TUI 核心控制器、PTY 事件循环与键盘输入响应。

---

## 🧪 验证与提交规范

### 1. 语法与模块验证
修改代码后，在终端中快速验证模块导入完整性：
```bash
node -e "Promise.all([import('./src/index.js'), import('./src/renderer/themes.js'), import('./src/commands/registry.js')]).then(() => console.log('✓ OK'))"
```

### 2. Git 提交规范 (Conventional Commits)
提交信息必须遵循语义化格式：
* `feat(...)`: 新功能或交互体验升级
* `fix(...)`: Bug 修复与异常处理
* `style(...)`: 终端排版、ANSI 配色或微调
* `refactor(...)`: 代码结构重构（不改变功能）
* `docs(...)`: 文档更新
