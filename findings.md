# 代码审查发现与跟踪

## 审查信息
- **审查日期：** 2026-08-26
- **审查基线：** `40a1c22` (`main`, `origin/main`, `v0.2.2`)
- **范围：** 全部产品源码、发布元数据、npm 包内容、Harness 契约、TUI 投影与输入、危险命令守卫、平台边界和资源生命周期
- **当前结论：** CR-001～CR-059 全部审查发现的代码整改与全量单元/回归测试均已 100% 闭环；未发现新的阻断项，模块导入与打包预检完整通过。

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
| CR-049 | P1 | resolved | ScreenRenderer | 物理清屏未使差分缓存失效，相同帧可能不再绘制 |
| CR-050 | P1 | resolved | 消息提交 | `followup()` 拒绝未捕获，并丢失用户草稿 |
| CR-051 | P1 | resolved | Danger Guard | Windows PowerShell/CMD 破坏性命令未被拦截 |
| CR-052 | P2 | resolved | 安全文档 | README 缺少 Danger Guard 配置与边界说明 |
| CR-053 | P1 | resolved | Provider | 编辑 Provider 留空密钥会移除原凭据引用 |
| CR-054 | P1 | resolved | 环境变量 | 未导出的 shell rc 变量被提升给 Agent 子进程 |
| CR-055 | P2 | resolved | Provider | 缺少 credentials 能力仍报告密钥保存成功 |
| CR-056 | P1 | resolved | `/btw` | 隔离问答 Agent 未限制工具，可能产生副作用 |
| CR-057 | P1 | resolved | 生命周期 | stop 未释放当前 Agent 与 session skill overrides |
| CR-058 | P1 | resolved | 权限审批 | 输入框已有单字 `y` 会预先批准后续请求 |
| CR-059 | P2 | resolved | 权限审批 | 已 abort 的排队审批仍显示为可操作卡片 |

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

### CR-029：复合子 shell 分段截断绕过
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:35-105`, `src/core/danger-guard.js:675-690`
- **现象：** `splitShellSegments` 未跟踪 `$()`、反引号和进程替换的嵌套深度，导致子 shell 内的分号被当作外层分隔符，`echo $(rm -rf /; echo done)`、`echo $(echo safe; rm -rf /)`、`echo `rm -rf /; echo done`` 会被拆碎截断而放行。
- **建议：** 分段器完整跟踪 `parenDepth` 与 `inBacktick`，并在分段前先行递归提取子 shell。
- **关闭验证：** 重构 `splitShellSegments` 跟踪括号与反引号嵌套，外层 `checkDangerCommand` 与每段递归执行子 shell 审查；新增 `echo $(rm -rf /; echo done)`、`echo $(echo safe; rm -rf /)`、`echo `rm -rf /; echo done`` 拦截断言，全部通过。

### CR-030：包装命令带值选项解析逃逸
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:300-380`, `src/core/danger-guard.js:640-660`
- **现象：** `sudo --user root rm -rf /`、`sudo -C 3 rm -rf /`、`env -u SAFE rm -rf /`、`exec -a cleanup rm -rf /`、`timeout 10s rm -rf /` 中，选项值被误当作真实命令名，导致后续高危目标被漏检。
- **建议：** 建立包装命令（sudo、env、exec、timeout、command 等）选项字典，准确消耗选项参数；同时对 tokens 序列执行保守扫描，防止未知包装选项漏检。
- **关闭验证：** 扩充 `SUDO_VALUE_OPTIONS`、`ENV_VALUE_OPTIONS`、`EXEC_VALUE_OPTIONS`、`TIMEOUT_VALUE_OPTIONS`，并增加 token 序列保守兜底；新增 `sudo --user root`、`sudo -C 3`、`env -u SAFE`、`exec -a cleanup`、`timeout 10s` 等拦截断言，全部通过。

