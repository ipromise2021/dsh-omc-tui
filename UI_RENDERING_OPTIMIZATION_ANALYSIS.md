# DSH OMC TUI 主分支界面渲染与输出折叠优化分析

> 分析日期：2026-08-25
> 分析分支：`main`（仓库没有 `master`，`main` 为主分支）
> 基线提交：`95d6318`（`origin/main`）
> 本文只给出代码现状、可行性判断和实施方案，不修改产品实现。

## 1. 结论摘要

两项需求都可以支持，但不能继续把“终端原生 scrollback”同时当作完整历史数据库、可变 UI 文档和应用视口。

当前主分支的根本矛盾是：会话内容一旦通过 `process.stdout.write()` 写进普通终端历史，就无法可靠地在原位置重新排版、删除或折叠。resize 和 Ctrl+O 目前都通过“清空终端历史，再全量重放”绕过这个限制；这正是布局混乱、旧历史被截断、无法回到对话开头的共同来源。

建议保留 Harness durable events 作为唯一真相源，新增纯投影的 transcript document 和应用自有 viewport：

1. durable events 投影为带稳定 key 的语义块，而不是立即打印为不可变行。
2. resize 只按新宽高重排 document，并保持用户当前阅读锚点。
3. 屏幕每次只渲染 viewport 当前可见行，不再把全部历史重新灌入终端 scrollback。
4. 工具活动在“完整活动边界”闭合前只显示一条 live 摘要；闭合后默认折叠为一个块，Ctrl+O 原位展开。
5. `turn/end` 只完成状态交接和最后一帧渲染，不做第二次全量 repaint。

如果坚持只使用普通终端原生 scrollback，可以做到“resize 后尽量全量重放”和“工具活动结束后只追加一条折叠摘要”，但无法可靠保证：

- 任意长会话都能翻到开头；
- resize 后仍停留在用户之前阅读的位置；
- Ctrl+O 能原位展开任意旧工具块。

这些限制来自终端 scrollback 容量和 ANSI 能力边界，不是再增加几条清屏序列就能解决。

## 2. 当前主分支界面架构

### 2.1 当前是普通主屏，不是应用自有视口

`openTerminal()` 只启用 bracketed paste、raw mode 和 resize 监听，没有进入 alternate screen。正文直接写入普通终端 scrollback，底部输入框和状态栏则靠光标上移、清除、重画来模拟固定 footer。

相关位置：

- `src/index.js:712-723`：打开终端及监听 resize。
- `src/index.js:6084-6128`：`commitToScrollback()` 将正文追加到终端历史，再重建 footer。
- `src/index.js:6074-6081`：根据旧 footer 行估算光标上移距离。

这个架构适合短会话的增量输出，但不适合“任意历史位置重新排版”和“历史块原位折叠/展开”。

### 2.2 resize 当前执行清历史并全量重放

`onResize()` 在 80ms 防抖后直接调用 `repaint(true)`：

- `src/index.js:420-425`：任何 resize 事件都会触发全量 repaint，没有比较实际 columns/rows 是否变化。
- `src/index.js:920-951`：重新从 session events 和 local log 格式化全部内容。
- `src/index.js:945-951`：写入 `ESC[3J ESC[2J ESC[H` 后，一次性输出 welcome 与全部历史行。

该逻辑确实尝试按新宽度重排“当前会话全部事件”，但结果仍不可靠：

1. `ESC[3J` 清除 scrollback 的行为在不同终端、tmux 和 IDE terminal 中不一致。
2. 终端本身有 scrollback 行数上限。重放行数超过上限时，最早内容仍会被宿主丢弃，所以用户无法翻到开头。
3. ANSI 没有跨终端可靠读取和恢复“用户当前正浏览的原生 scrollback 位置”的能力，resize 后通常会跳回底部。
4. 全部历史以一个大字符串同步写出，没有 document/viewport 层，也没有语义阅读锚点。
5. 多处使用 `Math.max(60, process.stdout.columns || 100)`，包括 `repaint()`、流式 Markdown 和 `commitToScrollback()`。真实窗口小于 60 列时，应用仍按 60 列布局，终端会再次软换行，footer 高度估算和正文边框都会偏离实际屏幕。

