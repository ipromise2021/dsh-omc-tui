# 代码审查优化进度日志

## 会话：2026-08-25

### 恢复记录
- **状态：** complete
- `task_plan.md`、`findings.md`、`progress.md` 曾在未提交状态下被误删。
- Git 历史不包含本轮审查版本，已根据当前对话中保留的完整内容重建。
- 未修改同时存在的 `STREAM_GUARD_ANALYSIS.md`。

### 阶段 1：建立审查基线与跟踪文件
- **状态：** complete
- 执行的操作：
  - 确认 `main` 与 `origin/main` 位于 `c4caf4c`。
  - 审查权限审批、Jobs、退出、Browser 生命周期及最新文档。
  - 将 2 项 P1、3 项 P2 写入持久化跟踪文件。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 2：修复高优先级问题
- **状态：** complete
- 执行的操作：
  - CR-001：在 `src/index.js` 中捕获 `permissionPresets.set` 异常，只有成功写入时才重新投影权限，调用失败时保留当前审批并向用户显示明确错误。
  - CR-002：在 `stopRunningJobs()` 中增加当存在活跃远程任务且缺少 `jobsService.kill` 时的显式异常抛出，确保退出保护不会被绕过。
  - 在 `test/unit-regressions.mjs` 中添加针对 CR-001 和 CR-002 的回归测试。

### 阶段 3：修复中优先级问题
- **状态：** complete
- 执行的操作：
  - CR-003：修正 `signalLocalJob` 和 `stopLocalJob` 中的退出判定逻辑，不再以 `child.killed` 代替退出状态，确保 Windows 及各平台下存活进程可在 1.5s 后可靠升级到 `SIGKILL`。
  - CR-004：移除 `appendJobOutput()` 中强制插入 `\n` 的逻辑，直接按原始字节/文本流 `${previous}${delta}` 进行拼接。
  - CR-005：同步更新 `CHANGELOG.md` 中关于 Browser 租约的描述，与代码中保留专用 Chrome 并安全重连的实际机制保持一致。
  - 在 `test/unit-regressions.mjs` 中添加针对 CR-003 和 CR-004 的回归测试。

### 阶段 5：复审整改
- **状态：** complete
- 执行的操作：
  - CR-006：修复进程终止回归测试，使用安全非整数 PID 阻断系统级 `process.kill` 调用，消除测试误杀真实进程的风险。
  - CR-007（第一阶段完整闭环）：彻底消除非用户主动意图下的全量 transcript 回放。除 `turn/end` 阶段移除 `repaint(true)` 改为增量收尾与 `scheduleRender(true)` 外，同步将 `onResize()` 调整为仅执行 `clearFooter()` 与 `render()` 重绘底部输入/状态栏，避免拖动终端窗口大小或多回合交互在 VS Code Terminal / tmux 等环境下叠加出整段重复历史。
  - CR-001：补齐成功路径对 `allowed-once` 的断言，并将测试事件类型修正为官方 durable 事件 `permission/preset`。
  - 在 `test/unit-regressions.mjs` 中添加针对 CR-006、CR-007（含 turn/end 与 onResize）的回归测试。
  - 再次复审发现 resize 提前调用 `clearFooter()` 会绕过 `render()` 内置的终端缩窄补偿；新增 resize 测试也未调用真实实例的 `onResize`，尚不能关闭 CR-007。
  - 根据用户反馈新增 CR-008：Option+左右映射正常，但按词算法仅识别空白，导致中文和无空格文本整段首尾跳转；已记录 Unicode 分词与边界测试要求。
  - CR-007：resize 改为直接调用 `render()`，保留 footer 宽度补偿；测试改为调用真实 `TuiApp.onResize()`。
  - CR-008：使用 `Intl.Segmenter` 实现 Unicode 文本段导航，并覆盖中文、标点、首尾和两类 Option+方向键序列。
  - 复跑 `npm test`、`npm run verify`、`git diff --check` 与 npm 打包预检，全部通过。
  - 运行并通过全量 `npm test` 和 `npm run verify`。