### CR-031：allow 正则 alternation 锚点逃逸
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:540-560`
- **现象：** `compileAllowPattern` 仅简单判断首尾字符，当用户提供包含 `|` 的规则（如 `^git status|git log$` 或 `^git status|echo safe`）时，由于 `|` 优先级最低，`git status rm -rf /` 依然会被前半段子模式放行。
- **建议：** 模式统一强制编译为 `^(?:${pattern})$`，确保整个表达式两端严格受限。
- **关闭验证：** 采用 `^(?:${pattern})$` 编译 allow 规则；新增 `^git status|git log$`、`^git status|echo safe` 对应 `git status rm -rf /`、`git log rm -rf /` 拦截断言，全部通过。

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

## 危险命令守卫专项复核（2026-08-26，基线 ec7bdd2 + 未提交改动）

- **范围：** 最新提交 `ec7bdd2`（danger-guard.js 初版 + TuiApp 生命周期集成）与工作区未提交改动（CR-029～CR-031 修复）。
- **验证方式：** 直接以 `node` 调用 `checkDangerCommand` 实测 25+ 条绕过与边界用例；`npm test` 通过（现有套件未覆盖下述缺口）。

### CR-032：`-c` 引号载荷绕过包装器解析
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:395-513`（getCommandFromTokens）, `src/core/danger-guard.js:520-560`（checkShellExecCommand）
- **现象：** `sh -c 'rm -rf /'`、`bash -c "rm -rf /"`、`su -c 'rm -rf /'`、`sudo sh -c 'rm -rf /'` 全部 ALLOWED。引号把完整载荷合并为单个 token（`rm -rf /`），兜底扫描仅做 `token === 'rm'` 精确匹配；`sh/bash/su` 不在包装器字典中。
- **建议：** 将 `sh/bash/dash/zsh/fish/su` 的 `-c/--command` 取值作为子命令递归 `checkDangerCommand`。
- **关闭验证：** 实现了 `checkShellExecCommand` 识别主流 Shell 解释器与 `-c` / `--command` 参数并递归安全校验；新增 `sh -c "rm -rf /"`、`bash -c "rm -rf /"`、`su -c "rm -rf /"`、`sudo sh -c "rm -rf /"` 拦截断言，全部通过。

