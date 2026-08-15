# DSH TUI 工程化记录

> 更新日期：2026-08-15  
> 当前基线：`2cfe511 feat: improve dsh tui harness integration`

本文记录 TUI 当前实现的工程判断和后续优化边界，避免后续为了“增加文件数量”而引入不必要的框架或重复实现 Harness 能力。

## 1. 项目定位

DSH TUI 是一个 DeepSeek Harness `dsh.bundle`，不是独立 Agent，也不是 Web UI 的复制品。

核心职责只有三类：

1. 将 Harness 的 `ctx.*` 服务和 durable session events 映射到终端交互。
2. 管理输入编辑、命令面板、问卷、审批和局部视图状态。
3. 将会话、思考、工具、技能、Hook 和回答渲染到普通终端 scrollback。

会话、权限、工具、MCP、Skills、任务和持久化的真相源必须继续由 Harness 提供。TUI 不应再维护一套平行的 Agent 状态。

官方架构参考：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

## 2. 当前实现评估

### 已有结构

```text
src/index.js              # 约 3,680 行：入口、Harness 适配、状态、输入和渲染集中在一个文件
src/image-protocol.js     # 约 271 行：OSC 1337 / Kitty 图片协议解析
test/pty-*.py             # 6 个 PTY 端到端脚本
cordis.patch.yml          # dsh.bundle 组合声明
README.md                 # 启动方式、功能和快捷键
HARNESS_COMPATIBILITY.md  # 功能—服务—事件映射
ROADMAP.md                # 功能路线图
```

这不是功能过少，而是“核心逻辑过度集中”。当前实现已经覆盖较多交互，但维护成本高，输入、事件折叠和渲染之间存在较强耦合。

### 当前必须保留的设计约束

- 使用 Node.js 22，与 DSH/Cordis 运行时保持一致。
- 使用普通终端缓冲区，不进入备用屏幕。
- 滚轮、拖拽选择和复制继续交给终端模拟器。
- 底部输入框、面板和 statusline 只做短暂重绘。
- 不在 TUI 内复制 Session、Permission、Jobs、MCP 或 Skills 的持久化逻辑。
- 不为了组件化而引入会接管整个屏幕的框架。

## 3. 目标模块结构

后续重构应按职责拆分，优先提取纯逻辑和 Harness 适配层：

```text
src/
  index.js                    # bundle 入口和启动
  harness/
    services.js               # ctx.* 服务探测和适配
    events.js                 # durable event 转换、fold 和索引
    session.js                # 创建、恢复、提交和中断
  core/
    state.js                  # TUI 状态模型
    reducer.js                # 输入、事件、面板状态转换
    commands.js               # 本地命令分发
    history.js                # 输入历史和 MRU
  input/
    decoder.js                # ANSI、ESC、控制键解析
    editor.js                 # 光标、多行、删除、历史导航
    attachments.js            # 图片和文件引用输入
  render/
    ansi.js                   # 颜色、宽度、截断和换行
    markdown.js               # 已完成回答的轻量 Markdown 渲染
    transcript.js              # 用户、助手、thinking、tool、hook 行
    statusline.js              # Context、preset、effort、jobs 等
    footer.js                 # 输入框和临时面板
  panels/
    command-panel.js
    picker-panel.js
    jobs-panel.js
    question-panel.js
    settings-panel.js
  attachments/
    image-protocol.js         # 从现有 src/image-protocol.js 迁移
```

### 推荐拆分顺序

1. 先提取 `render/ansi.js`、`render/markdown.js` 和 `core/state.js`，这些模块最容易编写纯测试。
2. 再提取 `harness/events.js`，固定事件折叠和流式追加的输入输出契约。
3. 再提取 `input/decoder.js` 和 `input/editor.js`，覆盖滚轮、上下键、Ctrl 键和多行输入。
4. 最后拆分各类面板，保持 `TuiApp` 只负责编排。