因此，当前现象不是“历史没有读到”，而是“全量事件已经格式化并输出，但普通终端无法保证保存、定位和再次编辑这些历史行”。

### 2.3 `turn/end` 已经没有全量 repaint

主分支的 `turn/end` 路径执行：

1. 提交尚未输出的事件；
2. flush reasoning 和文本缓冲；
3. 完成 turn 状态；
4. 调度 footer/render。

它没有调用 `repaint(true)`，位置见 `src/index.js:1216-1223`。对应回归测试在 `test/unit-regressions.mjs:1748-1768`，明确断言 turn/end 的 repaint 次数为 0。

所以“输出结束时不用加重绘”在 turn/end 主路径已经满足。现在视觉上像“输出结束又重画”的主要来源可能是：

- 工具事件和 assistant 流分别增量提交，造成内容在结束前后分段出现；
- Ctrl+O 调用全量 repaint；
- resize 恰好在输出结束附近触发；
- footer 的最终状态帧更新被误认为正文重绘。

后续不应重新引入 turn/end 全量重放，而应把 live block 到 durable block 的交接做成同一 document block 的状态替换。

## 3. 当前工具输出与折叠实现

### 3.1 完整历史渲染只做“连续事件分组”

`src/renderer/transcript.js:34-124` 的 `renderGroup()` 行为是：

- 统计组内 `tool/call` 数量；
- 只有调用数大于 1 时才显示 `TOOLS · N` 折叠摘要；
- 单个工具调用默认直接显示；
- 组 key 使用 `tools-${group[0].seq}`；
- 工具结果只在 expandedKeys 命中时显示最多 4 行。

`src/renderer/transcript.js:126-159` 尝试跨越短 assistant 过渡消息继续寻找后续工具，但当前控制流随后仍无条件调用 `renderGroup(group)` 并清空 group。因此实际效果仍是：中间出现 assistant/message 后，前后工具会被拆成不同组。

用合成 durable events 验证得到：

```text
tool/call(Read a.js)
tool/result(a)
assistant/message("继续检查")
tool/call(Read b.js)
tool/result(b)
```

完整渲染仍输出两个独立 `Read(...)` 块；只有两个工具调用严格连续时，才会输出一条折叠摘要：

```text
⚙ TOOLS · 2 · Read ×2 (ctrl+o to expand)
```

所以当前代码并没有真正建立“子树”模型，只建立了易受事件穿插影响的连续数组分组。

### 3.2 live 提交会把同一工具活动拆碎

`commitUnprintedEvents()` 位于 `src/index.js:896-918`：

- 取 `lastCommittedSeq` 之后的事件；
- 只保留 tool、approval、hook、user message；
- 立即把 `lastCommittedSeq` 推进到整个 session 的最后 seq；
- 立刻调用 `formatEvents()` 并写入 scrollback。

它在 text delta、reasoning 开始、assistant message 和 turn/end 等多个位置被调用。live 时通常只看到一个刚完成的 tool/call + tool/result，因此每次格式化都被判断为“单工具组”，直接写成展开块。等后续节点全部完成，即使完整历史投影能够把它们识别成一组，之前写入 scrollback 的多行也无法原地收回。

这是“运行过程中干扰内容太多、结束后又需要重绘才能折叠”的直接原因。

### 3.3 Ctrl+O 当前是全局切换并全量重放

`toggleCollapsible()` 位于 `src/index.js:5734-5774`：

- 收集整个 session 的全部 reasoning key 和多工具 group key；
- 一次 Ctrl+O 会展开所有尚未展开的块，或折叠所有已展开块；
- 最后调用 `repaint(true)` 清屏并全量重放。

这有三个问题：

1. Ctrl+O 不是针对当前/最近工具活动，而是全局操作；长会话会突然展开大量内容。
2. 它再次触发与 resize 相同的 scrollback 截断风险。
3. 单工具组没有加入 collapsible keys，无法用 Ctrl+O 展开/折叠。

