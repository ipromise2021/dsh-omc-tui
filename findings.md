# 代码审查发现与跟踪

## 审查信息
- **审查日期：** 2026-08-25
- **审查基线：** `c4caf4c` (`main`, `origin/main`)
- **范围：** 权限审批、Jobs/后台进程、退出生命周期、Browser 租约、相关文档与回归测试
- **当前结论：** CR-001～CR-008 的代码整改与单元回归均已完成；未发现新的代码级阻断，可进行终端人工验收后提交。

## 问题总览

| ID | 优先级 | 状态 | 模块 | 摘要 |
|----|--------|------|------|------|
| CR-001 | P1 | resolved | 权限审批 | 官方权限写入失败后仍显示 `workspace-write` 已在会话生效 |
| CR-002 | P1 | resolved | 退出 / Jobs | 存在远程任务但无 `jobsService.kill` 时仍直接退出 |
| CR-003 | P2 | resolved | 本地进程 | Windows 下发送 SIGTERM 后无法可靠升级到 SIGKILL |
| CR-004 | P2 | resolved | Jobs 输出 | 增量文本块之间被强制插入换行，导致日志内容失真 |
| CR-005 | P2 | resolved | 文档 | Browser 自动回收描述与“保留并安全重连”实现相反 |
| CR-006 | P1 | resolved | 测试安全 | 进程终止回归测试可能向真实进程组 `12345` 发送信号 |
| CR-007 | P1 | resolved | Transcript 渲染 | turn/end 保持增量输出；resize 按用户选择全量重放以适配新宽度 |
| CR-008 | P2 | resolved | 输入编辑器 | Option+←/→ 已使用 Unicode 文本段导航，中文不再整段首尾跳转 |
| CR-009 | P1 | resolved | Shell 补全 | 关闭历史持久化时仍读取系统 Shell 历史 |
| CR-010 | P2 | resolved | Shell 补全 | 同时读取多个完整历史文件，可能混入旧 Shell 数据并拖慢启动 |
| CR-011 | P1 | resolved | Footer / resize | 终端宽度变化后旧 footer 的软换行残留，造成输入区与状态栏错位 |

## 详细发现

### CR-001：权限投影可能与 Harness durable state 不一致
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:4977`, `test/unit-regressions.mjs:1584`
- **现象：** 审批选项 2 调用 `permissionPresets.set/select` 时吞掉异常，随后无条件设置 `this.permissionName = 'workspace-write'`，并显示 `session wide` 成功提示。
- **影响：** API 调用失败时并没有写入 durable event，但 TUI 显示已经成功；后续工具仍可能继续审批，恢复会话后状态也会回退。
- **架构风险：** TUI 本地伪造权限状态，违反“Runtime 归 Harness、Projection 归 TUI”的项目契约。
- **建议修复：**
  1. 仅调用 Harness 当前正式接口 `permissionPresets.set(session, 'workspace-write')`。
  2. 调用成功后从 `permissionPresets.current(session.events)` 或对应 durable event 重新投影 `permissionName`。
  3. 调用失败时不要修改本地权限，保留当前审批，并向用户显示可恢复错误。
- **验收标准：** 模拟 `set()` 抛错时，不显示 session-wide 成功、不修改 `permissionName`；成功时 durable/current 与 UI 一致。
- **关闭验证：** 已在 `src/index.js` 中捕获 `permissionPresets.set` 异常，并在成功后从 `permissionPresets.current` 或 durable event 重新投影；单元测试已修正为官方 `permission/preset` 事件类型，并断言成功分支追加了 `allowed-once`。

### CR-002：无法取消远程任务时退出保护失效
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:3899`
- **现象：** `jobSnapshots()` 返回活跃远程任务但 `jobsService.kill` 不存在时，`stopRemote` 变为空数组，整个停止流程仍被视为成功并继续退出。
- **影响：** 用户选择“Stop all jobs and exit”后，远程任务可能继续运行，行为与确认面板承诺不一致。
- **建议修复：** 当 `remoteJobs.length > 0` 且缺少 `kill` API 时抛出明确错误，保留 TUI；宿主强制卸载路径继续使用现有 best-effort 模式。
- **验收标准：** 缺少 `kill` 时普通 `/exit` 不退出并显示原因；无远程任务时仍可正常退出。
- **关闭验证：** 已在 `stopRunningJobs()` 中增加对 `remoteJobs.length > 0 && typeof this.jobsService?.kill !== 'function'` 的明确抛错检查；在测试中验证了阻断退出并提示原因。