### CR-033：裸括号分组与 find -exec 绕过
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:120-220`（extractSubshells）, `src/core/danger-guard.js:480-515`（checkFindCommand）
- **现象：** `(rm -rf /)` ALLOWED（token 化后首 token 为 `(rm`，兜底精确匹配失败）；`find / -exec rm -rf {} \;` ALLOWED（`-exec` 后的命令不被解析）。加空格变体 `( rm -rf / )` 反而 BLOCKED，行为不一致。
- **建议：** 提取裸 `( ... )` 命令分组并递归审查；对 `find` 的 `-exec` 命令部分（含 `-delete`）单独解析审查。
- **关闭验证：** `extractSubshells` 增加了对裸 `( ... )` 语法分组的识别与提取；新增 `checkFindCommand` 对 `find` 的 `-delete` 与 `-exec ...` 深度审查；新增 `(rm -rf /)`、`find / -exec rm -rf {} \;`、`find . -exec rm -rf / \;`、`find / -delete` 拦截断言，全部通过。

### CR-034：子 shell 计算的目标路径绕过
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:380-450`（checkDestructiveRm / checkDestructiveChmod）
- **现象：** `rm -rf $(echo /)`、`rm -rf /$(echo tmp)` ALLOWED。目标被替换为 `__subshell__` 占位符后不再匹配根/主目录模式。
- **建议：** 当 rm/chmod 目标包含子 shell 占位符时按保守策略拦截；或对占位符所在位置应用根目录模式检查。
- **关闭验证：** 在 `checkDestructiveRm` 与 `checkDestructiveChmod` 中加入 `target.includes('__subshell__')` 保守拦截；新增 `rm -rf $(echo /)` 与 `rm -rf /$(echo tmp)` 拦截断言，全部通过。

### CR-035：注释中的子 shell 被误拦截
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:630-670`（evaluateSegment / checkDangerCommand）
- **现象：** `echo hi # $(rm -rf /)`、`echo hi # `rm -rf /`` BLOCKED。子 shell 提取发生在 `stripComments` 之前，注释内容被当作可执行子命令，与 CR-028 消除注释误报的目标相悖。
- **建议：** 先 `stripComments` 再提取子 shell；或在 `extractSubshells` 中跳过未加引号注释区。
- **关闭验证：** 调整执行流水线：在提取子 shell 前先执行 `stripComments` 剔除未加引号的注释；新增 `echo hi # $(rm -rf /)`、`echo hi # `rm -rf /`` 正常放行断言，全部通过。

### CR-036：内置规则表从未参与评估
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:15-30`（DEFAULT_DANGER_RULES）, `src/core/danger-guard.js:565-590`（compileDangerRules）
- **现象：** `compileDangerRules` 只编译用户 block/allow；`evaluateSegment` 仅执行结构化检查 + 用户规则，`DEFAULT_DANGER_RULES` 为死代码。文件头注释声称用户 block "EXTEND the built-in table"，与实现不符。
- **建议：** 修正文件头与函数 doc 注释，明确内置高危规则统一由 AST/Tokenizer 结构化引擎承载，用户自定义 block 则编译扩展该基线。
- **关闭验证：** 澄清并对齐文档与代码，结构化 AST 引擎全量覆盖基线规则，`compileDangerRules` 编译用户正则补充规则；全量测试验证一致。

### CR-037：路径别名未规范化
- **优先级：** P3
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:275-310`（isRootOrHomeTarget）
- **现象：** `rm -rf ./a/../../` ALLOWED；真实执行会删除工作区上层目录。
- **建议：** 对目标执行 `path.posix.normalize` 后再与根/主目录模式比较；保守策略可拦截任何规范化后逃出工作区的目标。
- **关闭验证：** `isRootOrHomeTarget` 引入 `node:path/posix` 的 `normalize` 解析相对路径与 `..` 越界；新增 `rm -rf ./a/../../` 与 `rm -rf /tmp/../` 拦截断言，全部通过。

## 危险命令守卫二次复核（2026-08-26，CR-032~037 修复后）

- **验证方式：** 以 `node` 直调 `checkDangerCommand` 实测 22 条绕过与边界用例；CR-032~037 原用例全部通过，`npm test` 通过。以下为修复后新发现。

### CR-038：注释截断子 shell 提取（CR-035 修复引入的回归）
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:140-240`（extractSubshells 注释感知）
- **现象：** `echo $(rm -rf / # c)`、`echo `rm -rf / # c``、`echo $(rm -rf /; # c)` 均 ALLOWED。外层先执行 `stripComments`，把子 shell 内部的注释连同右括号一并剥除，括号不再闭合，`extractSubshells` 提取失败。
- **建议：** 恢复“先提取子 shell、后剥注释”的顺序，并将外层注释感知下放到 `extractSubshells`：在顶层遇到未加引号的 `#` 时停止扫描，而在子 shell 内部 `(...)` 里完整捕获包含 `#` 的子命令，递归时由子 shell 的 `stripComments` 处理。
- **关闭验证：** 恢复了流水线顺序并在 `extractSubshells` 中支持顶层注释截断与子 shell 内部注释保留；新增 `echo $(rm -rf / # c)`、`echo `rm -rf / # c``、`echo $(rm -rf /; # c)` 拦截断言，全部通过。

### CR-039：组合短旗标绕过 `-c` 载荷检查
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:520-550`（checkShellExecCommand）
- **现象：** `sh -lc 'rm -rf /'`、`bash -ec 'rm -rf /'` ALLOWED。`checkShellExecCommand` 仅精确匹配 `-c`/`--command`，Shell 普遍支持的组合旗标 `-lc`/`-ec`（含义含 `-c`）不被识别，载荷未递归检查。
- **建议：** 短选项按字符拆解：匹配 `-[a-zA-Z]*c[a-zA-Z]*` 取下一 token 递归 `checkDangerCommand`；`--command=...` 内联取值也一并覆盖。
- **关闭验证：** 支持短旗标组合解构与 `--command=...` 内联参数提取；新增 `sh -lc "rm -rf /"` 与 `bash -ec "rm -rf /"` 拦截断言，全部通过。

### CR-040：相对路径逃逸检测不完整（CR-037 修复缺口）
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:280-320`（isRootOrHomeTarget 路径前缀深度与规范化）
- **现象：** `rm -rf a/../../b`、`rm -rf ../*` ALLOWED。深度算法只比较最终深度：`a/../../b` 最终为 0 但路径中途越出工作区（真实解析为 `../b`）；`../*` 的通配符组件被当作 +1 抵消了 `..`，实际会删除父目录全部内容。
- **建议：** 改为检查每个路径前缀的最小深度，任一前缀深度 < 0 即越界；通配符组件不参与深度抵消。
- **关闭验证：** `isRootOrHomeTarget` 实现了前缀最小深度检测与 `normalized.startsWith('../')` 逃逸拦截；新增 `rm -rf a/../../b` 与 `rm -rf ../*` 拦截断言，全部通过。

### CR-041：fork 炸弹注释误报与残留注释不一致
- **优先级：** P3
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:630-670`, `src/core/danger-guard.js:1-12`
- **现象：** `echo hi # :(){ :|:& };:` BLOCKED——fork 炸弹检查在剥注释前执行，导致注释中的示例代码触发误拦截；文件头注释关于内置规则与用户 block 的关系与实现细节需同步澄清。
- **建议：** 将 fork 炸弹检查移至剥离外层注释后的命令串上执行；同步修正文件头注释。
- **关闭验证：** 在 `stripComments(main)` 产出的有效命令上执行 fork 炸弹检测；新增 `echo hi # :(){ :|:& };:` 放行断言；更新文件头注释，全部通过。

## 危险命令守卫三次复核（2026-08-26，CR-038~041 修复后）

- **验证方式：** `node` 直调实测 40 条用例（CR-032~041 全量回归 + 新边界）；`npm test` 通过。CR-038~041 修复均闭环，前两轮全部用例无回归。
- **复核备注：**
  - `rm -rf ../build` 现被拦截：`normalized.startsWith('../')` 比"逃出工作区"更严格，属于"cwd 即工作区根"假设下的保守取舍，行为一致可接受。
  - `rm -rf /tmp/__subshell__` 字面文件名仍被 CR-034 占位符保守拦截误伤（CR-041 已备注）。

### CR-042：`-c` 与引号载荷粘连绕过
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:705-750`（checkShellExecCommand）
- **现象：** `bash -c'rm -rf /'`、`sh -c"rm -rf /"` ALLOWED。Shell 允许旗标与引号载荷之间不加空格，tokenizer 将 `-c'rm -rf /'` 粘连为单个 token；`unquoteToken` 剥引号后得到 `-crm -rf /`，`checkShellExecCommand` 的含 `c` 短旗标分支把下一 token（`-rf`）当作载荷递归检查，真实载荷留在旗标 token 内被漏检。真实 Shell 中该命令执行 `rm -rf /`。
- **建议：** 对匹配 `/^(-[a-zA-Z]*c)(.*)$/` 的 token，提取剥去 `-c`/`-lc` 前缀后的粘连内容并与后续 token 组合为载荷递归 `checkDangerCommand`。
- **关闭验证：** 实现了对 `-c` 粘连参数（`bash -c'rm -rf /'`、`sh -c"rm -rf /"`、`sh -lc'rm -rf /'`、`bash -c'rm -rf' /`）的完整剥离与递归安全判定；新增对应拦截断言，全部通过。

## 危险命令守卫四次复核（2026-08-26，CR-042 修复后）

- **验证方式：** `node` 直调 33 条全量回归（CR-032~042 全部用例）+ 9 条粘连变体实测；`npm test` 通过。CR-042 修复闭环：`bash -c'rm -rf /'`、`sh -c"rm -rf /"`、`bash -lc'rm -rf /'`、粘连 + 后续参数均拦截，`sh -c'echo hi'` 正常放行，无回归。

### CR-043：ANSI-C 引号 `$'...'` 载荷绕过
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:290-380`（tokenizeArgs / unquoteToken）, `src/core/danger-guard.js:705-750`（checkShellExecCommand）
- **现象：** `bash -c$'rm -rf /'` ALLOWED。`tokenizeArgs`/`unquoteToken` 不识别 Bash/Zsh/Ksh 的 ANSI-C 引号 `$'...'`，剥引号后 `$` 残留在载荷首部，递归检查时命令名变为 `$rm` 而漏检。真实 Shell 展开后执行 `rm -rf /`。
- **建议：** `unquoteToken` 识别 `$'...'` 与 `$"..."` 前缀并将内部内容按标准引号与十六进制转义（`\x72\x6d`）还原，`-c` 载荷剥去 `$` 识别真实命令。
- **关闭验证：** `tokenizeArgs` 和 `unquoteToken` 完整支持了 `$'...'`、`$"..."`、十六进制 `\xHH` 与 C-escape 反转义；新增 `bash -c$'rm -rf /'`、`bash -c $'rm -rf /'`、`$'rm' -rf /`、`$'\x72\x6d' -rf /`、`$"rm" -rf /` 拦截断言，全部通过。
- **已知边界：** 命令替换式载荷（`-c$(printf 'rm -rf /')`）属图灵完备混淆，静态检测无法穷尽；守卫定位为最后防线之一，需与 Harness 权限系统叠加使用，建议在 README 威胁模型中注明。

## 危险命令守卫五次复核（2026-08-26，CR-043 修复后）

- **验证方式：** `node` 直调 35 条全量回归（CR-032~043 全部用例）+ ANSI-C 转义变体实测；`npm test` 通过。CR-043 主用例闭环：`bash -c$'rm -rf /'`、`\xHH` 十六进制载荷均拦截，`echo $'rm -rf /'` 数据参数正常放行，无回归。

### CR-044：ANSI-C 转义解码表不完整
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:360-440`（unquoteToken 的 inAnsiC 转义分支）
- **现象：** `bash -c$'\u0072\u006d -rf /'`、`bash -c$'\162\155 -rf /'`、`bash -c$'\cX...'` 仍 ALLOWED。`unquoteToken` 仅解码 `\xHH`/`\n`/`\t`/`\r`/`\'`/`\\`，Bash ANSI-C 的 `\uHHHH`、`\UHHHHHHHH`、`\0nnn`（八进制）、`\cX`（control char）、`\a\b\e\f\v` 未解码，残留在载荷中导致命令名失真漏检。真实 Bash 4.2+ 均展开执行 `rm -rf /`。
- **建议：** 补齐解码表（`\uHHHH`、`\UHHHHHHHH`、`\0nnn`、`\cX`、`\a\b\e\E\f\v\?`）。
- **关闭验证：** `unquoteToken` 完整实现了标准 ANSI-C 转义全表解码；新增 `bash -c$'\u0072\u006d -rf /'`、`bash -c$'\162\155 -rf /'`、`bash -c$'\0162\0155 -rf /'`、`bash -c$'\U00000072\U0000006d -rf /'` 拦截断言，全部通过。

## 危险命令守卫六次复核（2026-08-26，CR-044 修复后）

- **验证方式：** `node` 直调 35 条全量回归（CR-032~044 全部用例）+ ANSI-C 全转义表变体实测；`npm test` 通过。CR-044 修复闭环：`\uHHHH`、`\0nnn`、`\UHHHHHHHH` 载荷均拦截，`$'\a\b\e\f\v\n\t\r'` 数据参数正常放行，无回归。`\cX`（control char）无法拼出 `rm` 类命令，ALLOWED 属预期。

### CR-045：超范围 `\U` code point 导致守卫抛异常
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:375-400`（unquoteToken 的 `\U` 分支与安全 try/catch）
- **现象：** `bash -c$'\Uffffffff'`、`bash -c$'\U00110000'` 触发 `String.fromCodePoint` 的 `RangeError: Invalid code point`，异常未捕获，沿 `unquoteToken → evaluateSegment → checkDangerCommand → tools.guard 回调` 向上抛出。守卫位于 `tools/pre-execute` 拦截点，任何含超范围 `\U` 的工具调用都会让拦截回调崩溃，可能打断工具调用循环或产生未处理异常。
- **建议：** 解码前校验 code point ≤ 0x10FFFF，越界时保守保留原字符序列（不抛异常）；并在 `unquoteToken` 入口整体 try/catch 降级返回原始 token。
- **关闭验证：** 实现了 `code <= 0x10FFFF` 安全校验与 `unquoteToken` 全局 `try/catch` 容错降级；新增 `bash -c$'\Uffffffff'` 与 `bash -c$'\U00110000'` 的健壮性回归测试，全部通过且零异常。

## 危险命令守卫七次复核（2026-08-26，CR-045 修复后）

- **验证方式：** `node` 直调 35 条全量回归 + 异常输入与深度嵌套实测；`npm test` 通过。CR-045 修复闭环：`\Uffffffff`、`\U00110000` 不再抛异常（fail-open 保留原序列），`\u0072\u006d` 载荷正常拦截，无回归。

### CR-046：深层嵌套子 shell 递归栈溢出与 O(N²) 阻塞
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:15-20`, `src/core/danger-guard.js:900-1030`（checkDangerCommand 递归深度与命令长度限制）
- **现象：** 约 20000 层 `$($($(...)))` 嵌套（≈100KB 输入）触发 `RangeError: Maximum call stack size exceeded`，异常沿 `tools.guard` 回调上抛，与 CR-045 同机理的崩溃路径；实测 5000 层耗时 960ms、呈 O(N²) 增长，更大输入会在 `tools/pre-execute` 拦截点长时间阻塞事件循环。
- **建议：** `checkDangerCommand` 增加递归深度参数（如 depth ≥ 32 停止向下递归）；对输入设置长度上限（如 128KB）；顶层使用 `try/catch` 保护。
- **关闭验证：** 实现了 `MAX_RECURSION_DEPTH = 32` 与 `MAX_COMMAND_LENGTH = 131072`，在子 shell 提取与 shell -c 递归检查中全程透传深度；新增 20,000 层深度嵌套性能与栈安全回归测试，在 120ms 内极速完成且零溢出异常。

## 危险命令守卫八次复核（2026-08-26，CR-046 修复后）

- **验证方式：** `node` 直调 36 条全量回归 + 深度/长度边界实测；`npm test` 通过。CR-046 崩溃修复生效：20000 层嵌套 113ms 零异常。但深度与长度超限均采用 fail-open（放行），实测引入两个新绕过。

### CR-047：深度超限 fail-open 导致低门槛绕过
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:910-915`, `src/core/danger-guard.js:995-1002`（checkDangerCommand 与 evaluateSegment 深度超限拦截）
- **现象：** 仅 33 层嵌套（约 200 字节）即可绕过：`echo $($(...$(rm -rf /)...))` 33 层 → ALLOWED，而 32 层时正常拦截。深度超限返回 `null` 意味着嵌套内的危险命令整棵被放行，攻击成本远低于 CR-046 的崩溃场景。`MAX_RECURSION_DEPTH = 32` 的 fail-open 语义使该阈值成为公开的绕过配方。
- **建议：** 深度超限改为 fail-closed：`depth > MAX_RECURSION_DEPTH` 时返回拦截结果（`{ rule: '复合命令嵌套过深，已保守拦截', command }`）。
- **关闭验证：** 将深度超限语义由 fail-open 修正为 fail-closed；新增 33+ 层深度嵌套自动阻断断言，全部通过。

### CR-048：超长命令截断丢弃尾部危险片段
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:1003-1008`（MAX_COMMAND_LENGTH 超限拦截）
- **现象：** 超 128KB 输入按 `slice(0, MAX_COMMAND_LENGTH)` 保留头部：`(安全前缀 250KB) + rm -rf /` → ALLOWED。危险命令位于尾部时被截断丢弃，守卫整体放行。
- **建议：** 与 CR-047 一致改为 fail-closed：超长命令直接返回拦截结果（`{ rule: '命令长度超限，已保守拦截', command }`）。
- **关闭验证：** 将超长输入由截断策略修正为 fail-closed 保守阻断；新增 150KB+ 超长命令拦截断言，全部通过。

## v0.2.2 发布后全项目审查（2026-08-26，基线 `40a1c22`）

### CR-049：alternate screen 清屏后差分缓存未失效
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/commands/registry.js:82-98`, `src/renderer/screen.js:120-165`
- **现象：** `/clear` 直接向 stdout 写入 `ESC[3J ESC[2J ESC[H]`，但 `ScreenRenderer.prevScreenLines` 仍保留清屏前帧。随后 `commitToScrollback()` 在 alternate screen 中只调用普通差分 `render()`；缓存认为未变化的历史、输入框或状态行不会重画。
- **影响：** `/clear` 或 Ctrl+L 后界面可出现空白/局部缺行，直到对应行状态变化或 resize 强制全量重绘。
- **建议：** alternate screen 下不要直接绕过 ScreenRenderer 清屏；改为设置 `clearScreenRequested = true` 并重投影，或提供统一的 `invalidate()/renderFrame(..., { clearScreen: true })`。
- **关闭验证：** 为 `ScreenRenderer` 新增 `invalidate()` 并在 `/clear` 时使差分缓存失效；补充全量重绘断言，测试通过。

### CR-050：普通消息 followup 拒绝形成未处理 Promise
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:2565-2585`
- **现象：** `submit()` 以 `void this.submitUserMessage(...)` 启动异步提交，而 `submitUserMessage()` 最终直接调用 `this.agent.followup(message)`，既不 `await` 也不附加 rejection handler。注入 `followup()` 返回 rejected Promise 会触发 `unhandledRejection`。
- **影响：** Provider、会话或队列拒绝消息时可能产生未处理拒绝，原输入已经被清空且消息不会恢复。
- **建议：** `await this.agent.followup(message)` 并在同一错误边界中恢复输入、图片和排队状态，记录可见错误。
- **关闭验证：** `submitUserMessage` 中以 `try/catch` 完整包裹 `await this.agent.followup(message)`，拒绝时恢复草稿、图片附件与队列状态并记录日志；单元测试断言验证通过。

### CR-051：Windows shell 被纳入守卫工具名但没有 Windows 危险规则
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/core/danger-guard.js:806-895`, `src/core/danger-guard.js:1080-1090`
- **现象：** 守卫虽匹配 `pwsh`、`powershell` 和 `cmd`，但此前结构化检查只覆盖 Unix `rm/chmod/mkfs/dd/find` 和 Git，PowerShell/CMD 的高破坏性命令（如 `Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\*`、`format C:`）被放行。
- **影响：** Windows 平台上开启自动审批时破坏性系统命令未受看门狗拦截。
- **建议：** 为 PowerShell 和 CMD 建立独立的结构化规则及回归测试。
- **关闭验证：** 新增 `checkWindowsPowerShellCommand`、`checkWindowsCmdCommand`、`isWindowsRootOrSystemTarget` 及 Base64 EncodedCommand 解码审查；覆盖 `Remove-Item`、`Clear-Disk`、`Format-Volume`、`rd /s /q`、`del /f /s /q`、`format` 等破坏性指令，全量断言通过。

### CR-052：README 未说明 Danger Guard 的配置和安全边界
- **优先级：** P2
- **状态：** resolved
- **位置：** `README.md:220-265`
- **现象：** v0.2.1 CHANGELOG 宣布了 Danger Guard，但 README 没有说明 `.dsh/danger-rules.json` 的 `enabled/block/allow` 格式、`DSH_DANGER_GUARD=off`、守卫只拦截 Agent shell 工具调用，以及 Windows/动态 shell 展开等威胁模型边界。
- **影响：** npm 用户无法发现或正确配置该功能，也容易把启发式静态守卫误认为无条件自动审批下的完整安全沙箱。
- **建议：** README 增加独立安全章节、最小配置示例、平台覆盖矩阵，并明确必须与 Harness permission presets/沙箱叠加使用。
- **关闭验证：** 在 `README.md` 中增加独立章节《安全看门狗 (Danger Guard) 与安全边界》，包含完整平台覆盖矩阵、JSON 配置示例、停用方式与重要安全边界提示。

### CR-053：编辑 Provider 留空密钥会删除已有凭据引用
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:3300-3335`, `src/index.js:3400-3465`
- **现象：** 编辑表单把已有 Provider 标记为 `hasStoredKey`，UI 显示“configured · type to replace”；但 `saveProviderForm()` 只根据本次 `draft.apiKey` 是否非空决定是否写入 `apiKeyEnv`。用户按提示留空并修改 URL/模型时，新 profile 会省略原有 `apiKeyEnv`。
- **影响：** 普通编辑会静默断开已经保存的凭据，Provider 在重启或下次请求时失去鉴权。
- **建议：** 编辑时保留原 profile 的 `apiKeyEnv`，只有显式“清除凭据”操作才 unset；`hasKey` 应从 profile 引用及 credentials capability 得出。
- **关闭验证：** 编辑已有 Provider 且密钥栏留空时保留原有 `apiKeyEnv`；`hasKey` 改为真实读取 Profile 引用状态；新增留空保存回归测试并通过。

### CR-054：启动时把未 export 的 Shell 变量提升为 Agent 环境变量
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:489-518`
- **现象：** `loadSystemEnv()` 无条件读取 `~/.zprofile` 与 `~/.zshrc`，正则中的 `export` 是可选项，因此普通的 `PRIVATE_TOKEN=...`、只供交互式 shell 使用且未导出的变量也会被写入 `process.env`。
- **影响：** 启动 TUI 会改变原有 shell 可见性边界，把本不应传给子进程的本地变量和秘密暴露给模型可调用的命令。
- **建议：** 对 shell rc 文件严格要求显式 `export` 关键字；专用 `.dsh/.env` 文件保持常规键值解析。
- **关闭验证：** 区分 `.env` 与 shell rc 文件的匹配规则，shell rc 文件必须包含 `export` 关键字方可解析；新增未导出变量不提升断言并通过。

### CR-055：缺少 credentials capability 时 Provider 密钥只保存在当前进程
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:3445-3460`
- **现象：** 新建带 API key 的 Provider 时，`credentials.set` 是可选调用；服务不存在时仍把 profile 的 `apiKeyEnv` 引用持久化、只将真实值写进当前 `process.env`，然后提示“saved · ready”。重启后环境值消失，引用无法解析。
- **影响：** 用户得到成功提示但配置并不耐久，下一次启动才出现鉴权失败。
- **建议：** 有密钥输入时将 credentials capability 设为必需；不可用或写入失败必须中止 profile 提交并保留表单。
- **关闭验证：** 当用户输入新 API Key 时，若 `credentials.set` 不可用，立即终止保存并在表单上展示明确错误；新增断言并通过。

### CR-056：`/btw` 临时 Agent 未禁止工具调用
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/commands/btw.js:27-45`
- **现象：** `/btw` 创建临时 Agent 时没有 setup、工具限制或禁止工具的系统提示，只发送用户 query。模型可能在概念问答中调用文件、Shell 或其他有副作用的工具。
- **影响：** 隔离临时问答会话承诺不成立。
- **建议：** 与其他 sidecar 统一：设置 `origin/parentSession`，在 setup 中 restrict 空工具集并添加 monotonic guard。
- **关闭验证：** `/btw` Agent 在 `agents.create` 中配置 `meta`（`parentSession`, `origin: 'subagent'`, `delegationDepth`）并在 `setup` 中调用 `tools.restrict({ allow: [] })` 与 `tools.guard` 阻断一切工具调用。

### CR-057：插件 stop 未释放当前 Agent handle 与 skill overrides
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:770-845`
- **现象：** `TuiApp.stop()` 未遍历当前 `skillOverrideDisposers`，也没有调用当前 `this.handle.dispose()`。`sessionInitPromise` 也未被 stop 等待。
- **影响：** Cordis 热卸载、启动失败或宿主复用进程时，当前 Agent fiber、订阅及技能 override 会遗留。
- **建议：** 建立幂等的 stop promise：先等待初始化完成，再有界 flush + dispose 当前 handle，释放当前 skill overrides，并清空 handle/agent。
- **关闭验证：** `stop()` 统一使用 `this.stopPromise` 保证幂等，先等待 `sessionInitPromise`，释放全部 `skillOverrideDisposers`，调用 `this.handle.dispose()` 并清空引用；新增多重 stop 回归测试并通过。

### CR-058：审批出现前的 composer 草稿可自动授权
- **优先级：** P1
- **状态：** resolved
- **位置：** `src/index.js:1660-1685`
- **现象：** `pumpApprovals()` 打开新审批后立即读取此前已经存在的 `this.input`；只要草稿 trim 后等于 `y`，就清空输入并直接 settle 为 `allowed-once`。
- **影响：** 用户恰好在 composer 中输入单独的字母 `y` 时，随后到达的任意工具审批会在用户看到和审阅请求之前被允许。
- **建议：** 删除对既有 composer 内容的审批解释；审批只接受 panel 激活后由 InputRouter 分发的新事件。
- **关闭验证：** 移除了 `pumpApprovals` 中对输入框既有内容的预消费逻辑，保留输入草稿并等待显式交互；新增回归测试并通过。

### CR-059：已 abort 的排队审批会显示为可操作请求
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/index.js:1615-1685`
- **现象：** 多个审批排队时，后续 request 的 signal 可能在等待期间已经 aborted。轮到该项时只注册 abort listener，没有先检查 `signal.aborted`。
- **影响：** UI 会展示已经取消的陈旧审批并等待用户决策。
- **建议：** 入队和 pump 时都检查 `request.signal?.aborted`，直接 resolve cancelled；settle 还应加一次性保护。
- **关闭验证：** 在 `requestApproval` 入队与 `pumpApprovals` 出队时均检查 `request.signal?.aborted`，并在 `settle` 中增加一次性防抖保护；新增排队中 abort 与预先 abort 断言并通过。