### 阶段 6：Shell 补全与历史边界整改
- **状态：** complete
- 本轮复审新增并关闭 CR-009、CR-010：系统 Shell 历史改为 `/settings` 中默认关闭的独立开关；关闭历史持久化时直接返回空历史；启用后只读取 `$HISTFILE` 或当前 Shell 对应的单一文件的末尾 256 KiB。
- 运行 `npm test`、`npm run verify`、`git diff --check` 和 npm 打包预检，全部通过。

### 阶段 7：窗口 resize 全量重放整改
- **状态：** complete
- 根据用户截图新增并关闭 CR-011。用户明确选择“resize 优先布局稳定，全量重放可接受，历史重复暂不处理”；因此 resize 从局部 footer 重绘改为 `repaint(true)`，让整个会话按当前终端宽度重新格式化。普通增量输出仍保留精确 footer 清除。
- 运行 `npm test`、`npm run verify`、`git diff --check`，全部通过。

### 阶段 8：主分支界面渲染与输出折叠方案分析
- **状态：** complete
- 仓库不存在 `master`，已按用户意图切换到与 `origin/main` 对齐的 `main`；基线为 `95d6318`。
- 逐段分析 `onResize()`、`repaint(true)`、`commitToScrollback()`、`commitUnprintedEvents()`、`formatEvents()`、`toggleCollapsible()` 和 turn/end 回归测试。
- 通过合成 durable events 验证：严格连续的多个工具调用会折叠；中间夹 assistant 过渡消息时会被拆为多个单工具展开块，现有实现并不具备真正的“子树”投影。
- 确认 turn/end 已无全量 repaint；resize 和 Ctrl+O 仍共享清 scrollback + 全量重放路径。
- 新增 `UI_RENDERING_OPTIMIZATION_ANALYSIS.md`，给出 document/viewport 架构、activity span 定义、live 缓冲与原子折叠、定向 Ctrl+O、分阶段实施顺序、测试矩阵和验收标准。
- 根据后续交接要求补充统一输入事件路由、consumer 优先级、滚轮与输入历史隔离、语义内容选择、OSC 52/平台复制降级、终端原生选择逃生通道、异常清理契约及对应测试用例。
- 本阶段未修改任何产品源代码。

### 阶段 9：document + viewport 界面优化实施
- **状态：** complete
- 将 transcript 投影、viewport、screen renderer、activity 分组、输入路由、鼠标选择和剪贴板拆分为独立模块，并接入 `TuiApp` 的 alternate screen 生命周期。
- resize 使用 semantic source anchor 恢复 Markdown 阅读位置；普通文本、reasoning 和 tool-call delta 统一进行合并重投影。
- activity 默认折叠，Ctrl+O 只切换目标 block；滚轮不再穿透到输入历史。
- 修复多段 Markdown、CJK 表格、表格边框/空白边界和窄表格省略号的选择映射；省略号单元格按可见文本复制。
- 新增 transcript、viewport/screen、input router、鼠标选择等回归用例。
- `npm test`、`npm run verify`、`git diff --check` 与 npm 打包预检均通过。

## 测试结果
| 测试 | 预期结果 | 实际结果 | 状态 |
|------|---------|---------|------|
| `npm test` | 单元回归通过 | `unit regressions: ok` (含 CR-001~CR-007 全量回归用例) | passed |
| `npm run verify` | 核心模块可导入 | `All modules verified OK` | passed |
| `git diff --check` | 无空白错误 | 无输出 | passed |
| npm 打包预检 | 发布清单可生成 | 52 个文件，约 301.7 kB | passed |
| `npm run test:pty` | PTY 场景通过 | 缺少 `DSH_HOME`/`DSH_TEST_FIXTURE_HOME` | blocked |

## 错误日志
| 日期 | 错误 | 尝试次数 | 处理方式 |
|------|------|---------|---------|
| 2026-08-25 | PTY suite requires Harness home fixture | 1 | 记录环境阻塞，待具备 fixture 后补跑 |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 5 完成，CR-001～CR-008 已关闭，等待终端人工验收 |
| 我要去哪里？ | 交付成果与代码提交 |
| 目标是什么？ | 让权限、任务退出、进程清理、输出、历史渲染和文档行为一致且可验证 |
| 我学到了什么？ | 见 `findings.md` |
| 我做了什么？ | CR-001～CR-008 全部修复并通过回归验证 |