### 3.4 当前没有应用级内容区鼠标路由

主分支 `openTerminal()` 写入的是 `TERMINAL_MOUSE_OFF`，即显式关闭终端鼠标追踪；当前输入处理主要面向键盘、bracketed paste、输入框选择和各种面板。它没有将 SGR 鼠标序列解析为统一事件，也没有 transcript selection 或 viewport wheel consumer。

因此 document + viewport 实施时必须同时补齐输入路由。否则可能出现：

- 滚轮序列继续落入输入编辑器或历史导航；
- 鼠标拖动与输入框选择互相抢占；
- resize 后仍使用旧屏幕坐标恢复选择，导致选择错位；
- 启用鼠标追踪后终端原生拖选失效，却没有应用级复制替代能力。

## 4. 需求可行性与边界

| 目标 | 普通 scrollback 架构 | 应用自有 document + viewport |
|---|---|---|
| 仅 resize 触发正文重排 | 可做到 | 可做到 |
| resize 后全历史按新宽度重排 | 可输出，但受宿主历史上限影响 | 可保证，document 保留全量逻辑内容 |
| resize 后仍能翻到对话开头 | 无法对任意长会话保证 | 可保证 |
| resize 时保持当前阅读位置 | 无跨终端可靠方案 | 可用 block key + 行内偏移保持 |
| 工具子树结束后默认折叠 | 可做到，但必须延迟提交 | 可做到 |
| Ctrl+O 原位展开任意历史块 | 无法可靠保证 | 可保证 |
| turn/end 不重放正文 | 已满足 | 可保持 |

核心判断：如果“全历史可访问”和“原位展开/折叠”都是硬性要求，就应继续采用应用自有 viewport 的方向，但需要重做投影和交互契约，不能只在现有输出函数外包一层 alternate screen。

## 5. 建议目标架构

### 5.1 三层状态模型

#### Durable events

Harness session events 仍是唯一真相源。TUI 不修改、不裁剪 durable log。

#### Transcript document

新增纯投影结果，每个块包含：

```text
TranscriptBlock
├─ key                 稳定 key，例如 turn-12 / activity-35 / answer-48
├─ kind                user | reasoning | activity | answer | local-log
├─ startSeq / endSeq   对应 durable event 范围
├─ state               live | complete | failed | aborted
├─ collapsed           当前展示状态
├─ summary             折叠摘要及节点计数
├─ rows                 当前宽度下的可见行
└─ detailRows           展开后的完整详情行
```

投影函数必须是纯函数：相同 events、宽度和 expandedKeys 得到完全相同的 blocks/rows。resume、resize、Ctrl+O 和 live 更新都复用同一条投影链，避免当前“live 一套、全量回放另一套”的语义漂移。

#### Viewport/screen

viewport 保存：

- `scrollTop`
- `viewportHeight`
- `followEnd`
- `anchorBlockKey`
- `anchorRowOffset`

screen 只负责将 viewport 当前可见行与 footer/dock 组成一帧并差分输出。

### 5.2 resize 算法

只有 columns 或 rows 实际变化时才执行：

1. resize 前记录阅读锚点：当前 viewport 顶部所在 block key 与 block 内行偏移。
2. 使用真实 `process.stdout.columns` 重排所有 TranscriptBlock；不要把布局宽度强制钳制为 60。
3. 如果 `followEnd=true`，重排后保持底部跟随。
4. 如果用户正在向上阅读，根据相同 block key 恢复锚点；block 被折叠时定位到该 block 摘要行。
5. 重新计算 `scrollTop`，限制在 `0..documentHeight-viewportHeight`。
6. 只渲染当前 viewport，不向终端一次性写入全部历史。

极窄窗口应通过 footer/dock 降级保证真实宽度一致，例如隐藏次要状态、缩短 badge、输入区至少保留一行；不能假装终端仍有 60 列。

### 5.3 “工具子树”的建议定义

当前 TUI 代码没有读取可用的 parent/child/subtree 字段，只使用 `callId` 配对 tool call 和 result。因此实施前应先确认 Harness 当前 durable event schema：

