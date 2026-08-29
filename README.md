# DSH OMC TUI

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-ipromise2021%2Fdsh--omc--tui-181717?style=flat-square&logo=github)](https://github.com/ipromise2021/dsh-omc-tui)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/Harness-0.1.1--rc.2-00bcd4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?style=flat-square)](package.json)

**DeepSeek Harness 的终端原生 TUI**

保留终端 Scrollback，提供自主决策视觉 Subagent、多模态图片直贴、行内审批、Plan/Jobs、模型选择和上下文状态栏。

[架构与全功能实现](ARCHITECTURE.md) · [界面与设计说明](PRODUCT_SHOWCASE.md) · [兼容性记录](HARNESS_COMPATIBILITY.md) · [变更日志](CHANGELOG.md)

</div>

![DSH OMC TUI 主界面](assets/welcome.png)

`dsh-omc-tui` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ANSI 终端界面插件。

插件专注于终端渲染与键盘交互；模型、会话、工具、权限、后台任务及持久化均由 Harness 官方服务提供。

个人比较喜欢 Claude Code 终端的交互方式，项目参考了它的交互习惯，在终端中运行 DSH 的同时，完整保留了原生滚轮回看、文本划选与自由复制等功能特性。

> 📌 **项目说明与动态**：
> - **版本基准与适配**：插件依赖基线为 DSH `v0.1.1-rc.2`。截至 2026-08-29，官方 npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 `latest` 与 `next` 均为 `0.1.1-rc.2`。附件保存、会话事件与子代理创建的源码契约已完成比对；图片、视觉 Sidecar 与 PTY 的真实 Profile 回归仍会持续补充。
> - **后续版本跟进**：截至 2026-08-29，DSH `v0.1.2-alpha.1` 尚未发布到 npm registry，因此本插件暂不将其声明为可安装依赖或正式兼容基线。待上游 npm 包发布后，将继续验证 API、durable event、模型能力与真实 Profile，并按验证结果持续适配和保持向后兼容。
> - **持续维护**：功能会按需扩展，Bug 也会持续修复。欢迎使用、点 Star 和反馈问题。

## DSH `v0.1.1-rc.2` 适配记录

`v0.1.1-rc.2` 的发布重点是 DeepSeek 图片处理：适配器优先使用 Files API 上传并复用图片文件，且会按模型要求自动缩放、转换图片格式。[查看官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases#release-dsh-v0.1.1-rc.2)

当前发布版插件以 npm 可获取的 `v0.1.1-rc.2` 为安装和兼容基线；可在官方 npm 页面查看 [`@deepseek-ai/dsh` 的版本与 dist-tag](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)。GitHub 上游虽已提供 `v0.1.2-alpha.1` 预览版本，但对应 npm 包尚未正式发布；待官方正式发布后，本插件将统一开展升级适配与兼容回归验证。

TUI 的 `saveImages/saveImage`、附件引用元数据、`agents.create({ agentOptions })` 与 `session/event` 使用方式均已与 rc.2 源码比对。因图片处理由 Harness 负责，TUI 保留本地 2048px 安全保护，真实图片回归确认前不移除它。

| 阶段 | 适配内容 | 验收结果 |
| :--- | :--- | :--- |
| 范围 | 结果 | 后续验证 |
| :--- | :--- | :--- |
| 依赖与服务契约 | 所有 DSH peer 依赖已提升到 rc.2；附件、Agent 创建和 durable event 源码接口保持兼容。 | 在实际 rc.2 Profile 中执行启动、创建和恢复会话。 |
| 图片附件 | `saveImages/saveImage` 与可复用 `attachmentId` 引用仍可用。 | 验证 PNG、JPEG、重复图片、超大图与格式转换。 |
| 原生与旁路视觉 | 原生 image content block 和 `analyze_image` Sidecar 的调用契约未变。 | 验证多图、取消和恢复会话后的附件读取。 |
| 回归 | 本项目单元与模块验证通过。 | 补跑带 Harness fixture 的 PTY/交互测试。 |

适配期间不会为了同步上游而复制其 UI 功能，也不会提前移除本地安全保护；只处理 Harness API 与 durable event 契约产生的实际兼容问题。

## 插件功能

### 保留终端 Scrollback

不进入备用屏幕。对话、工具调用、Thinking 和 Diff 会追加到终端普通缓冲区，可以直接滚动回看和选择复制。

### Harness 原生集成

会话恢复、Plan 模式、权限审批、Jobs、Skills、模型和图片附件都使用 Harness 官方服务与 durable event。TUI 只负责展示和交互。

### 智能视觉 Subagent（全自动自主决策识别）

deepseek-v4-pro/flash等纯文本模型，不具备直接接收多模态图片的能力。传统方案往往要求用户**手动切换全局模型**、**手动调用特定技能/插件**，或在外部识别后再复制文本，严重打断编程思路。

`dsh-omc-tui` 插件实现了 **零手动干预的自主旁路视觉架构（说人话就是子代理，主agent会自主分配给该代理执行）**：

- **图片无感直贴**：支持在终端直接按 `Cmd/Ctrl+V` 粘贴 macOS 剪贴板图片，或通过 iTerm2 OSC 1337、Kitty Graphics 协议直接发送图片。图片通过 Harness Attachment 管道自动管理与落盘。
- **Agent 自主决策调用**：**用户无需手动使用技能、无需手动执行插件命令，也无需临时切换主模型**。主 Agent（纯文本/代码模型）在接收到带图片上下文的提问时，会结合当前任务意图**自主判断**何时需要读取图片，并在需要时自动触发底层的 `analyze_image` 视觉工具。
- **瞬时旁路 Sidecar Subagent**：TUI 在后台动态拉起一个隔离的临时视觉 Subagent，定向解析图像细节、提取 OCR / UI 布局信息后立即销毁。
- **主会话无缝协同**：视觉识别结果以标准工具结果形式返回给主 Agent，主模型保持原有的模型身份、推理链与上下文记忆继续处理任务，既享受了主模型的纯粹代码推理能力，又获得了强大的多模态感知。

> **💡 视觉子代理模型与 API Key 配置提示**：
> - **使用 DeepSeek API 订阅**：推荐直接配置 `deepseek-v4-flash-vision-exp` 模型（执行 `/vision deepseek-official/deepseek-v4-flash-vision-exp`）。此时子代理与主模型**共用同一套 DeepSeek API Key，无需额外更换或配置新的 Key**。
> - **使用其他供应商视觉模型**：若子代理希望调用其他提供商（如 OpenAI `gpt-5.6-luna`、Qwen 等），只需在 DSH 中配置好对应供应商的 API Key，再执行 `/vision <provider>/<model>`（或直接输入 `/vision` 查看常用路由推荐）绑定子代理视觉模型即可。

### 行内审批与问题面板

文件修改和命令执行可在终端内查看 Diff 并选择允许或拒绝。Harness 的单选、多选和自由文本问题也可以直接在 TUI 中完成。

### 自适应状态栏

状态栏可以显示（参考了claude-hud插件的风格）：

- 当前模型、Plan/Build 模式和权限档位
- 会话累计 Context 进度与水位预警
- Git 分支、工作区变更和 ahead/behind 状态
- 最近工具、Skills、MCP、Hooks 和 Jobs
- 最近一次响应速度与耗时

支持 `detailed`、`compact` 和 `minimal` 三种密度。

### 常用终端工作流

- `@文件`：浏览并引用工作区文件
- `/btw`：使用独立临时会话回答旁路问题
- `/compact`：调用 Harness 压缩当前会话上下文
- `!命令`：执行本地 Shell 命令
- `/jobs`：查看和取消后台任务
- `/resume`：恢复历史会话
- `/steer`：运行中调整当前任务方向

## 环境要求

- Node.js 20 或更高版本
- DeepSeek Harness [`@deepseek-ai/dsh@0.1.1-rc.2`](https://www.npmjs.com/package/@deepseek-ai/dsh)（截至 2026-08-29 为 npm `latest` / `next`）
- 支持 ANSI 256 色的终端
- 图片显示建议使用 iTerm2 或支持 Kitty Graphics 的终端

目前主要在 macOS、VS Code Terminal 和 iTerm2 中开发与验证。

## 安装和启动

从 npm 安装到 `tui` profile（推荐，直接分发构建产物，无需 Git 依赖构建授权）：

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile tui add dsh-omc-tui
```

也可以从 GitHub 安装（会拉取源码，首次需按 pnpm 提示授权 `prepare` 构建脚本）：

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile tui add github:ipromise2021/dsh-omc-tui
```

启动：

```sh
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 --profile tui
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
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile tui add /absolute/path/to/dsh-omc-tui
npx --yes @deepseek-ai/dsh@0.1.1-rc.2 --profile tui
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
| `/jobs` | 查看后台任务、读取输出或取消任务 |
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
