# DSH TUI

一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile/bundle 的原生 ANSI 终端 coding-agent 界面。不 Fork OpenCode、不依赖 Web UI：直接创建 Harness Agent、订阅 durable Session 事件，接管审批与权限预设。

视觉依据：[dsh-tui-coding-style.html](../dsh-tui-coding-style.html)（DeepSeek 浅蓝主题、四行 statusline、输入区两条细线、用户消息左侧竖线）。

## Harness 兼容性约束

本项目是 Harness 的 UI bundle，不是独立 Agent。所有会影响或呈现 Agent 状态的能力必须优先对接官方服务与 durable session event：会话与流式事件、模型、权限、命令、技能、附件、问卷、jobs，以及后续的 settings；不得在 TUI 内复制一套会话、权限或任务的真相源。

- TUI 只负责 ANSI 渲染、键盘/鼠标输入、局部视图状态和可逆的交互编排。
- Agent 行为必须经 Harness 的 `ctx.*` 服务、已注册 command 或 session event 实现；服务不存在时应明确降级或提示，不能假装成功。
- 上游目前仍处于 developer preview，发布或升级前须在目标 `@deepseek-ai/dsh` 版本上重新执行 profile 安装、`--dump-config` 与 PTY 回归。
- `link:` 安装时依赖从源码目录解析，因此本包不静态 import `@deepseek-ai/*`；以 Cordis 注入和官方事件契约保持 bundle 可安装性。

当前本地包已可作为 `dsh.bundle` 安装验证，但尚非可公开发布包：`private: true`、无 LICENSE、无公开 GitHub 仓库与版本兼容声明。发布前要求见 [ROADMAP.md](ROADMAP.md)。

完整的功能—服务—事件映射见 [HARNESS_COMPATIBILITY.md](HARNESS_COMPATIBILITY.md)。