不要一次性重写整个 `TuiApp`，每次拆分后都要运行 PTY 回归。

## 4. 依赖策略

### 暂不引入完整 TUI 框架

暂不使用 Ink、Blessed、Neo-Blessed、Terminal Kit 或其他全屏组件框架。它们可能重新接管：

- 鼠标报告和滚轮；
- 终端原生拖选；
- scrollback 输出；
- 光标和备用屏幕；
- 流式追加时的重绘节奏。

这些行为正是当前 TUI 已经反复修复的问题。

### 可以考虑的轻量依赖

只有在现有实现和测试证明有必要时才增加：

- `string-width`：改进 CJK、Emoji 和组合字符宽度。
- `wrap-ansi` / `slice-ansi`：处理带 ANSI 样式文本的换行和截断。
- `marked` 或 `micromark`：把完整回答解析成 Markdown token，再交给自定义终端渲染器。
- `vitest`：为纯函数和 reducer 增加快速单元测试。

运行时依赖应尽量少，官方 `@deepseek-ai/*` 包继续使用 peer dependency，由 DSH profile 提供版本。

## 5. Rust 评估

当前不建议将 TUI 整体改写为 Rust。DSH 的核心是 Node/Cordis，Rust 前端不能直接使用 `ctx.*` 和 Cordis Loader，必须增加桥接层：

```text
Node Harness bundle
        ↕ JSONL / IPC / WebSocket
Rust terminal renderer
```

这会额外引入事件序列化、MCP/Skills/审批映射、双运行时发布和跨平台安装问题。

只有满足以下条件时，才考虑 Rust：

- Node 原生输入在 Windows 上仍无法稳定工作；
- 超大规模流式输出造成明确性能瓶颈；
- 需要一个与 Harness 解耦、可复用的终端前端。

届时采用“Node Harness bridge + Rust Ratatui/Crossterm 前端”，而不是让 Rust 直接替换 Harness。

## 6. 后续路线图

### P0：结构稳定

- [ ] 抽取状态模型和 reducer。
- [ ] 固定 `session/event`、`agent/status`、`tool`、`thinking`、`approval` 的事件测试夹具。
- [ ] 增加 `npm run check`，至少执行 Node 语法检查、Python PTY 脚本编译检查和 `git diff --check`。

验收：拆分后现有 PTY 测试行为不变，滚轮不切换输入历史。

### P1：渲染稳定

- [ ] 抽取 ANSI 宽度、换行、Markdown token 渲染。
- [ ] 将流式输出和最终输出使用同一套 transcript 数据模型。
- [ ] 降低 footer/statusline 重绘范围，避免全屏闪烁。

验收：长回答自然追加到 scrollback，输入区位置稳定，终端可以原生拖选和复制。

### P2：Harness 适配完整

- [ ] 增加官方 `ctx.settings` / settings-file 的统一适配。
- [ ] 插件清单只读投影与 Web 对齐。
- [ ] 插件市场安装委托官方 `dsh plugin --profile tui add`，不直接修改 profile 文件。

验收：TUI 不产生独立的会话、权限、插件安装真相源。

### P3：跨平台与发布

- [ ] Windows Terminal、VS Code Terminal、macOS Terminal、iTerm2 回归。
- [ ] 增加 CI 中的 Node 版本和 PTY smoke test。
- [ ] 补充 LICENSE、版本兼容矩阵和公开发布说明。

## 7. 每次修改的检查清单

- 是否直接使用了官方 `ctx.*` 服务或 durable event？
- 是否把 Web 专属行为错误地复制到了 TUI？
- 是否改变了终端原生滚轮、拖选或 scrollback？
- 是否把输入、面板和输出放进了固定高度容器？
- 是否能用纯函数测试验证新增逻辑？
- 是否需要更新 `README.md`、`HARNESS_COMPATIBILITY.md` 或 `ROADMAP.md`？
- 是否至少通过 Node 语法检查和相关 PTY 测试？