### CR-003：Windows 进程终止无法可靠升级
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:3866`
- **现象：** `signalLocalJob()` 使用 `child.killed` 作为提前返回条件。Node.js 中该字段只表示调用过 `child.kill()`，不代表进程已经退出。
- **影响：** Windows 第一次发送 SIGTERM 后 `child.killed` 变为 true；进程如果仍存活，后续 SIGKILL 会被提前拦截，可能留下后台进程。
- **建议修复：** 以 `close/exit` 驱动的 `job.status` 或独立 `exited` 标记判断是否已结束，不使用 `child.killed` 代替退出状态。
- **验收标准：** 模拟 SIGTERM 后仍未触发 close 的进程，1.5 秒后会收到 SIGKILL；已退出进程不会重复发送信号。
- **关闭验证：** 已移除 `signalLocalJob` 和 `stopLocalJob` 对 `child.killed` 的单一拦截，改为以 `isRunningJob(job)`（`status === 'running' || status === 'stopping'`）为准；测试中模拟 `child.killed=true` 情况下成功升级到 `SIGKILL`。

### CR-004：Jobs 增量输出被插入额外换行
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:3977`
- **现象：** 当前一块不以 `\n` 结束时，`appendJobOutput()` 在下一块前主动插入换行。
- **影响：** 文本流块边界不等于行边界；例如 `compil` + `ing` 会显示成两行，并破坏进度输出和 ANSI 序列。
- **建议修复：** 增量块必须原样拼接为 `${previous}${delta}`，仅由生产者输出实际换行。
- **验收标准：** 两个非换行结尾的块拼接后与原始完整输出逐字符一致。
- **关闭验证：** 已修改 `appendJobOutput` 为纯粹的 `${previous}${delta}` 直连；单元测试已增加 `compil` + `ing\n` -> `compiling\n` 的回归断言。

### CR-005：Browser 生命周期文档与实现相反
- **优先级：** P2
- **状态：** resolved
- **位置：** `CHANGELOG.md:52`, `CHANGELOG.md:202`
- **现象：** 文档声称退出时或 `beforeExit`/`SIGINT` 会自动回收 Browser 租约，但代码明确保留专用 Chrome，供用户完成登录并在下次 TUI 启动时安全重连。
- **影响：** 使用者和维护者会误判退出行为，后续可能重新引入“登录窗口被自动关闭”的缺陷。
- **建议修复：** 文档改为“退出时停止后台 Jobs；专用 Chrome 保留，通过 PID、端口、用户目录和受管标记验证后安全重连”。
- **验收标准：** CHANGELOG、README、系统提示与 `registerBrowserLease()` 的实际策略一致。
- **关闭验证：** 已同步更新 `CHANGELOG.md` 中对应章节表述，明确保留专用 Chrome、安全重连以及退出时仅停止后台 Jobs。

### CR-006：进程终止回归测试可能误杀真实进程
- **优先级：** P1
- **状态：** resolved
- **位置：** `test/unit-regressions.mjs:1619`
- **现象：** 测试使用整数 PID `12345` 调用真实的 `signalLocalJob()`。在非 Windows 平台，该方法首先执行 `process.kill(-12345, signal)`；只有系统调用失败后才回退到 fake child。
- **影响：** 如果测试机器上恰好存在进程组 12345，测试会向无关进程发送 SIGTERM，随后可能发送 SIGKILL，属于破坏性测试行为。
- **建议修复：** 不得在单元测试中使用真实 `process.kill` 路径。使用非整数 PID 强制走 fake child 分支，并直接验证两次信号调用。
- **验收标准：** 测试执行期间不调用真实 `process.kill`；仍能验证 `child.killed === true` 且 job 状态未结束时允许发送升级信号。
- **关闭验证：** 已修改测试 PID 为非整数安全字符串，避免触发系统级 `process.kill`，测试全量通过。