1. 若事件提供明确 parent call/session/agent 标识，优先按真实父子关系建立树。
2. 若没有父子字段，则定义“工具活动段（activity span）”作为稳定回退语义：
   - 起点：本 turn 中第一个 `tool/call`；
   - 节点：后续 tool/call、对应 tool/result、approval、hook，以及工具间的短 assistant 过渡消息；
   - 闭合条件：所有已开始 call 都收到 result，随后出现不再指向工具的最终 assistant message，或出现 turn/end/error/abort；
   - key：优先使用根 callId；缺失时使用 `activity-${firstSeq}`。

不要继续依赖“文本长度小于 120 就可能是过渡消息”作为唯一边界。长度可作为展示策略，不能作为结构真相。

### 5.4 live 输出与闭合后的折叠

建议状态机：

```text
IDLE
  └─ tool/call → ACTIVITY_LIVE

ACTIVITY_LIVE
  ├─ call/result/hook/approval → 更新同一 live block
  ├─ 中间 assistant message + 后续 call → 保持同一 block
  ├─ final assistant boundary → COMPLETE_COLLAPSED
  └─ turn error/abort → COMPLETE_COLLAPSED（摘要带失败/中止标记）
```

运行过程中：

- transcript 中只保留一个可更新的 activity live block；
- 摘要显示当前动作、已完成节点数、运行时间和失败数；
- 详细节点不逐条提交到不可变 scrollback；
- 审批请求仍立即显示在固定交互区，不能被折叠隐藏。

活动闭合时：

- 同一个 block 从 `live` 原子切换为 `complete`；
- 默认 `collapsed=true`，显示例如 `⚙ 12 nodes · Read ×7 · Edit ×2 · Bash ×3 · 18s`；
- durable events 保留所有参数、结果和错误，折叠只是投影状态；
- 不执行整屏 repaint，不再次输出已完成正文。

### 5.5 Ctrl+O 语义

建议 Ctrl+O 只作用于“当前焦点块”；若没有显式焦点，则作用于 viewport 中最近的 activity/reasoning block。切换后：

1. 只更新该 block 的 expanded key；
2. 重新投影该 block 及其后续行偏移；
3. 保持该 block 的摘要行作为阅读锚点；
4. 重绘 viewport 当前帧，不清空终端 scrollback。

如果仍需保留 inline 回退模式，Ctrl+O 应打开一个临时详情面板/分页器，关闭后回到原位置；不要在 inline 模式中尝试改写任意旧 scrollback 行。

### 5.6 统一输入事件路由

所有原始 stdin 字节应先解析成语义事件，再按固定优先级分发。处理函数返回 `consumed` 后必须立即停止传播，禁止同一个滚轮或拖动事件继续进入输入框编辑器。

建议事件模型：

```text
InputEvent
├─ KeyEvent              key + modifiers
├─ MouseMoveEvent        row + column + buttons + modifiers
├─ MouseButtonEvent      press/release + row + column
├─ MouseWheelEvent       deltaY + row + column
├─ FocusEvent            in/out
├─ PasteEvent            text
└─ ResizeEvent           columns + rows
```

建议分发优先级：

```text
审批/问题/弹窗
    ↓
活动中的内容区拖选
    ↓
指针下的可滚动面板
    ↓
主 transcript viewport
    ↓
输入框编辑与输入历史
    ↓
全局快捷键
```

必须遵守以下消费规则：

- `MouseWheelEvent`：优先由指针下的弹窗/面板消费，否则一律由主 viewport 消费；不得调用 `historyNav()`。
- 键盘 `Up/Down`：只有输入框拥有焦点、没有活动选择且没有 viewport 导航修饰键时，才允许切换输入历史。
- `PageUp/PageDown`：始终翻阅 transcript 或当前可滚动面板，不切换输入历史。
- 鼠标 press/move/release：一旦开始 transcript selection，本次拖动生命周期内都由 selection controller 独占。
- `Focus In/Out` 序列只更新焦点状态，不得作为可见文本插入输入框。
- bracketed paste 具有独立状态机，粘贴期间的普通换行和可打印字符不得被误判为快捷键。

