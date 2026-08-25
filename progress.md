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