## 会话：2026-08-26

### 阶段 10：发布前完整审查整改
- **状态：** in_progress
- 依据最新完整审查，开始处理可确定的 P1/P2：权限/计划模式 durable 写入失败的投影一致性、会话预设切换原子性、退出时审批与输入路由清理、多击选择状态、补全目录的工作区边界。
- “工具子树”完整边界目前缺少可靠父子事件标识；本轮不以猜测性启发式更改活动分组语义，保留为后续设计项。
- 前两次 `npm test` 发现新增多击用例的插入位置/清理状态影响了既有用例；已将其移至既有双击断言之后并显式 `clear()`，属于测试隔离修正，不影响产品实现。
- 完成 CR-012～CR-015：权限与计划模式失败不再伪造成功；会话候选在 durable 写入失败时释放且旧会话保持活动；退出清理审批队列和输入路由；鼠标多击与补全目录边界已修复。
- 最终验证通过：`npm test`、`npm run verify`、`git diff --check`、`npm --cache /private/tmp/dsh-omc-tui-npm-cache pack --dry-run --json`。

### 阶段 11：会话切换原子性复审
- **状态：** in_progress
- 本轮复审确认常规单元、模块导入、空白检查与打包预检均通过；PTY 测试仍因缺少 `DSH_HOME`/`DSH_TEST_FIXTURE_HOME` 阻塞。
- 新发现 CR-016：`/preset` 的候选会话在完整初始化前已替换 app 投影，`/resume` 同样早提交且无候选失败清理。已记录为 P1，尚未修改产品代码。
- 已开始实现候选准备与原子提交。首次回归测试暴露旧预设测试缺少 Harness `agent.ctx.on()` 桩；已补齐该正式订阅契约后继续验证。
- 第二次回归测试暴露直接调用 `attachRequestOverride()` 的旧测试未提供新拆分出的 `createRequestOverride()`；已绑定真实 helper，随后测试通过。
- 已完成 CR-016：`/preset` 与 `/resume` 均在候选预设/权限/usage/请求订阅准备成功后才切换 app 会话；失败时释放候选资源。已新增两条候选投影失败回归测试，并完成单元、模块、空白与打包预检验证。

### 阶段 12：会话切换提交后失败复审
- **状态：** in_progress
- 当前 `npm test`、`npm run verify` 和 `git diff --check` 通过。
- 新发现 CR-017（P1）：`/resume` 提交并卸载旧会话后仍执行可抛错投影，失败会留下新 agent 与旧 UI 状态混用；现有测试只覆盖提交前失败。
- 新发现 CR-018（P2）：权限与 Plan 模式的 current/get 读取仍位于 try/catch 外，读取失败会逃逸输入处理器。
- 已关闭 CR-017：完成状态赋值后才进行 MRU 与 viewport 刷新；渲染失败降级为可恢复提示，图片附件历史对非数组内容安全跳过。新增提交后渲染失败测试，验证新会话保持活动且旧 handle 已释放。
- 已关闭 CR-018：权限/Plan 的读取、目标计算和写入均置于同一错误边界；新增读取异常回归测试。
- 验证通过：`npm test`、`npm run verify`、`git diff --check` 与 npm 打包预检。

### 阶段 13：会话切换与资源生命周期复审
- **状态：** in_progress
- 当前 `npm test`、核心模块导入、`git diff --check` 和 npm 打包预检通过；PTY 套件仍因缺少 Harness fixture 阻塞。
- 新发现 CR-019（P1）：两条切换路径在提交新 agent 后、完整投影重置前等待旧 handle 无界 dispose，仍存在半提交异步窗口。
- 新发现 CR-020（P1）：`/resume` 没有清理 `localLog`、折叠状态、图片草稿和流式/排队状态，目标会话会混入旧会话本地投影。
- 新发现 CR-021（P2）：技能列表读取失败时直接丢弃 override disposer Map，导致已注册 override 无法正常解除。
- 本阶段只完成审查与记录，未修改产品代码。
