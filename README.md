# DSH OMC (Oh-My-Claude TUI)

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-ipromise2021%2Fdsh--omc--tui-181717?style=flat-square&logo=github)](https://github.com/ipromise2021/dsh-omc-tui)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/Harness-%5E0.1.0--rc.6-00bcd4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B%20%7C%20v22%2B-green?style=flat-square)](package.json)
[![ANSI TUI](https://img.shields.io/badge/ANSI-Zero%20Alternate%20Screen-87af87?style=flat-square)](README.md)

**面向 DeepSeek Harness 的原生 ANSI TUI 插件 · Claude Code CLI 风格的键盘优先终端界面**

[设计亮点与功能详解](PRODUCT_SHOWCASE.md) · [Harness 兼容性记录](HARNESS_COMPATIBILITY.md) · [工作记录与变更日志](CHANGELOG.md)

**💬 个人维护的 pre-release 项目：功能边用边完善，如遇 Bug 或想提建议，欢迎 [提交 Issue](https://github.com/ipromise2021/dsh-omc-tui/issues) 或 PR——你的每一条反馈都很宝贵！**

</div>

---

## 📑 目录 (Table of Contents)

- [✨ 特性速览](#特性速览-features-at-a-glance)
- [📸 实际界面](#实际界面-screenshots)
- [🧭 项目定位](#项目定位-background)
- [✅ 环境要求](#环境要求-requirements)
- [🚀 快速开始](#快速开始-quick-start)
- [🌟 核心功能](#核心功能-core-features)
- [⌨️ 快捷键速查](#快捷键速查-keybindings)
- [🛠️ 命令参考](#命令参考-commands-reference)
- [🔌 MCP 与 Hooks 集成](#mcp-与-hooks-集成-integrations)
- [🧑‍💻 开发者专区](#开发者专区-for-developers)
- [⚠️ 已知限制](#已知限制-known-limitations)
- [🗺️ Roadmap（规划中）](#roadmap规划中-roadmap)
- [🤝 反馈与贡献](#反馈与贡献-feedback-contributing)
- [📄 开源许可证](#开源许可证-license)

---

## ✨ 特性速览 (Features at a Glance)

| 特性 | 一句话说明 |
| :--- | :--- |
| 🚀 **零备用屏幕** | 追加式普通缓冲区（Scrollback Stream），原生滚轮回看与划选复制 |
| 📁 **`@` 文件补全** | 路径逐级下钻 + 代码块智能展开，单文件超 16KB 自动截断 |
| 🛡️ **行内安全审批** | 红绿 Diff 预览 + `Y`/`N` 单键决策，支持审批队列串行处理 |
| 📊 **四行 Statusline** | 身份 / Token / 生态 / 权限四行全景，`/status` 一键体检 |
| 🎨 **护眼调色板** | 四阶柔和灰度 + `claude` / `deepseek` / `mono` / `light` 四款主题热切换 |
| 🖼️ **图片粘贴** | iTerm2 OSC 1337 + Kitty Graphics，自动转官方 Attachment 管道 |
| ⚡ **`/btw` 旁路问答** | 独立临时会话作答，不污染主任务 Context 与 Token 预算 |
| 🗜️ **`/compact` 压缩** | 科技感动态微脉冲加载与小贴士，一键释放上下文 Token |
| 🐚 **`!` Bash / `/jobs`** | 琥珀金 Shell 直通模式，后台任务面板查看实时输出与取消 |

---

## 📸 实际界面 (Screenshots)

<div align="center">

### 1. 终端启动与 4 行 Statusline
![DSH OMC 终端运行主界面](assets/welcome.png)
*欢迎卡片、4 行 Statusline 状态指示器与护眼调色板*

---

### 2. 实际运行与流式渲染交互
![实际运行与流式渲染交互](assets/stream-and-diff.png)
*真实对话流式渲染 · 折叠式 Thinking 思维链（`Ctrl+O` 穿透）、Markdown 语法渲染与工具调用*

---

### 3. 行内安全审批与 Diff 预览
![行内安全审批与 Diff 预览](assets/approval-card.png)
*文件修改与权限提升审批 · 行级红绿 Diff 差异预览与单键快速审批*

</div>

更多场景截图（`@` 文件树补全面板、多选项决策面板、`/status` 全局看板、图片直贴等）详见 [PRODUCT_SHOWCASE.md](PRODUCT_SHOWCASE.md)。

---

## 🧭 项目定位 (Background)

`dsh-omc-tui` (Oh-My-Claude) 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的原生终端 TUI 插件，属于 Harness 的 **projection layer**：只负责终端渲染、键盘交互与局部面板，不复制模型、会话、工具或持久化状态——真相源始终是 Harness 官方服务与 durable event。

**一次会话的数据流**（完整架构图见 [PRODUCT_SHOWCASE.md](PRODUCT_SHOWCASE.md) 的「系统架构与设计契约」）：

```text
键盘输入 / 快捷键 ──▶ TUI 事件适配（src/index.js）
                          │
                          ▼
           Harness Agent / 会话 / 工具服务  ◀── 唯一真相源
                          │
        durable event（session/event）回流
                          │
                          ▼
    追加渲染进终端原生 Scrollback（零备用屏幕）
```

作者日常重度使用 **Claude Code CLI** 的键盘优先交互，在研究 DSH 后动手实现了这个纯终端界面：方便在熟悉的环境里直接调用 DSH 的 Agent / 会话 / 工具 / 审批能力，坚持不进备用屏幕以保留终端原生滚轮与划选复制，并持续打磨护眼配色与交互细节。这是一个个人维护的 pre-release 项目，功能随 Harness 契约与实际使用持续完善，欢迎交流与贡献。

---

## ✅ 环境要求 (Requirements)

| 依赖 | 版本 / 说明 |
| :--- | :--- |
| Node.js | `v20+` / `v22+`（以 `package.json` engines 为准） |
| DeepSeek Harness | `^0.1.0-rc.6` 及配套 peer services（以 `package.json` 为准） |
| 终端 | 支持 ANSI 256 色即可（VS Code / iTerm2 / WezTerm / 原生 Terminal 等） |
| 推荐等宽字体 | *JetBrains Mono*, *Fira Code*, *Cascadia Code*, *SF Mono*, *Menlo* 等（支持 Unicode 边框与 CJK 字符） |
| 图片粘贴（可选） | iTerm2（OSC 1337）或支持 Kitty Graphics 的终端 |

---

## 🚀 快速开始 (Quick Start)

### 1. 从 GitHub / npm 安装

```sh
# 以下命令均使用同一 DSH CLI（npx --yes @deepseek-ai/dsh@latest）
# 方式 A：从 GitHub 仓库安装
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add github:ipromise2021/dsh-omc-tui

# 方式 B：从 npm 安装（仅在该包已发布时可用）
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add dsh-omc-tui

# 启动 tui profile 交互会话
npx --yes @deepseek-ai/dsh@latest --profile tui
```

### 2. 本地开发与调试安装

```sh
# 推荐在隔离的 DSH_HOME 目录中调试，避免改写 ~/.dsh
export DSH_HOME=/private/tmp/dsh-tui-dev

# 挂载本地代码路径
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add /absolute/path/to/dsh-omc-tui

# 启动调试会话
npx --yes @deepseek-ai/dsh@latest --profile tui
```

`dsh plugin` 会在 `$DSH_HOME/profiles/tui` 下注册 profile，并将声明了 `dsh.bundle` 的本包追加进 bundle 栈，由底层 `dsh-base` 继续提供模型、持久化、工具、审批与 sandbox 支持。

---

## 🌟 核心功能 (Core Features)

### 1. 🚀 追加式普通缓冲区（Zero Alternate Screen）

**绝不进入备用屏幕**（摒弃 `CSI ?1049h` 全屏清屏）：已完成的对话消息、工具调用、Thinking 与 Diff 直接追加进终端原生 Scrollback 历史——滚轮自如回看、鼠标随意划选复制，绝不会误触发 `↑/↓` 历史提示词切换。

### 2. 📁 `@` 路径逐级下钻补全与代码块智能展开

输入 `@` 默认列出工作区一级目录与文件：支持字符模糊过滤、`↑↓` 快速选定、`Enter` 钻入子目录或选中文件、`Esc`/`Backspace` 返回上级。提交时自动读取文件并按后缀生成带语言标签的代码块注入 Prompt（单文件超 16KB 自动截断保护），对话区仅回显紧凑的 `@path`。

### 3. 🛡️ `approval/request` 行内安全审批

模型执行文件修改或危险命令时，审批卡片清晰展示文件名与 `-/+` 行级红绿 Diff 预览；`Y`（允许一次）、`N`/`Esc`（拒绝）单键决策，支持审批队列串行处理，审批前预输入的字符自动消费。

### 4. 📊 四行全景 Statusline 与 `/status` 诊断看板

- **第 1 行（身份）**：`BUILD/PLAN` 模式 | 模型名 | 工作目录 | 会话标题，带动态探索状态（`◉ Exploring`）；
- **第 2 行（Token 经济学）**：块状进度条 `█████░░░░░░░░░ 38%` 与 In / Out / Cache 实时命中率；
- **第 3 行（生态看板）**：Skills 数、MCP 服务数、Hook 拦截点、最近工具结果、后台 Jobs 计数；
- **第 4 行（权限指示）**：当前权限预设（`workspace-write` 等），`Shift+Tab` 一键轮转；
- **`/status`**：一键输出环境、Token 占用分布、扩展组件与运行态全局体检报告。

### 5. 🎨 护眼四阶灰度与四款主题

经过反复目视调校的四阶柔和灰度消除纯白眩光：正文 `250` 雅致浅灰、标签/高亮 `251` 亮白微光、代码/边界 `245` 中灰、Thinking `241` 深石板灰。内置 `claude`（暖赤陶/琥珀金）、`deepseek`（经典科技蓝）、`mono`（纯黑白极简）、`light`（明亮浅色）四款调色板，`/settings` 实时热切换并持久化至 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）。

### 6. 🖼️ 双图形协议终端图片粘贴

支持 iTerm2 **OSC 1337** 与 **Kitty Graphics**，`Cmd/Ctrl+V` 将剪贴板图片直接粘贴进终端；底层状态机自动捕获图像二进制并转存为官方 Attachment Ref 随消息提交，对纯文本模型自动降级为友好占位符，避免接口 400 异常。

### 7. ⚡ 零污染侧边临时提问（`/btw <query>`）

执行复杂任务时可随时 `/btw <问题>`（如 `/btw JS Map 遍历效率`）做临时概念查询：系统在后台创建独立临时会话作答，**完全不污染主任务 Session Context，不浪费主任务 Token 预算**。

### 8. 🐚 `!` 本地 Bash 快速执行与后台任务（`/jobs`）

输入 `!` 时输入区与提示符高亮变琥珀金，`Enter` 直接在本地宿主 Shell 中执行命令，输出逐行持久化写入对话日志（`Ctrl+B` 一键转入后台）。`/jobs` 面板基于官方 `ctx.jobs` 构建：列出任务状态、游标读取实时输出、`k` 取消、`r` 刷新，不伪造虚假进度。

> 每个特性的设计动机、问题记录与交互细节见 [PRODUCT_SHOWCASE.md](PRODUCT_SHOWCASE.md)。

---

## ⌨️ 快捷键速查 (Keybindings)

| 按键 / 快捷键 | 对应动作 | 交互说明 |
| :--- | :--- | :--- |
| `Enter` | **发送 / 选定** | 发送输入框内容；菜单/面板打开时选定执行 |
| `Ctrl+J` | **换行** | 在输入框内插入真实多行换行符 |
| `Ctrl+C` | **中断 / 退出** | 模型运行中安全中断回合（保留已生成文本）；空闲时退出 |
| `Esc` | **取消 / 中断** | 运行中即时中断；空闲时清空输入或关闭当前浮层面板 |
| `Ctrl+O` | **展开 / 折叠** | 一键展开 / 收起全会话的 Thinking 思考全文及并行工具组 |
| `Ctrl+G` | **外部编辑器** | 调用系统 `$EDITOR`（如 VS Code / Vim）编辑复杂 Prompt |
| `Ctrl+F` / `Ctrl+R` | **历史搜索** | 打开交互式输入提示词模糊搜索面板 |
| `Ctrl+P` | **命令面板** | 快速过滤并运行任意 Command 或 Skill |
| `Ctrl+K` | **删除至行尾** | 删除光标至当前行行尾的内容 |
| `Shift+Tab` | **权限轮转** | 在只读、工作区读写、全权限预设间无缝切换并落盘 |
| `Ctrl+A` / `Ctrl+E` | **行首 / 行尾** | 光标快速跳至当前行首或行尾 |
| `Alt+←` / `Alt+→` | **按词跳跃** | 按单词粒度左右快速移动光标 |
| `Ctrl+W` | **删除词** | 快速删除光标前的一个完整单词 |
| `Ctrl+U` | **清空输入** | 一键清空当前输入框 |
| `Ctrl+V` | **粘贴图片 / 文本** | 剪贴板图片（iTerm2 OSC 1337 / Kitty）直贴为附件；纯文本插入输入框 |
| `Ctrl+B` | **转入后台** | Bash 模式执行中一键转入后台任务（`/jobs` 查看与取消） |
| `Ctrl+L` | **清屏** | 等同 `/clear`，仅清空本地视图，保留上下文与会话历史 |
| `Ctrl+D` | **退出** | 输入框为空时直接干净退出 TUI |
| `!` + 命令 | **Bash 模式** | 本地直接执行 Shell 命令并捕获回显（输入区与提示符变琥珀金） |
| `@` | **文件引用** | 打开工作区文件与目录浏览补全面板 |
| `?` | **帮助菜单** | 空输入时打开/关闭快捷键提示卡片 |

> 💡 **提示**：macOS 上部分组合键使用 `Cmd`（如粘贴图片为 `Cmd+V`），Windows / Linux 使用 `Ctrl`；`Alt+←/→` 在部分终端中可用 `Option+←/→` 代替。

---

## 🛠️ 命令参考 (Commands Reference)

| 命令 | 分类 | 详细功能说明 |
| :--- | :--- | :--- |
| `/help` | 会话辅助 | 显示快捷键与常用命令操作指南 |
| `/clear` | 视图操作 | 清空本地终端屏幕，**完全保留上下文与会话历史** |
| `/recap` | 会话辅助 | 输出当前会话的本地统计（耗时、Token、工具调用数） |
| `/export` | 会话操作 | 将当前完整对话历史导出为格式清晰的 Markdown 文件 |
| `/exit` | 会话操作 | 干净退出 TUI 进程 |
| `/model` | 模型管理 | 两步式模型选择器（Provider → Model → 思考档位设置） |
| `/effort` | 模型管理 | 动态调整当前模型的思考预算档位，具体选项由当前模型提供 |
| `/preset` | Agent 预设 | 切换 Agent 预设（standard / code / minimal / cordis） |
| `/plan` | 模式切换 | 切换 plan（只读规划模式）与 build（代码构建模式） |
| `/status` | 诊断看板 | 输出模型、会话、Token 分布、扩展组件与配置全局看板 |
| `/context` | 诊断看板 | 详细展示当前上下文窗口（Context Window）占用分布 |
| `/settings` | 配置管理 | 交互式配置主题配色与状态行密度（detailed / compact / minimal） |
| `/rename` | 会话操作 | 快速重命名当前会话标题 |
| `/btw <问题>` | 辅助查询 | 隔离侧边提问，不污染主会话上下文与 Token 预算 |
| `/compact` | 优化干预 | 平滑上下文压缩，带防重入互斥锁与 Token 节省统计 |
| `/steer` | 动态干预 | 运行时动态干预模型方向，或将已排队消息提升为实时指示 |
| `/resume` | 会话管理 | 浏览并恢复历史会话 |
| `/skills` | 扩展生态 | 浏览、搜索并执行已挂载的 Skill 技能列表 |
| `/grill-me` | 架构技能 | 由内置 Skill 提供（非本地命令，随 `.agents/skills` 挂载、可用 `/skills` 浏览）：Matt Pocock 经典法则的架构深度拷问与决策对齐 |
| `/jobs` | 任务管理 | 监控后台异步长任务，支持输出查看与取消 |
| `/paste` | 图片附件 | 从系统剪贴板读取图片并加入下一条消息 |
| `/mcp` | 扩展生态 | 查看已配置的 MCP 服务器及其工具状态 |
| `/hooks` | 扩展生态 | 查看已挂载的 Claude Code 风格 Hook 拦截点 |

---

## 🔌 MCP 与 Hooks 集成 (Integrations)

MCP 与 Hooks 均为**可选的 profile 级集成**，不由 TUI 自行伪造或持久化——TUI 只负责读取并展示已挂载的服务（`/mcp`、`/hooks`）。若 profile 已安装对应 bundle（如 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-hooks-claude-code`），在 profile 补丁 `cordis.patch.yml` 中声明即可：

```yaml
- insert:
    # Playwright 浏览器自动化 MCP (stdio)
    - id: mcp-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: npx
        args: ['-y', '@playwright/mcp']

    # Claude Code 风格 Hooks（读取 ./.claude/hooks.json）
    - id: hooks-cc
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ./.claude/hooks.json
```

---

## 🧑‍💻 开发者专区 (For Developers)

### 架构规范 (Architecture & SSOT)

1. **薄 UI projection layer**：TUI 负责服务/事件映射、局部视图与原生追加渲染，不实现第二套 Agent runtime；
2. **纯 Cordis 依赖注入**：严禁静态 import `@deepseek-ai/*`，依赖解析与宿主环境完全解耦；
3. **单一真相源（Single Source of Truth）**：会话历史、权限、Token 用量全部以 Harness Durable Event 为准，UI 本地只保留纯粹的渲染状态；
4. **分层节流与 Memoization**：Token 流式批处理（56ms）与状态行 Key 缓存，保证长时间高密度输出下不卡顿、不闪烁。

### 本地开发与测试

```sh
npm run verify              # 模块导入完整性校验
npm test                    # 默认 PTY E2E 回归测试
npm run render-assets       # 重新渲染 README / 宣传场景截图（可选）
npm publish --access public # 发布至 npm / DSH 插件体系
```

测试套件基于无凭据 Mock 环境与 PTY 端到端回归：覆盖流式渲染 / 行内审批 / usage / 权限 / 中断 / 退出、`/compact` / 窄终端 / 会话恢复、OSC 1337 与 Kitty 图片粘贴、`@` 引用、审批 diff / 推理折叠 / 工具组、菜单 / 快捷键 / 多行输入 / 状态行等场景，入口见 `test/` 目录。

---

## ⚠️ 已知限制 (Known Limitations)

本项目是个人开发、业余时间维护，仍在边用边完善中：

- **兼容性**：已在 VS Code / iTerm2 终端中验证，个别终端 / OS 组合可能存在渲染差异；Windows 及真实 provider 下的技能发送、长任务生产者仍待独立 E2E 验证；
- **未适配能力**：`/plugins`（插件市场）暂未适配——规划中仅做市场发现，安装 / 移除委托给官方 `dsh plugin` CLI；`/fork`、`/rewind`、会话内全文检索需等待 Harness 提供稳定的 session/checkpoint 合约，不能通过截断 durable log 模拟；
- **反馈渠道**：欢迎通过 [GitHub Issue](https://github.com/ipromise2021/dsh-omc-tui/issues)（建议使用 [Bug 反馈模板](.github/ISSUE_TEMPLATE/bug_report.md)）或 PR 反馈问题、一起改进，详见下方「[🤝 反馈与贡献](#反馈与贡献-feedback-contributing)」；
- **引擎依赖**：本包只提供 TUI 界面，模型、持久化、工具与 sandbox 能力均由底层 `dsh-base` bundle 提供，请确保 profile 挂载顺序正确。

> 更完整的适配边界与发布前检查清单见 [HARNESS_COMPATIBILITY.md](HARNESS_COMPATIBILITY.md)。

---

## 🗺️ Roadmap（规划中） (Roadmap)

个人项目按使用中的真实痛点逐步推进，以下能力已在规划或等待 Harness 上游契约：

- **`/plugins` 插件市场**：规划中仅做市场发现，安装 / 移除委托官方 `dsh plugin` CLI；
- **`/fork` / `/rewind` / 会话内全文检索**：等待 Harness 提供稳定的 session/checkpoint 合约，不能通过截断 durable log 模拟；
- **Windows / 真实 provider 场景**：技能发送与长任务生产者的独立 E2E 验证；
- **社区驱动**：你的 Issue / PR 就是路线图的一部分——欢迎提出你最想要的能力。

> 完整的适配边界与待验证项见 [HARNESS_COMPATIBILITY.md](HARNESS_COMPATIBILITY.md)。

---

## 🤝 反馈与贡献 (Feedback & Contributing)

本项目由作者**一人业余时间维护**，功能边用边完善，难免存在 Bug 或体验不周之处——**你的每一条反馈，都是它变好的方式** 💛

### 🐛 反馈 Bug / 提建议

- 请先搜索 [Issues](https://github.com/ipromise2021/dsh-omc-tui/issues) 是否已有相同反馈；
- 提 Issue 时尽量附上：**DSH / TUI 版本、Node.js 版本、操作系统与终端、复现步骤、截图或日志**——信息越全，定位越快；
- 使用 [Bug 反馈模板](.github/ISSUE_TEMPLATE/bug_report.md) 与 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.md) 可一键生成规范描述。

### 🚀 贡献代码

1. Fork 仓库并创建特性分支；
2. 改动后运行 `npm run verify` 与 `npm test` 确认无回归；
3. 提交信息遵循 [Conventional Commits](AGENTS.md)（`feat` / `fix` / `style` / `refactor` / `docs`）；
4. 提交 PR 时描述改动动机与验证方式，小步提交更易 review。

### 💬 一句鼓励

觉得好用、或在 Issue / PR 里说一声「感谢」，都是作者持续维护的最大动力。

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](LICENSE) 开源发布。