建议快捷键语义：

| 输入 | transcript/内容区 | 输入框 |
|---|---|---|
| 滚轮 | 滚动主 viewport | 仍滚动主 viewport，不切换历史 |
| PageUp/PageDown | viewport 翻页 | viewport 翻页 |
| 普通 Up/Down | 移动块焦点或滚动 | 输入历史导航 |
| Ctrl+Shift+Up/Down | 上一个/下一个用户消息 | 同样导航 transcript，不进入历史 |
| Ctrl+O | 展开/折叠焦点块 | 展开最近或当前可见折叠块 |
| Esc | 清除内容选择/关闭面板/返回底部 | 保留现有取消语义 |

### 5.7 内容区选择与剪贴板契约

内容区选择必须基于 document 的语义位置，而不是只保存瞬时屏幕坐标：

```text
SelectionPoint
├─ blockKey
├─ logicalLine 或文本 offset
└─ grapheme offset
```

屏幕坐标通过当前 layout map 转换成 SelectionPoint。resize 后重新排版，再将同一语义选择映射回新行列，这样选择不会因宽度变化漂移。

最低交互要求：

- 单击拖动：按 grapheme 跨行选择；
- 双击：按 `Intl.Segmenter` 的 word 边界选择，兼容中文、英文、emoji 和组合字符；
- 三击：选择完整逻辑行；
- 拖到 viewport 上下边缘：定时自动滚动并继续扩展选择；
- 选择文本时剥离 ANSI，保留硬换行；软换行是否保留由 document 的逻辑行信息决定；
- Ctrl+C 或鼠标松开后的显式复制动作使用 OSC 52；失败时按平台降级到 `pbcopy`、`wl-copy`、`xclip` 或 `clip.exe`；
- 复制成功只显示短暂 toast，不向 durable events 写入伪事件。

启用 SGR 鼠标追踪后，普通拖动通常会被应用接管。需要保留“终端原生选择逃生通道”：优先采用终端普遍支持的 Shift+拖动，并在设置/帮助中说明；不同终端的 override modifier 仍需人工兼容测试，不应假设 Option/Alt 在所有终端一致。

建议进入应用自有 viewport 时启用 button tracking + SGR coordinates，退出时在 `finally`/`stop()` 中无条件关闭。即使初始化或渲染抛错，也必须恢复光标、raw mode、bracketed paste 和鼠标协议。

## 6. 建议实施阶段

### 阶段 A：投影语义与特征测试

- 提取纯函数 `projectTranscript()` 和 `groupActivitySpans()`。
- 为 block 定义稳定 key、event range、状态和折叠摘要。
- 修复跨 assistant 过渡消息的工具活动分组。
- 单工具活动也必须是可折叠 block。
- 本阶段不接终端输出，先确保 resume 与 live 使用相同事件序列时投影一致。

### 阶段 B：live activity 缓冲

- 将 `commitUnprintedEvents()` 拆为“推进事件投影”和“提交已闭合块”。
- 工具活动未闭合时只更新 live block，不逐节点写入 scrollback。
- 活动闭合后只提交一条默认折叠摘要。
- 保持审批、错误和用户消息的即时性。

### 阶段 C：document + viewport resize

- 建立完整逻辑 document 和 scrollTop/followEnd/anchor 状态。
- 使用真实终端宽高重排。
- resize 只重绘 viewport，验证可回到对话开头且阅读锚点稳定。
- 移除 resize 对 `ESC[3J` 和“全历史一次性 stdout.write”的依赖。

### 阶段 D：定向 Ctrl+O

- Ctrl+O 只展开/折叠目标 block，不全局切换。
- 展开后保留锚点，折叠后避免跳屏。
- 覆盖 reasoning、单工具活动、多节点活动和错误活动。

### 阶段 E：输入路由、滚轮与内容选择

- 增加原始 stdin 到 Key/Mouse/Wheel/Focus/Paste 语义事件的纯解析器。
- 建立 consumed-based 分发链，确保滚轮永不穿透到输入历史。
- 实现语义 SelectionPoint、拖选、双击选词、三击选行和边缘自动滚动。
- 实现 OSC 52 与平台剪贴板降级，并确保退出时恢复全部终端协议。