### CR-007：turn/end 与 resize 全量回放导致 scrollback 历史重复
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:1136-1143`, `src/index.js:345-354`
- **现象：** assistant 流式内容和工具事件已经通过 `commitToScrollback()` 增量写入；收到 `turn/end` 或触发终端 `onResize` 时又调用 `repaint(true)`，先发送 `ESC[3J ESC[2J ESC[H`，再把 welcome 和全部 durable events 全量写入一次。
- **影响：** VS Code Terminal、tmux 或部分终端对 `ESC[3J` 清除 scrollback 的实现不一致时，旧历史不会真正删除，全量回放内容会追加到旧内容后；用户向上滚动便看到整段重复。
- **建议修复：** `turn/end` 保持增量 flush 并重绘 footer（`scheduleRender(true)`）；resize 的策略由产品取舍决定。若优先保证内容按新宽度稳定布局，则 resize 采用 `repaint(true)`，清屏后重新格式化并输出当前会话。
- **验收标准：** `turn/end` 不触发 `repaint(true)`；resize 防抖后调用一次 `repaint(true)`，完整会话使用当前 `process.stdout.columns` 格式化。
- **关闭验证：** 根据用户确认，resize 改为清屏并全量重放，以优先保证窗口变化后的正文、工具块、输入区和状态栏布局稳定。回归测试验证真实 `TuiApp.onResize()` 仅触发一次 `repaint(true)`；`turn/end` 仍为增量收尾。已知取舍是少数终端可能保留旧 scrollback，导致历史重复，当前按用户要求暂不处理。

### CR-008：Option+左右无法对 Unicode 文本按词移动
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/input/editor.js:45-57`, `src/index.js:5362-5363`, `src/index.js:5573-5574`
- **现象：** 快捷键序列映射本身已覆盖 macOS 常见的 `Esc+b/f` 与 `CSI 1;3D/C`，但 `moveWordLeft/Right()` 只以 `\s` 判定词边界。没有空格的中文句子和 `hello,world` 会被视为单个词，因此从开头向右直接跳到结尾、从结尾向左直接跳到开头，看起来像首尾互跳。
- **关闭验证：** `moveWordLeft/Right()` 已改用 `Intl.Segmenter` 的 Unicode word 分段，并将非空白标点、emoji 等作为可导航文本段。测试覆盖中文、英文标点、首尾边界以及 `Esc+b/f`、`CSI 1;3D/C` 两类序列；中文 `这是一个测试输入框` 从开头向右移动到 index 1，从结尾向左移动到 index 8。`npm test` 通过。
- **建议修复：** 使用 Node 20 可用的 `Intl.Segmenter`（`granularity: 'word'`）或等价 Unicode-aware 边界算法，统一产出左右移动目标；保留空白跳过语义并确保索引落在 grapheme 边界。不要在首尾循环：cursor 0 + Option+← 保持 0，cursor end + Option+→ 保持 end。
- **验收标准：** 覆盖中文、英文空格、标点、emoji/组合字符、多行文本，以及 `Esc+b/f`、`CSI 1;3D/C` 两类终端序列；所有首尾越界操作保持原位。

### CR-009：关闭历史持久化时仍读取系统 Shell 历史
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/input/history.js:loadShellHistoryFile`
- **现象：** `persistHistory=false` 的分支仍先调用系统 Shell 历史加载器，并将结果作为补全来源。
- **影响：** 用户明确关闭历史后，TUI 仍会读取工作区外的命令记录；这既违背设置含义，也可能暴露敏感命令。
- **建议修复：** 系统 Shell 历史应默认为关闭的独立 opt-in；当历史持久化关闭时，任何系统历史读取都必须直接跳过。
- **验收标准：** 关闭持久化时，无论系统历史导入开关如何设置，返回空历史且不访问系统文件。
- **关闭验证：** 新增 `importSystemShellHistory` 设置，默认 `false`；`persistHistory=false` 在读取前直接返回空数组。回归测试覆盖关闭持久化和未显式启用两种路径。

### CR-010：系统历史来源和读取范围过宽
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/input/history.js:loadSystemShellHistory`
- **现象：** 实现同时读取 `$HISTFILE`、`.zsh_history`、`.bash_history` 的全部内容，再取末尾条目。
- **影响：** 可能重复导入、让旧 Shell 历史覆盖当前 Shell 的较新命令，并在大历史文件下增加启动时间和内存占用。
- **建议修复：** 仅选择 `$HISTFILE` 或当前 Shell 对应的单一历史文件，并以固定尾部字节上限读取。
- **验收标准：** 不混合多个文件；只返回末尾范围内的可解析命令；不可读文件安全降级为空历史。
- **关闭验证：** `$HISTFILE` 优先，否则只选择当前 Shell 的 `.zsh_history` 或 `.bash_history`；通过文件句柄只读取末尾 256 KiB，并丢弃可能截断的首行。回归测试验证显式文件不混入其他 Shell 历史、zsh 扩展格式解析和不可见的默认导入路径。

### CR-011：窗口 resize 后 footer 残留导致布局错位
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:clearFooter`, `src/index.js:render`
- **现象：** 旧实现只保存逻辑行数和上次光标行，窗口变窄后依赖宽度比例估算上移行数；Footer 的实际软换行高度与该估算不一致时，旧分隔线、输入框或状态栏会残留。
- **影响：** 内容区底部出现重复分隔线、状态栏和输入区域错位，截图所示布局无法恢复。
- **建议修复：** resize 时清屏并以新列宽重放当前会话；普通增量输出仍保留精确 footer 擦除，处理非 resize 的 footer 更新。
- **验收标准：** 缩窄及放大窗口时触发一次 `repaint(true)`，正文和 footer 都由新列宽重新格式化。
- **关闭验证：** 根据用户确认，resize 采用全量重放而非局部 footer 修补；普通增量输出仍记录 footer 实际文本并精确清除。回归测试验证 resize 调用 `repaint(true)`。

## 当前验证基线

| 检查 | 结果 | 备注 |
|------|------|------|
| `npm test` | passed | `unit regressions: ok`（包含 CR-001～CR-007） |
| `npm run verify` | passed | ESM 模块导入完整 |
| `git diff --check` | passed | 工作区干净 |
| npm 打包预检 | passed | 52 个发布文件 |
| `npm run test:pty` | blocked | 缺少 Harness fixture 环境变量 |

## 官方契约复核
- `@deepseek-ai/dsh-jobs` 声明 `read()` 返回下一段 stream delta，确认 Jobs 输出必须原样拼接，CR-004 的修复方向正确。
- `@deepseek-ai/dsh-jobs` 声明 `kill()` 是正式取消入口，取消失败时任务保持运行，确认 CR-002 必须在缺失或调用失败时阻止普通退出。
- `@deepseek-ai/dsh-permission-presets` 声明 `set(session, name)` 同步写入 durable event，正式事件类型为 `permission/preset`。

## 关闭规则
- `open`：已确认，尚未开始修复。
- `in_progress`：已有针对性代码或测试改动。
- `resolved`：实现完成且单元/模块检查通过。
- `verified`：PTY 或实际交互场景验证通过。
- 每项关闭必须附带测试名称、命令结果或人工复现记录。

## 发布前完整审查整改（2026-08-26）

| ID | 状态 | 处理与验证 |
|---|---|---|
| CR-012 | resolved | `cyclePermission()` 仅在 `permissionPresets.set()` 成功后更新投影；失败保留原权限并记录错误。`togglePlanMode()` 移除直接 session append 回退，服务缺失或写入失败均明确报错。|
| CR-013 | resolved | `/new` 保留旧会话为活动投影，直到候选会话完成权限 durable 写入；失败时释放候选 handle 和技能覆盖。request override 在切会话和退出时释放，避免遗留订阅。|
| CR-014 | resolved | 退出时取消当前与排队审批并释放输入路由；无拖拽鼠标抬起不再重置多击计数。|
| CR-015 | resolved | 文件补全通过 realpath 与相对路径边界检查，拒绝 `@../` 和解析后位于工作区外的目录。|
| CR-016 | resolved | 候选路径先完成元数据与订阅准备，再一次性提交活动会话；候选准备失败安全释放所有临时资源。|
| CR-017 | resolved | 会话切换字段在 viewport 重建前完整提交；重绘异常仅记录可恢复错误，不回滚已成功的会话切换。|
| CR-018 | resolved | 状态读取、目标计算与服务写入收敛于同一 try/catch 边界内。|
| CR-019 | resolved | 同步原子提交全部新会话状态，旧 handle 异步带超时 (flush 500ms, dispose 1000ms) 清理，杜绝半提交窗口。|
| CR-020 | resolved | `/new` 与 `/resume` 共享统一 session-scoped 状态重置逻辑，彻底隔离历史 localLog、expandedKeys、草稿与流状态。|
| CR-021 | resolved | `refreshSkills()` 异常时保留 `skillOverrideDisposers` 映射，保证 override 释放引用不丢失。|
| CR-022 | resolved | 封装 `withTimeout` 工具函数，在 finally 中自动 `clearTimeout`，彻底消除异步竞速遗留定时器。|

**验证：** `npm test`、`npm run verify`、`git diff --check` 以及 `npm pack --dry-run` 均通过。

**保留设计项：** 现有 durable event 未提供可靠的工具子树父子边界；`groupActivitySpans()` 仍以事件连续性分组。本轮未把 assistant 中间消息强行合并，避免把不同子树误折叠。应在 Harness 暴露 parent/turn/activity 边界后，再实现真正的“子树完成即整体折叠”。

### CR-016：会话切换仍不是完整事务
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:3891`, `src/index.js:4618`
- **现象：** `/preset` 在候选会话完成权限写入后立即赋值 `this.handle`、`this.agent`，但随后仍会执行 `composedPreset()`、`attachRequestOverride()`、状态投影等可抛错操作。catch 只会在候选尚未赋为活动会话时释放候选；提交点之后的异常会留下半初始化新会话。`/resume` 仍沿用同类早提交模式，且没有候选清理分支。
- **影响：** 用户可失去原会话的可用投影，或留下未释放的恢复会话/请求订阅；这与 CR-013 的“失败保持旧会话”目标不一致。
- **建议：** 将所有不会触及 `this` 的候选状态计算、订阅准备和 durable 投影先完成；最后一次性替换 app 的 session fields。若提交后仍需要失败操作，保存并恢复旧 handle、agent、override disposer 及投影状态。两条路径共用同一切换 helper，避免 `/preset` 与 `/resume` 再次漂移。
- **关闭验证：** 候选路径现在先完成预设/权限/usage 投影、reasoning 预计算和请求订阅，再一次性替换 app 会话；候选准备失败会释放 request override、技能覆盖和 Harness handle。回归测试注入 `/preset`、`/resume` 的候选预设投影失败，确认旧会话保持活动、候选被释放。`npm test`、`npm run verify`、`git diff --check` 和 npm 打包预检通过；PTY 测试仍因缺少 Harness fixture 阻塞。

### CR-017：`/resume` 提交后仍可能留下混合投影
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:4664-4698`
- **现象：** 新 handle/agent 和 request override 已提交、旧 handle 已 dispose 后，代码才执行 `restoreImageAttachments()`、usage/permission 赋值、`reprojectDocument()` 和 viewport 定位。其中图片历史或 transcript 投影抛错时，catch 因 `this.handle.agent === candidate.agent` 不会释放或回滚候选。
- **影响：** app 可能保留新 agent，但仍混用旧 session 的 usage、permission、document 或附件投影；用户看到 `/resume` 失败，实际当前会话却已切换。
- **测试缺口：** 现有 `latePresetFailureApp` 和 `resumeFailureApp` 都让 `composedPreset()` 在提交前抛错，只证明候选准备失败可清理，并未覆盖提交后的失败。
- **建议：** 在提交前构造所有纯投影数据；提交时一次性写完所有 session fields。提交后的 MRU、viewport 更新和重绘应改为不会改变切换成败的 best-effort UI 刷新，或保存旧投影并提供完整回滚。新增由 `restoreImageAttachments`/`reprojectDocument` 抛错的测试，明确最终 agent、handle、override 和投影状态。
- **关闭验证：** session fields 在 viewport 重建前完整赋值；`reprojectDocument()`/viewport 定位失败仅记录“已恢复但渲染失败”的可恢复错误，不再进入切换失败分支。图片附件内容非数组时安全跳过。新增提交后 `reprojectDocument()` 抛错的回归测试，确认新 agent/handle 保持活动、旧 handle 已释放。

### CR-018：状态读取发生在错误边界之外
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:2331`, `src/index.js:4482`
- **现象：** `cyclePermission()` 的 `service.current()` 和 `togglePlanMode()` 的首次 `service.get()` 均在 try/catch 之前执行。服务读取异常会直接穿过输入/命令处理器，绕过新增的错误提示与状态保持逻辑。
- **建议：** 将 current/get、目标状态计算和 durable 写入放进同一 try/catch；失败时仅记录错误并保持现有投影。
- **关闭验证：** `cyclePermission()` 和 `togglePlanMode()` 均将状态读取、目标计算和服务写入放入同一 try/catch；新增 current/get 抛错回归测试，确认只记录错误而不向输入处理器抛出。

### CR-019：会话提交点之后仍等待旧 handle 释放
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:3902-3919`, `src/index.js:4659-4675`
- **现象：** `/new`、`/preset` 和 `/resume` 在替换 `this.handle`、`this.agent` 与 request override 后，才 `await previous.dispose()`；其后才重置 reasoning、stream、usage、permission 和 transcript 相关字段。`previous.dispose()` 没有超时边界。
- **影响：** 旧 handle 释放变慢或一直 pending 时，应用已经指向新 agent，却长期保留旧会话的投影字段；期间的状态事件或重绘会显示混合会话，命令本身也无法完成收尾。
- **建议：** 候选准备完成后先一次性提交全部新会话字段，再把旧 handle 清理作为 best-effort 后置操作；或在提交前完成有界清理。不得在半提交状态跨越 `await`。
- **关闭验证：** 重构为同步原子调用 `commitSessionState(...)` 先行提交所有新会话引用与 session-scoped 状态；旧会话清理通过 `cleanupPreviousSession()` 封装，包含 flush (500ms) 和 dispose (1000ms) 超时防护与异常捕获，不再产生跨越 await 的半提交状态。

### CR-020：`/resume` 继承旧会话的本地投影状态
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:4676-4691`
- **现象：** `/resume` 只替换 reasoning、usage、permission 等部分字段，没有像新会话路径一样重置 `localLog`、`expandedKeys`、`streamBuffer`、`currentTurnReasoning`、`pendingImages`、提交标记和排队输入。
- **影响：** `reprojectDocument()` 会把旧会话的 `localLog` 合并进恢复会话；相同 seq 生成的折叠 key 还可能继承旧会话的展开状态。未提交的图片或排队输入也可能被带到另一个会话。
- **建议：** 明确定义并复用 session-scoped projection reset/snapshot；`/new` 与 `/resume` 使用同一字段清单，仅保留真正属于应用级的设置。
- **关闭验证：** `/new`、`/preset` 和 `/resume` 统一共用 `commitSessionState(...)` 重置逻辑，彻底清空 `localLog`、`expandedKeys`、`streamBuffer`、`streamActionText`、`streamLoopStopped`、`currentTurnReasoning`、`turnStats`、`turnHeaderCommitted`、`streamHeaderCommitted`、`lastQueuedText`、`queuedSubmissions`、`pendingImages`、`focusedBlockKey`、`baseTranscriptDocument`。新增单元回归测试验证旧日志、折叠键与输入状态均不泄漏到目标恢复会话中。

### CR-021：技能列表刷新失败会遗失已注册 override 的释放引用
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:4762-4778`
- **现象：** `refreshSkills()` 捕获列表异常时把 `skillOverrideDisposers` 直接替换为空 Map，但没有调用原 disposer；agent ctx 中的 override 仍然注册。
- **影响：** 服务短暂失败后，用户再次启用技能只能更新设置，无法移除遗留 override；技能可能直到重启会话才真正恢复。
- **建议：** 列表失败只降级 `skills` 展示，不应改动当前注册生命周期 Map；若确实要清空，必须先逐项 dispose。
- **关闭验证：** `refreshSkills()` 异常捕获中保留 `skillOverrideDisposers` 不变，仅降级展示 `this.skills = []`；新增回归测试注入列表异常，确认 override disposer 完好且后续可正常调用。旧会话清理时由 `cleanupPreviousSession` 逐项执行释放。

### CR-022：超时竞速遗留定时器
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:78-98`, `src/index.js:804`, `src/index.js:3939`, `src/index.js:4028`, `src/index.js:4204`, `src/index.js:4228`, `src/index.js:4745`
- **现象：** 使用原生 `Promise.race` 与 `setTimeout` 竞速时，操作在超时前快速完成不会取消另一侧的 timer，导致每次会话切换或作业取消都在事件循环中遗留活跃的定时器句柄。
- **影响：** 导致 Node.js 进程退出延迟与无意义的异步句柄占用。
- **建议：** 封装通用的 `withTimeout` 工具函数，在 `finally` 块中自动执行 `clearTimeout`，并在所有超时竞速路径中统一替换。
- **关闭验证：** 实现并导出 `withTimeout`，统一替换 `stop()`、`cleanupPreviousSession()`、`applyPresetConfirm()`、`resumeSelected()`、`stopLocalJob()` 和 `stopRunningJobs()` 中的竞速定时器；新增单元测试覆盖快速完成、超时 fallback 与超时 reject 场景，确认定时器正常清理。

### CR-023：危险命令参数分离与路径别名规避
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:150-250`
- **现象：** 原始正则只覆盖了紧邻组合参数和直接根路径形式。实际验证中 `rm -rf -- /`、`rm -r -f /`、`rm --recursive --force /`、`rm -rf /.`、`chmod -R 777 -- /` 等变体未被拦截。
- **影响：** 破坏了危险命令守卫的完备性，易被参数排列组合或路径别名绕过。
- **建议：** 引入结构化参数解析与路径规范化判定，准确识别递归、强制标志与根/主目录目标变体。
- **关闭验证：** 实现 `splitShellSegments`、`tokenizeArgs`、`checkDestructiveRm`、`checkDestructiveChmod` 及 `checkDangerousGitPush`；新增 15+ 项参数分离、`--`、路径别名（`/.`、`/..`、`/*`、`~/*`、`$HOME`、`${HOME}`）以及 `chmod -R 777 -- /` 的拦截回归断言，全部通过。

### CR-024：复合命令与子命令注入下 allow 规则子串穿透
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:85-185`, `src/core/danger-guard.js:560-630`
- **现象：** `allow` 规则在整行或子串上非锚定匹配，如配置 `allow: ["git status"]` 时，`git status $(rm -rf /)`、`git status `r\m -rf /`` 或 `git status rm -rf /` 会因包含 `git status` 前缀被整条放行。
- **影响：** 攻击者可借由前置安全命令或子 shell 命令替换（Command Substitution）掩护高危破坏性操作。
- **建议：**
  1. `allow` 模式编译强制应用全段精确锚定（`^(?:pattern)$`）；
  2. 实现 `extractSubshells`，递归提取并独立校验 `$(...)`、`` `...` `` 等命令替换子命令。
- **关闭验证：** 新增 `extractSubshells` 与全段锚定 `compileAllowPattern`；新增 `git status $(rm -rf /)`、`git status `r\m -rf /``、`echo "$(rm -rf ~)"` 拦截断言，确认子 shell 注入 100% 被拦截，普通合规 `git status` 正常放行。

### CR-025：新源码文件打包权限为 0600
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js`
- **现象：** 新建的 `src/core/danger-guard.js` 默认文件权限为 0600 (mode 384)，npm 打包发布后非所有者用户安装可能无法读取该模块。
- **关闭验证：** 文件权限已修复为 0644 (`-rw-r--r--`)，并通过 `npm pack` 校验打包 tarball 中的文件属性确为 `-rw-r--r--`。

### CR-026：rulesPath 参数未传递给加载函数
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:275-285`, `src/core/danger-guard.js:355-365`
- **现象：** `createDangerGuard` 将 `options.rulesPath` 仅作为布尔判断，随后仍调用无参 `loadDangerRules()`，导致自定义配置文件路径被忽略。
- **关闭验证：** `loadDangerRules` 接受 `rulesPathOrCwd` 参数，可读取任意显式 `.json` 文件或目录下的 `.dsh/danger-rules.json`；新增自定义临时路径规则加载与拦截回归测试。

### CR-027：Shell 转义与引号拼接绕过命令名检测
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:230-310`, `src/core/danger-guard.js:340-420`
- **现象：** 直接按源码字符串前缀匹配 `rm` 时，`r\m -rf /`、`r''m -rf /`、`"r"m -rf /`、`'rm' -rf /`、`\r\m -r -f -- /.` 均可绕过检测。
- **建议：** 引入 `unquoteToken()` 对命令名与所有参数进行规范化反转义，还原为真实可执行文件名（如 `rm`、`chmod`、`git`）后再匹配。
- **关闭验证：** 实现 `unquoteToken` 与 `getCommandFromTokens`，新增 `r\m -rf /`、`r''m -rf /`、`"r"m -rf /`、`'rm' -rf /`、`\r\m -r -f -- /.`、`\c\h\m\o\d -R 777 -- /` 及 `g\i\t push -f` 拦截回归测试，全部通过。

### CR-028：Shell 注释与代码数据字符串误拦截
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:185-230`, `src/core/danger-guard.js:630-670`
- **现象：** 全文正则兜底扫描不区分 shell 注释和数据参数，导致 `echo safe # rm -rf /` 被误判为删根目录，`node -e "console.log('git push --force origin main')"`、`grep -rn "rm -rf /" src/` 被误判为高危操作。
- **建议：** 去除未加引号的 shell 注释，并基于真实可执行命令及其 AST 参数结构化校验，不在安全命令（`echo`、`node`、`grep` 等）的数据参数中盲目进行全局危险正则扫描。
- **关闭验证：** 实现 `stripComments`，并将危险检测绑定到提取出的 `cmdName` 和 `args`；新增 `echo safe # rm -rf /`、`node -e "..."`、`grep -rn "..."` 及 `echo "rm -rf /"` 放行回归断言，全部通过。

## 主分支界面渲染与输出折叠分析（2026-08-25）

### 当前架构事实

- `main` 使用普通终端主屏和原生 scrollback；`openTerminal()` 没有进入 alternate screen。
- `onResize()` 以 80ms 防抖后无条件调用 `repaint(true)`；`repaint(true)` 用 `ESC[3J ESC[2J ESC[H` 清屏，再把 welcome、durable events 和本地日志一次性全量写回。
- transcript、footer 和提交路径普遍把列宽下限钳制为 60；真实窗口小于 60 列时，应用布局宽度与终端物理宽度不一致，会发生不可控软换行。
- 终端 scrollback 有宿主配置的容量上限。全量回放行数超过上限时，最早内容仍会被宿主丢弃；ANSI 没有可移植能力恢复用户 resize 前的原生 scrollback 阅读位置。
- `turn/end` 当前没有调用 `repaint(true)`，只做增量 flush 和 footer 调度；用户要求的“输出结束不再重绘”在该事件路径已经满足。

### 折叠链事实

- durable events 是完整真相源，但当前渲染器只按连续 tool/hook/approval 事件做启发式分组，没有读取父子节点或 subtree 标识。
- 多工具组默认折叠，单工具组默认直接展开；分组 key 是 `tools-${group[0].seq}`。
- live 路径 `commitUnprintedEvents()` 只格式化“本次尚未输出”的事件，并立即推进 `lastCommittedSeq`。因此同一段工具活动常被拆成多个单工具块写入 scrollback，后续完整历史渲染虽能识别为一组，也无法原地收回已经写入的旧行。
- Ctrl+O 当前切换所有 reasoning/tool group，而非当前或最近一组，并调用 `repaint(true)` 全量清屏重放；它与 resize 的截断问题共享同一个根因。

### 可行性结论

- “resize 后所有历史按新宽度重排、仍可访问对话开头、并保持当前阅读位置”无法由普通终端原生 scrollback 在所有终端中可靠保证；需要应用自有 document + viewport，或接受宿主 scrollback 上限和位置丢失。
- “遍历完工具活动子树后立即折叠，Ctrl+O 可原位展开”可支持，但 live 阶段必须先缓冲事件，不再把每个工具节点立即提交到不可变 scrollback；可靠的原位展开仍需要应用自有 viewport。inline 回退只能用临时详情面板或在当前位置追加详情，不能可靠改写任意历史位置。

## 界面优化实施复核（2026-08-26）

- **状态：** resolved
- **实现：** 已采用 alternate screen、transcript document、viewport 和差分 screen renderer；历史内容不再依赖原生 scrollback 的原位改写能力。
- **resize：** 阅读锚点保存 block 的源文本偏移，Markdown 换行变化后仍定位到同一语义内容；底部 followEnd 行为保持不变。
- **流式与折叠：** text、reasoning、tool-call delta 使用同一合并调度；activity/reasoning 默认折叠，Ctrl+O 只切换焦点或最近可见 block。
- **输入与选择：** SGR 鼠标滚轮只滚动 viewport；Markdown、CJK、表格及窄表格省略号使用可见文本映射，复制内容不含 ANSI 或隐藏字符。
- **关闭验证：** `npm test`、`npm run verify`、`git diff --check` 与 npm 打包预检均通过；真实 Harness PTY fixture 仍待环境具备后执行。
