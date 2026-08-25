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
