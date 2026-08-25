# DSH OMC TUI

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-ipromise2021%2Fdsh--omc--tui-181717?style=flat-square&logo=github)](https://github.com/ipromise2021/dsh-omc-tui)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/Harness-0.1.1--rc.1-00bcd4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?style=flat-square)](package.json)

**DeepSeek Harness 的终端原生 TUI**

保留终端 Scrollback，提供多模态图片、行内审批、Plan/Jobs、模型选择和上下文状态栏。

[界面与设计说明](PRODUCT_SHOWCASE.md) · [兼容性记录](HARNESS_COMPATIBILITY.md) · [变更日志](CHANGELOG.md)

</div>

![DSH OMC TUI 主界面](assets/welcome.png)

`dsh-omc-tui` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 ANSI 终端界面插件。

插件专注于终端渲染与键盘交互；模型、会话、工具、权限、后台任务及持久化均由 Harness 官方服务提供。

项目参考了 Claude Code CLI 的交互习惯，适合希望在终端中使用 DSH，同时保留滚轮回看、文本选择和复制体验的用户。

## 插件功能

### 保留终端 Scrollback

不进入备用屏幕。对话、工具调用、Thinking 和 Diff 会追加到终端普通缓冲区，可以直接滚动回看和选择复制。

### Harness 原生集成

会话恢复、Plan 模式、权限审批、Jobs、Skills、模型和图片附件都使用 Harness 官方服务与 durable event。TUI 只负责展示和交互。

### 图片粘贴与多模态

支持 iTerm2 OSC 1337、Kitty Graphics 和 macOS 剪贴板图片。图片经过 Harness Attachment 管道保存：当前模型支持视觉时直接发送；否则主 Agent 可自主调用已配置的 `analyze_image` 旁路视觉工具，主会话模型保持不变。

执行 `/vision` 可查看精简的常用视觉路由；再使用 `/vision <provider>/<model>` 配置其中一个模型。此后，主 Agent 会在需要识别图片时调用临时视觉 Agent，并将识别结果作为工具结果继续处理。

### 行内审批与问题面板

文件修改和命令执行可在终端内查看 Diff 并选择允许或拒绝。Harness 的单选、多选和自由文本问题也可以直接在 TUI 中完成。

### 自适应状态栏

状态栏可以显示：

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
- DeepSeek Harness `0.1.1-rc.1`
- 支持 ANSI 256 色的终端
- 图片显示建议使用 iTerm2 或支持 Kitty Graphics 的终端

目前主要在 macOS、VS Code Terminal 和 iTerm2 中开发与验证。

## 安装和启动

从 GitHub 安装到 `tui` profile：

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add github:ipromise2021/dsh-omc-tui
```

启动：

```sh
npx --yes @deepseek-ai/dsh@latest --profile tui
```

如果已经全局安装 DSH，也可以直接运行：

```sh
dsh --profile tui
```

### 本地开发安装

建议使用单独的 `DSH_HOME`，避免影响日常配置：

```sh
export DSH_HOME=/private/tmp/dsh-tui-dev
npx --yes @deepseek-ai/dsh@latest plugin --profile tui add /absolute/path/to/dsh-omc-tui
npx --yes @deepseek-ai/dsh@latest --profile tui
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
| `/export` | 将当前会话导出为 Markdown |
| `/exit` | 安全退出终端（有活跃后台任务时弹出确认） |

其他命令和快捷键可以在 TUI 中通过 `?`、`/help` 或 `Ctrl+P` 查看。

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

## 当前限制

- 项目仍处于 pre-release 阶段，Harness 上游接口变化后可能需要同步适配。
- Windows 和更多真实模型提供方仍需要进一步验证。
- `/plugins`、`/fork`、`/rewind` 等能力暂未在 TUI 中实现。
- 本插件只提供 TUI；模型、工具、Sandbox 和会话持久化由 DSH profile 提供。

## 反馈与贡献

项目以实际终端使用体验为基础，按需持续完善。

如果遇到问题，可以提交 [Issue](https://github.com/ipromise2021/dsh-omc-tui/issues)。建议附上 DSH 版本、Node.js 版本、操作系统、终端类型和复现步骤。也欢迎直接提交 PR。

提交代码前请运行：

```sh
npm test
npm run verify
```

提交信息建议使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`。

## License

[MIT](LICENSE)
