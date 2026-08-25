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
| CR-007 | P1 | resolved | Transcript 渲染 | turn/end 与 resize 均不再全量回放历史，真实 resize 处理器已覆盖 |
| CR-008 | P2 | resolved | 输入编辑器 | Option+←/→ 已使用 Unicode 文本段导航，中文不再整段首尾跳转 |

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
- **建议修复：** 第一阶段保持 native scrollback，改为 append-only：`turn/end` 只完成增量 flush 并重绘 footer（`scheduleRender(true)`），`onResize` 仅执行 `clearFooter()` 与 `render()`，不调用 `repaint(true)` 进行全量 transcript replay。全量 `repaint(true)` 仅保留给初始化、切换会话和用户显式展开等确实需要重建历史的场景。
- **验收标准：** `turn/end` 与 resize 期间不再触发 `repaint(true)`；单测验证 `turn/end` 与 resize 均仅触发 Footer 刷新重绘。
- **关闭验证：** resize 防抖后直接调用 `render()`，保留其既有的终端缩窄补偿。回归测试创建真实 `TuiApp` 实例、调用 `app.onResize()` 并断言只执行一次 `render()`，既不调用 `repaint()`，也不提前清空 footer 状态。`npm test` 通过。

### CR-008：Option+左右无法对 Unicode 文本按词移动
- **优先级：** P2
- **状态：** resolved
- **位置：** `src/input/editor.js:45-57`, `src/index.js:5362-5363`, `src/index.js:5573-5574`
- **现象：** 快捷键序列映射本身已覆盖 macOS 常见的 `Esc+b/f` 与 `CSI 1;3D/C`，但 `moveWordLeft/Right()` 只以 `\s` 判定词边界。没有空格的中文句子和 `hello,world` 会被视为单个词，因此从开头向右直接跳到结尾、从结尾向左直接跳到开头，看起来像首尾互跳。
- **关闭验证：** `moveWordLeft/Right()` 已改用 `Intl.Segmenter` 的 Unicode word 分段，并将非空白标点、emoji 等作为可导航文本段。测试覆盖中文、英文标点、首尾边界以及 `Esc+b/f`、`CSI 1;3D/C` 两类序列；中文 `这是一个测试输入框` 从开头向右移动到 index 1，从结尾向左移动到 index 8。`npm test` 通过。
- **建议修复：** 使用 Node 20 可用的 `Intl.Segmenter`（`granularity: 'word'`）或等价 Unicode-aware 边界算法，统一产出左右移动目标；保留空白跳过语义并确保索引落在 grapheme 边界。不要在首尾循环：cursor 0 + Option+← 保持 0，cursor end + Option+→ 保持 end。
- **验收标准：** 覆盖中文、英文空格、标点、emoji/组合字符、多行文本，以及 `Esc+b/f`、`CSI 1;3D/C` 两类终端序列；所有首尾越界操作保持原位。

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
