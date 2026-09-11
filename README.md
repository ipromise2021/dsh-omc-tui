# DSH OMC TUI

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-ipromise2021%2Fdsh--omc--tui-181717?style=flat-square&logo=github)](https://github.com/ipromise2021/dsh-omc-tui)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/Harness-0.1.5--rc.1-00bcd4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?style=flat-square)](package.json)

**DeepSeek Harness 的终端原生 TUI**

> **当前适配：DeepSeek Harness `v0.1.5-rc.1`（npm `latest`）**
> **v0.2.15：任务状态实时更新、终端回执防乱码、工具输出层级优化与 Markdown 代码块呈现修复。**

独立视口差分渲染，提供双模态智能视觉、原生级划选回看、实时任务与 Plan 联动、行内审批与 Danger Guard 看门狗。

[架构与全功能实现](ARCHITECTURE.md) · [界面与设计说明](PRODUCT_SHOWCASE.md) · [兼容性契约](HARNESS_COMPATIBILITY.md) · [变更日志](CHANGELOG.md)

</div>

![DSH OMC TUI 主界面](assets/welcome.png)

`dsh-omc-tui` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ANSI 终端界面插件。

插件专注于终端渲染与键盘交互；模型、会话、工具、权限、后台任务及持久化均由 Harness 官方服务提供。

项目参考了 Claude Code 的交互习惯与终端美学，采用独立备用屏幕与自研视口差分渲染架构，在彻底避免历史刷屏与乱码的同时，依然保留了顺滑的滚轮回看、鼠标智能分词划选与纯净文本复制等原生级体验。

> 📌 **当前版本**：`v0.2.15` 面向 DSH `v0.1.5-rc.1`；已完成源码契约核对、隔离 Profile 启动、`/status`、权限切换、单元测试和模块导入验证。欢迎使用、点 Star 和反馈问题。

## 当前 Harness 适配：DSH `v0.1.5-rc.1`

`v0.1.5-rc.1` 将会话持久化升级为 V3/`SessionHandle`，移除插件环境中的 `ctx.agent`，并将系统 persona 配置拆分为 `personaPrefix` 与 `personaSuffix`。TUI 继续只通过 `ctx.agents.create/resume`、`dispose()`、`snapshotEvents()` 与 `sessionQuery` 使用官方生命周期；Profile patch 已迁移至 `personaPrefix`。

DeepSeek-V41-Flash（模型 ID `deepseek-flash`）现为上游默认模型，支持文本、图片以及会话内系统提示词更新。TUI 的初始化兜底模型和 `/vision` 常用模型候选均已纳入该模型。

| 范围 | 结果 | 验收 |
| :--- | :--- | :--- |
| Session 与权限 | 新旧事件读取集中到兼容薄层，权限读取使用 rc.1 Session 签名 | 双代契约单测、真实 `/status` 与权限轮换通过 |
| Profile 与 preset | 补挂 subagent model-selection Host 服务，删除过期 patch 条目 | rc.1 `--dump-config` 无警告，standard preset 启动通过 |
| 依赖 | 19 个 DSH peer dependency 对齐 `^0.1.5-rc.1` | 预发布依赖可被正确解析 |
| 既有能力 | Agent、Jobs、附件、命令与模型能力调用签名保持兼容 | 源码级比对通过；真实 Provider/图片 E2E 待补 |

适配期间不会为了同步上游而复制其 UI 功能，也不会提前移除本地安全保护；只处理 Harness API 与 durable event 契约产生的实际兼容问题。

## 插件功能

### 1. 独立视口与原生级终端体验

- **备用屏幕与差分渲染**：采用终端备用屏幕（Alternate Screen，类似 Vim/tmux）与自研 Viewport 差分渲染引擎。会话在独立全屏视口中运行，退出时一键恢复原 Shell 画面，不向终端 Scrollback 遗留大段历史或混乱空行。
- **顺滑滚轮回看与智能划选**：内置 SGR 鼠标协议驱动的视口滚动；支持单击拖拽选区、双击中英文分词选择、三击选整行，复制时自动剥离 ANSI 样式纯净复制到系统剪贴板，亦可配合终端修饰键（macOS `Option` / Linux `Shift`）强制使用终端原生划选。
- **工业级防乱码与终端健壮性**：完整消费 ECMA-48 CSI / OSC / DCS / SGR 回执，杜绝窗口缩放、焦点切换、外部编辑器返回或休眠唤醒时的控制序列乱码；后台挂起恢复后自动检测并修复 Raw Mode、输入流与鼠标追踪。
- **语义阅读锚点与渐进防误触**：终端 Resize 窗口缩放时按内容语义锚点锁定阅读位置；生成期间按 `Esc` 先平滑滚动回底部、再次按下才触发任务中断。

### 2. 双模态视觉体系（原生直传 + 自主决策 Sidecar）

支持在终端直接按 `Cmd/Ctrl+V` 粘贴 macOS / 桌面剪贴板图片，或通过 iTerm2 OSC 1337、Kitty Graphics 协议直接发送图片；内置高分屏自适应缩放引擎（2048px 安全基准线），并通过 Harness Attachment 管道自动管理与落盘。

- **原生视觉直通**：连接多模态主模型（如 DeepSeek-V41-Flash、GPT-4o、Claude 3.5）时，图片作为原生 image content block 零延迟直传。
- **自主旁路 Sidecar**：连接纯文本/代码模型时，主 Agent（无需人工切换主模型、无需手动调用插件）结合任务意图**自主判断**何时需要看图并自动触发底层的 `analyze_image` 视觉工具；TUI 在后台动态拉起隔离的临时视觉 Subagent，定向提取 OCR 与 UI 布局细节后立即销毁并回传主会话。
- **待发图片快捷管理**：图片以 `[Image #n]` 出现在输入框前缀；若需撤回，将光标移到文本开头后按 `Backspace`，可按后进先出顺序逐张移除，文本草稿不会丢失。

> **💡 视觉子代理模型与 API Key 配置提示**：
> - **使用 DeepSeek API 订阅**：优先配置 DeepSeek-V41-Flash（执行 `/vision deepseek-official/deepseek-flash`）；也可继续使用 `deepseek-v4-flash-vision-exp`。子代理与主模型**共用同一套 DeepSeek API Key，无需额外更换或配置新的 Key**。
> - **使用其他供应商视觉模型**：若子代理希望调用其他提供商（如 OpenAI `gpt-5.6-luna`、Qwen 等），只需在 DSH 中配置好对应供应商的 API Key，再执行 `/vision <provider>/<model>`（或直接输入 `/vision` 查看常用路由推荐）绑定子代理视觉模型即可。

### 3. 沉浸式树遍历排版与代码高亮

- **Thinking 智能折叠与 `Ctrl+O` 穿透**：流式阶段显示平滑点阵动画与耗时；思考完毕自动收折为一行徽标；随时按 `Ctrl+O` 可原位穿透展开思维链与并行工具组，绝不产生终端刷屏与重放闪烁。
- **精细化 Markdown 与层级 Diff**：四边闭合卡片与带语言标签的代码块呈现；展开工具调用后的 Diff 差异严格保持在所属工具下方层级缩进，并按列宽自适应截断。
- **四款护眼主题**：内置 `claude`（暖色调）、`deepseek`（蓝色调）、`mono`（黑白）与 `light`（浅色，未选主题时自动感知终端背景）。

### 4. 实时任务中心与 Plan 联动 (Tasks & Plan)

- **Durable 实时状态感知**：全面接入 Harness 的 `todo/write` 持久化快照，任务创建、进行中与已完成状态实时流式驱动 `/tasks` 任务中心面板与底部状态栏。
- **断点完美复原**：历史会话恢复（`-c` / `/resume`）时，所有任务项与完成进度通过 Event Sourcing 100% 稳定重建。
- **后台长任务 (Jobs)**：支持 `Ctrl+B` 将运行中的 Bash 放入后台，`/jobs` 实时读取输出流并支持快速刷新、取消或退出确认拦截。

### 5. 行内安全审批与原生看门狗 (Danger Guard)

- **行级红绿 Diff 审批**：文件修改与敏感命令执行前弹出结构化行内审批卡片，清晰呈现行级差异，支持单键允许/拒绝与会话级权限提权（`Shift+Tab`）；单选、多选与自由文本问答直接在终端内完成。
- **事前 AST 危险守卫**：内置 Danger Guard 原生 Watchdog，在工具执行前拦截 `rm -rf /`、Fork 炸弹、磁盘直写等危险指令，覆盖 Unix/macOS/Windows 多平台，支持 `.dsh/danger-rules.json` 自定义全段锚定规则。

### 6. 全景状态栏 (HUD) 与效率工作流

- **4 行全景自适应状态栏**：实时呈现当前模型、Plan/Build 模式、权限档位、会话 Context 进度条与水位预警、Git 分支/变更/ahead/behind、活跃扩展（Skills/MCP/Hooks）与最近响应速度。支持 `detailed`、`compact` 和 `minimal` 三种密度。
- **无污染旁路提问 (`/btw`)**：后台创建独立临时会话回答旁路问题，完全不污染主会话上下文与 Token 预算。
- **自动与平滑压缩 (`/compact`)**：上下文达到阈值（Harness `compaction-basic.thresholdRatio`，默认 80%）时在回合内自动触发平滑压缩，亦可通过 `/compact` 手动触发。
- **会话回顾与空闲总结 (`/recap`)**：随时生成会话历史摘要；空闲 15 分钟时自动生成呼吸总结。
- **工作区逐级下钻 (`@文件`)**：输入 `@` 浏览工作区目录树，支持交互过滤、子目录钻取与文件内容高亮注入。
- **安全导出 (`/export`)**：在专用面板中校验并导出 Markdown 会话记录，默认安全隔离于专用配置目录。

## 环境要求

- Node.js 20 或更高版本
- DeepSeek Harness [`@deepseek-ai/dsh@0.1.5-rc.1`](https://www.npmjs.com/package/@deepseek-ai/dsh)（预发布版本，需显式指定）
- 支持 ANSI 256 色的终端
- 图片显示建议使用 iTerm2 或支持 Kitty Graphics 的终端

目前主要在 macOS、VS Code Terminal 和 iTerm2 中开发与验证。

## 安装和启动

从 npm 安装到 `tui` profile（推荐，直接分发构建产物，无需 Git 依赖构建授权）：

```sh
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile tui add dsh-omc-tui
```

也可以从 GitHub 安装（会拉取源码，首次需按 pnpm 提示授权 `prepare` 构建脚本）：

```sh
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile tui add github:ipromise2021/dsh-omc-tui
```

启动：

```sh
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 --profile tui
```

如果已经全局安装 DSH，也可以直接运行：

```sh
dsh --profile tui
```

### 💡 快捷启动别名（推荐）

日常使用与开发中，我更习惯在终端配置文件（如 `~/.zshrc` 或 `~/.bashrc`）中添加别名，直接输入 `dsh-omc-tui` 或 `omc` 快速启动（主要就是想少敲点键盘）：

```sh
# 添加到 ~/.zshrc 或 ~/.bashrc
alias dsh-omc-tui="dsh --profile tui"
alias omc="dsh --profile tui"
```

配置后，在任意工作目录下直接执行：

```sh
dsh-omc-tui
# 或
omc
```

### 本地开发安装

建议使用单独的 `DSH_HOME`，避免影响日常配置：

```sh
export DSH_HOME=/private/tmp/dsh-tui-dev
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile tui add /absolute/path/to/dsh-omc-tui
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 --profile tui
```

## 常用快捷键

| 按键 | 功能 |
| :--- | :--- |
| `Enter` | 发送消息或确认当前选项 |
| `Ctrl+J` | 输入多行内容 |
| `Ctrl+C` | 中断当前回合；空闲时退出 |
| `Ctrl+O` | 展开或折叠 Thinking 与工具组 |
| `Ctrl+P` | 打开命令面板 |
| `Ctrl+R` / `Ctrl+F` | 搜索输入历史 |
| `Ctrl+G` | 使用 `$EDITOR` 编辑 Prompt |
| `Shift+Tab` | 切换权限预设 |
| `Ctrl+B` | 将正在执行的 Bash 放入后台 |
| `Ctrl+V` | 粘贴文本或终端图片 |
| `@` | 打开文件引用补全 |
| `?` | 打开帮助面板 |

## 常用命令

| 命令 | 功能 |
| :--- | :--- |
| `/model` | 选择模型，并根据模型能力选择 reasoning effort |
| `/vision <provider>/<model>` | 配置 `analyze_image` 使用的旁路视觉模型 |
| `/provider` | 管理模型提供方、自定义端点和模型列表 |
| `/plan [off\|message]` | 进入或退出 Harness Plan 模式，可携带规划说明和图片 |
| `/status` | 查看会话、模型、Token 和扩展状态 |
| `/settings` | 设置主题、状态栏密度和 Context 预警 |
| `/new` | 使用当前模型、权限和预设创建新会话 |
| `/btw <问题>` | 在独立临时会话中提问，不加入主会话历史 |
| `/compact` | 压缩当前会话上下文 |
| `/tasks` | 打开任务中心；默认查看 Agent Plan，可切换后台任务 |
| `/jobs` | 兼容入口；直接打开后台任务页，读取输出、刷新或取消任务 |
| `/skills` | 浏览并在 TUI Profile 中切换 Skill 的 on/off 状态 |
| `/resume` | 恢复当前工作目录下的历史会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/mcp` / `/hooks` | 查看已挂载的 MCP 与 Hook 状态 |
| `/export` | 在导出面板中选择目录并确认导出 Markdown |
| `/exit` | 安全退出终端（有活跃后台任务时弹出确认） |

其他命令和快捷键可以在 TUI 中通过 `?`、`/help` 或 `Ctrl+P` 查看。

`/export` 打开导出面板，默认填入 `$DSH_HOME/exports/<项目名>/`；未设置 `DSH_HOME` 时即为 `~/.dsh/exports/<项目名>/`。首次按 Enter 校验时会创建该默认目录，避免会话导出文件混入 Git 工作区。可直接在面板的 `Directory` 输入框中编辑相对或绝对目录；自定义目录不会自动创建，按 Enter 会校验目录存在、类型与可写性，再确认导出；校验失败会在面板内显示原因且不会写入。导出目录和 Markdown 文件分别以仅当前用户可访问的权限创建。导出包含用户消息、助手回复与工具调用参数，分享前请自行检查敏感信息；文件名带会话尾号和 UTC 时间戳，不会覆盖此前导出结果。

### Reasoning effort

`/effort` 严格显示当前模型通过 Harness 声明的档位，不会猜测模型能力。官方适配器或内置模型目录通常会提供这类元数据；第三方中转、兼容接口和本地反向代理的模型列表往往只返回模型 ID，无法自动提供思考等级。此时状态栏显示 `effort PROVIDER`，表示请求未指定档位并继续使用模型或网关默认行为，不代表模型调用失败。

通过 `/effort` 或模型选择器确认档位后，TUI 会调用 Harness 的 `agentDefaultModel.saveSelection()` 保存完整的 `{ provider, model, reasoningEffort }` 默认选择。该档位立即用于当前 TUI，之后创建的新会话也会恢复并显示相同等级；例如选择 `high` 后，新会话状态栏仍显示 `effort HIGH`。直接执行 `/effort <id>` 时也会先校验当前模型声明的档位，不支持的值不会写入设置。切换到未声明 reasoning effort 的模型时会清除旧覆盖值，并回到 `PROVIDER`。

需要在 TUI 中选择档位时，可在 `settings.yaml` 的具体模型上声明 `reasoningEfforts`。下面是本地反向代理 `local-cpa` 提供 `gemini-3.7-flash`、且该模型支持 `low`、`medium`、`high` 三档时的配置示例：

```yaml
llm-pi-ai:
  providers:
    local-cpa:
      apiKeyEnv: LOCAL_CPA_API_KEY
      api: anthropic-messages
      baseURL: http://127.0.0.1:8317
      models:
        - id: gemini-3.7-flash
          name: gemini-3.7-flash
          reasoningEfforts:
            low: low
            medium: medium
            high: high
```

映射左侧是 TUI 使用的 Harness effort ID，右侧是发送给网关的实际值。若中转服务使用不同拼写，可以映射为它要求的值；例如 `high: deep` 会在 TUI 中显示 `HIGH`，并向中转发送 `deep`。只声明模型和网关真实支持的档位，未声明的值不会出现在选择器中，也不会由插件强制发送。修改模型能力配置后需要重启 DSH；随后通过 `/effort` 选择一次，所选档位会由 Harness 设置服务持久化，不需要编辑插件内部文件。

## 主题和终端显示

内置以下主题：

- `claude`：暖色调
- `deepseek`：蓝色调
- `mono`：黑白模式
- `light`：浅色模式

终端宽度、ANSI 控制序列、中文、emoji 和组合字符由本地渲染器处理，不依赖 Ink、Blessed、Chalk 或其他重型终端 UI 库。

## 项目结构

```text
src/
├── commands/    内置命令
├── core/        事件、Git 和基础工具
├── input/       输入编辑与补全
├── panels/      审批、模型、Jobs、Skills 等面板
├── renderer/    ANSI、Markdown、Transcript 和 Statusline
└── index.js     TUI 控制器与终端事件循环
```

更完整的架构说明见 [PRODUCT_SHOWCASE.md](PRODUCT_SHOWCASE.md)，Harness 接口适配情况见 [HARNESS_COMPATIBILITY.md](HARNESS_COMPATIBILITY.md)。

## 开发与验证

```sh
npm test
npm run verify
```

如果准备了不含凭据的 Harness 测试夹具，还可以运行 PTY 集成测试：

```sh
DSH_TEST_FIXTURE_HOME=/path/to/dsh-home npm run test:pty
```

## 安全看门狗 (Danger Guard) 与安全边界

`dsh-omc-tui` 内置了原生安全看门狗（Dangerous-Command Watchdog），在 Harness 的 `tools/pre-execute` 执行前切入点进行结构化语法审查与单调阻断（Deny-or-Abstain），防止模型或子代理意外执行高破坏性命令。

### 1. 内置防护覆盖矩阵

| 平台 / 工具 | 结构化拦截的危险操作模式 |
| :--- | :--- |
| **Unix / Linux / macOS** (`bash`, `sh`, `zsh` 等) | `rm -rf /`、`rm -rf ~`（含多层相对路径越界 `a/../../b`、通配符与变量展开）<br>`chmod -R 777 /`、`find / -delete`、`find / -exec rm ...`<br>`mkfs.*`、`fdisk`、`dd of=/dev/sd*` 直写磁盘设备<br>`git push --force`（保护 remote 分支，安全选项 `--force-with-lease` 正常放行）<br>`:(){ :|:& };:` 等 Fork 炸弹 |
| **Windows** (`pwsh`, `powershell`, `cmd`) | `Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\*`、`rd /s /q C:\`<br>`Clear-Disk`、`Initialize-Disk`、`Format-Volume`<br>`format C:` 磁盘格式化驱动器<br>`powershell -EncodedCommand` 混淆载荷还原审查 |
| **Shell 封装与深层混淆** | `sudo`、`env`、`exec`、`timeout`、`sh -c`、`bash -lc`、`cmd /c` 组合解构<br>ANSI-C `$'\x72\x6d'` / `$'\u0072\u006d'` / `$'\162\155'` 转义还原<br>深层嵌套子 Shell（`depth > 32`）与超长输入（`> 128KB`）采用 Fail-Closed 默认阻断 |

### 2. 自定义规则配置 (`.dsh/danger-rules.json`)

可在当前项目根目录或配置路径放置 `.dsh/danger-rules.json` 扩展自定义规则：

```json
{
  "enabled": true,
  "block": [
    "DROP\\s+DATABASE",
    "kubectl\\s+delete\\s+namespace"
  ],
  "allow": [
    "^git status$",
    "^npm test$"
  ]
}
```

- `block`：扩展自定义高危正则表达式（命中即拦截）。
- `allow`：强制基于全段锚定（`^(?:pattern)$`）放行安全白名单，杜绝子串或子 Shell 注入逃逸。
- 完全停用：设置环境变量 `DSH_DANGER_GUARD=off` 即可停用看门狗。

### 3. 威胁模型与安全边界说明

> [!IMPORTANT]
> **安全边界提示**：
> 1. Danger Guard 定位于 Agent 工具执行前的**启发式防误操作防线**，专注于拦截模型误触发的破坏性指令；
> 2. 静态分析无法穷尽所有动态构造（如运行时管道下载脚本 `curl | sh`、图灵完备混淆）；
> 3. **必须叠加使用 Harness 权限预设（Permission Presets）、沙箱隔离（Docker / Container / MicroVM）与生产凭据管控**，切勿将纯静态守卫视为唯一的安全沙箱。

## 当前限制

- 项目仍处于 pre-release 阶段，Harness 上游接口变化后可能需要同步适配。
- Windows 和更多真实模型提供方仍需要进一步验证。
- `/plugins`、`/fork`、`/rewind` 等能力暂未在 TUI 中实现。
- 本插件只提供 TUI；模型、工具、Sandbox 和会话持久化由 DSH profile 提供。

## 反馈与贡献

个人开发的开源项目，以实际终端使用体验为基础，按需开发、持续完善。欢迎使用、点 Star，也欢迎反馈 Bug 和提出功能建议。

如果遇到问题，可以提交 [Issue](https://github.com/ipromise2021/dsh-omc-tui/issues)。建议附上 DSH 版本、Node.js 版本、操作系统、终端类型和复现步骤。也欢迎直接提交 PR。

提交代码前请运行：

```sh
npm test
npm run verify
```

提交信息建议使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`。

## License

[MIT](LICENSE)