### 阶段 F：兼容模式与人工验收

- 应用自有 viewport 作为满足完整需求的主模式。
- inline 模式作为兼容回退，明确不承诺任意长历史原位编辑。
- 在 macOS Terminal/iTerm2、VS Code Terminal、tmux 和至少一个 Linux terminal 上人工验收。

## 7. 测试矩阵

### 投影单元测试

- 单工具 call/result：默认折叠，Ctrl+O 可展开。
- 多工具严格连续：归为一个 activity block。
- 工具之间夹 assistant 过渡消息：仍归为一个 activity block。
- approval/hook 穿插：归属正确，审批 UI 不被隐藏。
- error/abort：摘要带状态，详情完整保留。
- callId 缺失或 result 乱序：使用 seq 回退且不丢事件。
- CJK、emoji、ANSI 和长命令：所有 rows 的 `widthOf(visibleOf(row)) <= columns`。

### live 事件测试

- 每加入一个工具节点只更新同一 live block，不追加历史详情行。
- 子树未闭合时不得产生 completed summary。
- 闭合后只产生一次 collapsed summary。
- `turn/end` 的正文全量 repaint 次数保持 0。
- resume 后投影结果与 live 完成后的最终投影逐行一致。

### resize/viewport 测试

- 生成超过 3000 行的会话，宽度 `120 → 44 → 100`，仍可滚动到第一条用户消息。
- 在历史中部 resize，顶部 block key 和行内偏移保持稳定。
- 位于底部时 resize 后继续 followEnd；向上滚动后新输出不抢回底部。
- 高度缩到极小值时 viewport 至少一行，footer 不越界。
- 连续 resize 事件防抖后只按最后尺寸投影一次。

### Ctrl+O 测试

- 只切换目标 block，不影响其他 block。
- 展开/折叠后目标摘要仍在 viewport 内。
- 长详情超过 viewport 时可滚动完整查看。
- inline 回退使用详情面板，不调用 `repaint(true)`。

### 输入路由与鼠标测试

- SGR wheel up/down 被解析为 MouseWheelEvent，并且处理后 `historyNav()` 调用次数为 0。
- 普通键盘 Up/Down 在输入框焦点下仍能切换输入历史。
- PageUp/PageDown、Ctrl+Shift+Up/Down 只改变 viewport。
- Focus In/Out 序列被静默消费，不进入输入文本。
- 弹窗有独立滚动区域时优先消费滚轮；无可滚动弹窗时回退到主 viewport。
- press → move → release 整个拖动生命周期只属于同一个 selection controller。
- 拖动到上下边缘时触发自动滚动，选择端点随 document 位置更新。

### 内容选择与复制测试

- CJK、英文、emoji、组合字符的单击拖选和双击选词边界正确。
- 跨 block 选择保留硬换行，剥离 ANSI，不引入屏幕软换行。
- resize 前后的 SelectionPoint 指向相同语义文本。
- OSC 52 编码正确；不可用时降级路径明确，复制失败不会破坏 TUI。
- Shift+拖动的终端原生选择兼容性在目标终端中人工验证。
- 正常退出、异常退出和初始化失败都关闭鼠标协议并恢复光标/raw mode。

## 8. 不建议继续采用的修补方式

- 不建议继续增加更多 `ESC[3J/2J/H` 组合来修复 scrollback；终端差异仍然存在。
- 不建议在 resize 后把全部历史拆成多次 stdout.write；这只能缓解单次写入压力，不能突破 scrollback 上限或恢复阅读位置。
- 不建议在 turn/end 再做一次全量 repaint；当前回归已经正确禁止它。
- 不建议仅修改 `isMultiple` 或把单工具也标记为折叠，而继续逐节点提交；已经写入的历史行仍无法收回。
- 不建议继续用 assistant 文本长度判断树边界；应以事件关系和 turn 状态为主。
- 不建议让 Ctrl+O 全局展开全部历史块；长会话会造成巨量重排和阅读位置跳变。