## 安装

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add /absolute/path/to/dsh-tui
npx --yes @deepseek-ai/dsh@latest --profile tui
```

`dsh plugin` 创建 `$DSH_HOME/profiles/tui`，并把含 `dsh.bundle` 声明的本包追加到 profile bundle 栈；`dsh-base` 继续提供模型、持久化、工具、审批与 sandbox。

开发期间始终使用隔离 `DSH_HOME`（如 `/private/tmp/<name>`），不要改写真实 `~/.dsh`。

## 功能

- 单个真实 Harness 会话：用户消息、assistant 流式文本（含 reasoning 与 tool-call 草稿）实时渲染；欢迎页展示 TUI 标识、模型与快捷键摘要。
- 操作日志：命令/快捷键操作以 `❯ 触发源` + `⎿ 结果` 成对持久输出到对话区，按时间与消息混排（不短暂消失）。
- `@` 文件引用（参考 Claude Code 的路径补全）：输入 `@` 默认列出 cwd 一级目录（目录在前、`/` 后缀），`↑↓` 选择、`Enter` 进入目录或选中文件、`Esc`/空 query 时 `Backspace` 返回上级（根目录关闭）；输入字符实时过滤当前目录条目；提交时读取文件内容展开为带语言标签的引用块（单文件 >16KB 截断，二进制/不存在保留原样并提示），模型能获得完整引用，但对话回显只保留紧凑的 `@path`，不重复展示注入的文件正文。手动输入完整路径（如 `@src/index.js`）不经菜单直接生效。
- 图片粘贴：终端 `Cmd/Ctrl+V` 粘贴的图片经 iTerm2 OSC 1337 / kitty graphics protocol 解析，走 Harness 官方 attachment 服务（`ctx.attachments` 校验落盘），进入待发送缓冲，随文本作为一条消息提交（image content block 引用 `ImageAttachmentRef`）。仅支持 PNG，单图上限 5MB；视觉识别由模型端视觉能力或技能完成。
- CLI 渲染：已完成的对话、工具与命令结果追加到普通终端 scrollback；输入、面板与 statusline 只占用末尾的短暂区域并按键重绘，因此 VS Code 可原生滚轮回看和选中文本。模型运行时，`preset` 左侧显示带探索图标与词汇的动态状态（如 `◉ Exploring`），临时区域按完整行批量显示 reasoning、tool-call 与回答流；完成后最终结果追加到 scrollback。Markdown 回答会在 CLI 中做轻量标题、列表、表格、代码块与行内强调渲染，避免半截 token 直接造成排版抖动。四行 statusline：身份行显示 `BUILD | [model] | cwd | 标题`，第二行显示 Context 块状进度与 in/out/cache 用量，第三行固定展示 prompt、skills、hooks、MCP、最近工具结果和后台 jobs，第四行展示 permission 与 `Shift+Tab` 提示；面板打开时整组 statusline 让位给面板。
- Agent preset：`/preset` 读取 Harness 官方 `standard`、`code`、`minimal`、`cordis` 组合；空会话可用上下键选择并即时 recompose，首轮产生内容后锁定，恢复会话时按 durable preset 事件重建相同组合。
- `approval/request` 审批闭环：`Y` 允许一次、`N`/`Esc` 拒绝；队列串行处理；审批到达前已输入的 `y`/`n` 会被自动消费。审批卡片展示将要执行的修改（file_path 与 `-/+` 行级 diff 预览，来自已记录的 tool-call 参数）。
- Thinking 折叠：流式过程实时显示动态 `thinking…`，完成后折叠为 `✻ thinking · N lines · 1.2s`（保留最近 5 块）；`Ctrl+O` 第一次展开当前会话全部折叠块，再次按下全部收起。
- 工具结果结构化：unified diff 结果红绿行级渲染；bash 类工具显示 `$ command` 标题；连续并行工具折叠为 `TOOLS` 区域，使用 `Ctrl+O` 展开/收回；skill、工具、结果、approval、hook 使用不同图标；普通多行工具输出显示首行和剩余行数，避免把完整结果压成一条不可读文本。
- reasoning 过程实时显示为动态 `thinking…`，完成后变为静态 `✻ thinking`；展开后以低对比度连续文本显示，不使用大边框；使用 `Ctrl+O` 收回。
- 回答耗时：每个完成的 assistant 回答末尾显示 `✓ finished in ...`；包含工具调用时追加 `· N tools`。
- 长任务可见性：`/jobs` 打开基于官方 `ctx.jobs` 的后台任务面板，显示任务 id、状态和摘要；任务变化会自动刷新；选中任务后按 `Enter`/`Tab` 读取输出、`k` 请求取消、`r` 刷新，Esc 返回输入区。流式任务输出按官方单一游标语义显式读取，不后台轮询。没有挂载 jobs 服务时会给出明确提示。
- 问卷交互：模型调用 `ask_user_question` 时在输入区上方打开原生问卷面板；支持数字键单选、空格/数字多选、上下键移动、Tab/Enter 提交、Esc 取消，并识别 `plan-review` 意图。
- Hook 事件：`⚡ hook · <point> · <dialect>` 调用与结果（`↳ allow · 12ms`）在对话流中展示。
- `Shift+Tab` 通过 `permissionPresets.set` 持久化切换权限预设（显示值来自 durable `permission/preset` 事件，无 `custom` 闪烁）；命令菜单打开时 `Tab` 只将选中项补全到输入框，`Enter` 才执行命令。
- 输入编辑：光标移动（←→/Home/End/`Ctrl+A` 行首/`Ctrl+E` 行尾/`Alt+←→` 按词）、退格/Delete、`Ctrl+J` 换行、`↑↓` 历史（仅光标在行首/行尾时切换；中段按 ↑↓ 移动光标行）、粘贴（bracketed paste，超长内容输入框内部滚动跟随光标）、`Ctrl+U` 清空、`Ctrl+F` 历史搜索面板、`Ctrl+G` 用 `$EDITOR` 编辑、`Ctrl+P` 命令面板；输入历史持久化到 `$DSH_HOME/dsh-tui/history.jsonl`。
- `!` bash 模式（参考 Claude Code）：输入 `!` 时输入框与上下两条规则线变为绿色，`Enter` 在本地 shell 直接执行命令，输出与退出码以操作日志形式回显（多行输出逐行渲染，60s 超时，最多回显 12 行）。
- CLI 使用普通终端缓冲区，不进入备用屏幕。文本拖拽、复制和滚轮由终端模拟器原生处理；启动时会显式关闭常见鼠标报告模式，避免 VS Code 等终端把滚轮伪装为 `↑/↓` 而切换输入历史；非多行输入时 `↑/↓` 切换历史提示词，多行输入时 `↑/↓` 移动光标；`Ctrl+O` 负责展开/收起区域。
- 所有面板（命令菜单/模型选择/会话选择/历史搜索/命令面板/effort/问卷/帮助/审批）统一显示在输入框下方，输入框始终可见。
- 命令：`/help`、`/clear`（仅清视图）、`/model`（模型选择器，经 `ctx.llm.listProviders/listModels` 列出；选择后**当前会话立即生效**——经 `agent/request` waterfall 原位覆盖 provider/model，同时 `agentDefaultModel.saveSelection` 持久化为新会话默认）、`/preset`（空会话选择官方 agent preset，首轮后锁定）、`/effort`（档位来自 `resolveModelInfo` 的 `reasoning.efforts`，随模型/提供商动态）、`/jobs`（查看后台长任务）、`/resume`（会话选择器，仅列当前目录、按最近使用排序，恢复时重建记录的 preset）、`/recap`（本地统计当前会话轮次、工具、耗时和最近提问，不调用模型）、`/export`（导出当前转录为 Markdown 到 cwd）、`/steer`（运行中不中断地纠正方向）、`/mcp`（展示 profile 中配置的 MCP 服务器）、`/hooks`（展示 hook 桥接）、`/exit`；`/compact`、`/goal`、`/feedback`、`/plan` 等走 Harness 官方 `ctx.commands.execute`。
- 命令/技能菜单：名称颜色差异保留，同时追加 `cmd` / `skill` 标签；`Ctrl+P` 命令面板显示当前搜索词，命令按 Enter 执行、技能按 Tab 回填到输入框。
- `?` 快捷键帮助；`Ctrl+C` 运行中中断（保留已生成文本）、空闲退出；`Esc` 运行中中断；`Ctrl+D` 空输入退出；`SIGTERM` 干净退出。启动参数 `-c` / `--continue` 从 Harness 的 `ctx.cmdlineArgs` 读取，并恢复当前目录最近一次会话。
- 启动能力探测：硬依赖服务缺失时给出指明 bundle 的清晰报错并退出，不静默跑到半路。
- 主题：`DSH_TUI_THEME=deepseek|mono|light` 切换配色，非法值回退默认。
- 窄终端（80×24）与 Unicode 宽度（CJK 双宽）处理；resize 自适应。

## 快捷键

| 键 | 动作 |
|---|---|
| `Enter` | 发送（命令菜单打开时执行选中项） |
| `Ctrl+J` | 输入内换行 |
| `Ctrl+C` | 运行中中断；空闲时退出 |
| `Esc` | 运行中中断当前回合；空闲时清空输入/关闭面板/清除选区 |
| `Ctrl+O` | 全部展开/全部收起推理全文与并行工具组 |
| `Ctrl+A` / `Ctrl+E` | 光标跳到行首 / 行尾 |
| `Ctrl+K` | 删除光标到当前行末尾的内容 |
| `Alt+← →` | 按词跳转光标 |
| `Ctrl+G` | 用 `$EDITOR` 编辑输入行 |
| `Ctrl+F` / `Ctrl+R` | 输入历史搜索 |
| `Ctrl+W` / `Alt+Backspace` | 删除光标前一个词 |
| `Ctrl+P` | 命令面板（过滤并运行任意命令/skill） |
| `Shift+Tab` | 切换权限模式 |
| `/jobs` 面板 | `↑↓` 选择；`Enter`/`Tab` 读取输出；`k` 取消；`r` 刷新；任务状态变化自动刷新；`Esc` 关闭 |
| `Tab`（命令菜单打开时） | 将选中命令或技能补全到输入框 |
| `↑ ↓`（preset 面板打开时） | 浏览 agent preset；`Enter` / `Tab` 选择，`Esc` 关闭 |
| `1`–`9` / `Space`（问卷打开时） | 选择或切换问卷选项；`↑↓` 移动，`Enter`/`Tab` 提交，`Esc` 取消 |
| `Cmd/Ctrl+V` 粘贴图片 | 由终端转换为 OSC 1337 / kitty 图形序列传入，图片进入待发送缓冲，随文本一并发送；空输入时 `Backspace` 移除最后一张 |
| `@` | 文件引用：逐级浏览工作目录，`Enter` 选中后提交时展开文件内容 |
| `↑ ↓` | 输入历史；回看状态下滚动内容（`↓` 回到底部） |
| `← →` / `Home` / `End` | 移动光标 |
| 鼠标 | 完全由终端模拟器处理文本选择、复制和滚轮 |
| `PgUp` / `PgDn` | 滚动回看 |
| `!` | bash 模式：输入框与规则线变绿，`Enter` 本地执行 shell 命令并回显输出 |
| `/` | 命令菜单（继续输入过滤） |
| `?` | 快捷键帮助 |
| `Ctrl+U` | 清空输入 |
| `Ctrl+D` | 空输入退出 |

### VS Code 滚轮诊断

若 VS Code 集成终端的滚轮仍改变输入历史，可仅运行一次：`DSH_TUI_DEBUG_INPUT=1 npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile tui`。滚动一次后退出，控制序列会记录到 `$DSH_HOME/dsh-tui/input-debug.log`；该开关只记录完整控制序列，不记录普通输入或粘贴内容。

## MCP 服务器

MCP 由官方 `@deepseek-ai/dsh-mcp-client` 提供：在 profile 补丁层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）为每个服务器插入一行，启动时自动连接，工具以 `mcp__<server>__<tool>` 注册进模型工具集（模型自动可见，无需 TUI 干预）。`/mcp` 查看本 profile 已配置的服务器。

```yaml
- insert:
    # 浏览器工具（Playwright MCP）
    - id: mcp-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: npx
        args: ['-y', '@playwright/mcp']

    # 本地 MySQL MCP
    - id: mcp-mysql
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mysql
        transport: streamable-http
        url: http://localhost:3307/mcp