## 9. 推荐验收标准

方案实现后，以下条件应同时成立：

1. 只有终端 columns/rows 实际变化时触发 transcript 重排。
2. resize 不调用清除原生 scrollback 后全量重放的路径。
3. 任意长度的当前 session 都能在 TUI 内滚动到第一条可见用户消息。
4. 用户在历史中部 resize 后仍停留在同一语义 block 附近。
5. 工具活动运行时只显示一个 live 摘要，闭合后默认折叠。
6. Ctrl+O 只展开/折叠目标 activity/reasoning block。
7. `turn/end` 不触发 transcript 全量 repaint。
8. resume、live 完成态和 resize 后的 transcript 投影一致。
9. 所有状态仍由 Harness durable events 恢复，TUI 不伪造或截断事件。
10. 鼠标滚轮只滚动 viewport 或当前面板，绝不触发输入历史切换。
11. 内容区支持跨行选择、CJK/emoji 边界和无 ANSI 复制。
12. resize 后阅读锚点与语义选择仍指向原内容。
13. 所有输入事件只被一个最高优先级 consumer 处理，不发生穿透。
14. 退出和异常清理后终端鼠标、焦点、粘贴、raw mode 与光标状态全部恢复。

## 10. 最终建议

建议把下一轮工作目标定为“统一 transcript 投影与 viewport”，而不是继续修补 resize 清屏序列。

优先顺序应为：先完成 activity span 的纯投影与 live 缓冲，使工具噪声立即下降；再替换 resize 的 scrollback 全量重放；随后实现定向 Ctrl+O、统一输入路由、滚轮隔离和内容区选择。这样每个阶段都能独立验收，也不会在一次改动中同时重写事件语义、终端渲染和交互。

## 11. 给后续模型的交接约束

- 从 `main` / `95d6318` 分析与实施；`feat/tui-optimizations` 的 `4a45444` 只能作为实验参考，不应整提交直接合并。
- 先写投影与输入解析的纯函数测试，再接入 `src/index.js` 的 PTY 生命周期。
- 不引入 blessed、ink、chalk、strip-ansi 等重型终端依赖。
- 所有视觉宽度继续使用项目的 `widthOf()`、`visibleOf()`、`wrap()` 和 `truncateAnsi()`；不要用字符串 `.length` 计算终端列。
- Harness durable events 是唯一历史真相源；expandedKeys、scrollTop、selection 等只属于可恢复的 UI 投影状态。
- 不得通过裁剪 durable events、直接改 Harness 配置或伪造事件来减少显示内容。
- 不要在 `turn/end`、Ctrl+O 或 resize 路径恢复“清 scrollback + 全量重放”。
- 每一阶段保持可回退，优先拆成 transcript projection、viewport、input router、selection/clipboard、screen renderer 等小模块。
- 完成后至少运行模块导入验证、单元回归、虚拟终端测试、鼠标/选择测试，并进行真实 PTY 人工验收。

## 12. 实施结果（2026-08-26）

本方案已落地为 TUI 的默认渲染路径：

- `projectTranscript()` 生成完整 transcript document，`ViewportState` 负责 `scrollTop`、`followEnd` 和阅读锚点，`ScreenRenderer` 在 alternate screen 中以差分帧绘制。
- resize 仅在实际尺寸变化后重新投影 document；向上阅读时，Markdown block 使用源文本偏移恢复锚点，避免因重新换行跳到其他段落。
- 普通文本、推理和工具参数流统一使用合并调度；输出完成时不再向原生 scrollback 重放整段 transcript。
- activity span 默认折叠，Ctrl+O 只作用于当前焦点或最近可见的 activity/reasoning block。
- 输入已接入统一路由；滚轮只滚动 viewport，内容区支持 CJK 宽字符、表格、Markdown、跨 resize 的语义选择与复制。被截断的表格单元格按可见文本复制，例如 `targ…` 复制为 `targ…`。

验证基线：`npm test`、`npm run verify`、`git diff --check` 和 `npm pack --dry-run` 均通过。真实 Harness PTY fixture 仍需在具备对应环境时补做人工/集成验收。