```

> 注意：stdio 型服务器会 spawn 本地进程，可能扰动终端 raw 模式（`\r` 被转 `\n`）；TUI 已在每次输入事件前防御性重设 raw 模式，若仍遇输入异常，优先改用 streamable-http 或在命令外套 wrapper 脚本。

## Hooks

dsh 提供 Claude Code / Codex 风格的 shell hook 桥接：在 profile 补丁层配置 `@deepseek-ai/dsh-hooks-claude-code`（或 `dsh-hooks-codex`），指向现有 `hooks.json`，外部 hook 命令即在 harness 拦截点（`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop`/`Subagent*`）运行。`/hooks` 查看本 profile 已配置的桥接；hook 执行在对话流中显示为 `⚡ hook · <point> · <dialect>` 与结果（`↳ allow · 12ms`）。

```yaml
- insert:
    - id: hooks-cc
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ./.claude/hooks.json   # 相对路径按启动 cwd 解析
```

## 测试

`test/mock-bundle` 是本地 mock provider + 审批门控工具，用于无凭据验证：流式、usage 折叠、工具审批、中断。

```sh
export PATH="$HOME/.npm/_npx/<缓存>/node_modules/.bin:$PATH"   # 或安装 dsh 到 PATH
export DSH_HOME=/private/tmp/<name>
dsh plugin --profile tui add /absolute/path/to/dsh-tui
dsh plugin --profile tui add /absolute/path/to/dsh-tui/test/mock-bundle
dsh --profile tui --dump-config   # 确认 mock-provider / tui-runner 已加载
```

PTY 端到端脚本（`test/pty-*.py`，需要 `DSH_HOME` 指向已安装 mock bundle 的 profile）：

```sh
DSH_HOME=$DSH_HOME python3 test/pty-e2e.py        /tmp/e2e.log        # 流式/审批/usage/权限/中断/退出
DSH_HOME=$DSH_HOME python3 test/pty-resume.py     /tmp/resume.log     # /compact/窄终端/会话恢复
DSH_HOME=$DSH_HOME python3 test/pty-image.py      /tmp/image.log      # OSC 1337 / kitty 图片粘贴→attachment→提交
DSH_HOME=$DSH_HOME python3 test/pty-file.py       /tmp/file.log       # @ 引用→默认列表→目录浏览→选中→展开→提交
DSH_HOME=$DSH_HOME python3 test/pty-features.py   /tmp/features.log   # 审批 diff/推理折叠/工具组/export/历史搜索/模型实时切换
DSH_HOME=$DSH_HOME python3 test/pty-interaction.py /tmp/interaction.log # 菜单、快捷键、多行输入、面板与状态行
```

## 实现约束

- bundle 以 `link:` 安装时，Node 从源码目录解析 import，因此本包**不静态 import 任何 `@deepseek-ai/*`**：只用 Cordis 注入服务与原始 durable event payload（`session/event`、`agent/status`、`approval/request`、`approval/asked/decided`、`permission/preset`、`request/context`、`assistant/message.usage`）。
- 用户消息以原始 `{ id, role: 'user', content: [{type:'text',text}], source:{kind:'user'} }` 形状经 `agent.followup` 提交（等价于 `createUserMessage` 产物）；带图消息在 content 前置 `{type:'image', attachment: ImageAttachmentRef}` 块，ref 来自 `ctx.attachments.saveImage`（官方 `ImageBlock` 形状）。
- 权限显示来自会话 `permission/preset` 事件 fold，切换时乐观更新，避免 `custom` 瞬时闪烁。

## 已知限制

- 单会话为主；`/resume` 会切换当前 agent（历史事件随 durable log 重放显示）。
- 无会话内全文搜索；输入框选区为行级渲染（多行选区的列定位为近似值）。
- `Esc` 只清空以 `/` 开头的输入；审批/选择器用独立按键路径。
- 图片粘贴仅支持 PNG（iTerm2 OSC 1337 与 kitty graphics protocol 直接传输）；不支持 sixel、OSC 52 剪贴板图片；不支持显示预览（附件回显为尺寸/大小行）。
- `@` 引用按 UTF-8 解码，二进制文件与超 16KB 部分会被跳过/截断；`@` 面板逐级浏览目录（每次只读当前层级），深层文件可手动输入完整相对路径。
- 模型实时切换依赖 `agent/request` waterfall 覆盖 provider/model，恢复会话时覆盖重置（沿用会话自身模型）。
- `/settings` 使用官方 `ctx.settings`（`$DSH_HOME/settings.yaml`）持久化主题、欢迎摘要和输入历史开关；变更即时生效。
- Windows 未验证。
