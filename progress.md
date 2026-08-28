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

## 会话：2026-08-28

### 阶段 15：DSH v0.1.2-alpha.1 兼容性评估与 README 计划
- **状态：** complete
- 已读取 DSH 官方 `v0.1.1-rc.2` 发布说明：变更聚焦 DeepSeek 适配器的 Files API 图片上传/复用，以及按模型自动图像缩放与格式转换。
- 已确认插件当前 peerDependencies 以 `^0.1.1-rc.1` 为基线；主要适配面是 `persistImageDrafts()`、原生 vision 内容块和本地图片预缩放，暂不修改运行时代码或依赖版本。
- 已在 README 写入分阶段验证矩阵，并将公开安装与兼容性表述回调至已验证的 rc.1 基线；待 rc.2 fixture 回归全部通过后再升级声明与 peer 基线。
- 已根据最新发布更正目标为 `v0.1.2-alpha.1`：在原有图片验证外，新增 Profile/会话初始化、图片异步上传与 Context 计量、子代理参数契约的验证范围；rc.2 作为其中的图片链路中间版本保留参考。

### 阶段 16：未提交代码审查与大段粘贴折叠整改
- **状态：** complete
- `/clear` 改为创建新 Harness 会话，生命周期、用量和状态缓存重置路径合理；对应测试已改为等待命令返回 Promise。
- CR-060（P1）：修复 `submit()` 中的 `replaceAll(tag, () => item.text)` 回调替换，彻底避免 `$`、`$&`、`$'`、``$` `` 等特殊替换语法篡改原文；先预校验追踪占位符再展开，展开后不运行通用占位符正则，防止包含 `[Pasted text #99...]` 等日志内容的合法原文被误判与丢失。已添加包含这些字面量的回归测试。
- CR-061（P1）：将占位符实现为不可分割编辑单元，光标左右移动、分词导航均自动跨越 tag；Backspace / Delete 原子删除整个占位符并维护 `pastedTexts` 与计数器；`submit()` 成功前不清空映射以防数据丢失；`Ctrl+L` 独立为 `clearScreen()` 刷新清屏并保留上下文，与 `/clear` 创建新会话清晰解耦，文档已在 `PRODUCT_SHOWCASE.md` 同步。
- 验证结果：`npm test`、`npm run verify`、`git diff --check` 以及打包预检全部通过；PTY suite 仍因缺少 `DSH_HOME` / `DSH_TEST_FIXTURE_HOME` fixture 未执行。

### 阶段 17：DSH v0.1.1-rc.2 隔离环境适配验证
- **状态：** in_progress
- 用户确认将实际适配目标切换为 npm 已发布的 `v0.1.1-rc.2`；将使用独立 DSH Home 挂载当前本地插件，不覆盖全局 rc.1 安装。
- alpha.1 安装尝试返回 `ETARGET`，且 npm 版本列表最高为 `0.1.1-rc.2`；已停止 alpha.1 源码验证，不将其作为本轮依赖基线。
- rc.2 npm 包元数据已确认存在并声明 `dsh` 二进制及完整 rc.2 子包依赖；但本执行环境中 `npx`、`npm exec` 和直接 npm CLI 的临时安装均无错误退出且未写入目标目录。npm 配置确认非 dry-run、未禁用 lockfile 或 scripts，暂记录为环境落盘异常，不能作为 rc.2 运行验证结果。
- 已完成源码静态契约比对：rc.2 保留 `saveImages/saveImage`、可复用的附件引用元数据、`agents.create({ agentOptions })` 与 `session/event`，与插件调用方式兼容。所有 18 个 `@deepseek-ai/dsh-*` peer 依赖已统一提升为 `^0.1.1-rc.2`；README 安装命令和 Harness 兼容性契约同步更新。
- 验证结果：peer 基线结构检查、`npm test`、`npm run verify` 和 `git diff --check` 通过。实际 rc.2 Profile 的启动、图片与 PTY 验证仍因临时 npm 安装未落盘而待补。

## 会话：2026-08-29

### 阶段 18：v0.2.7 发布
- **状态：** complete
- 用户已明确授权发布 `v0.2.7`，范围为 reasoning effort 能力投影、第三方中转自定义映射、Gemini 三档示例及相关测试与文档。
- 保持 DSH npm 兼容基线为 `v0.1.1-rc.2`；不宣称已适配尚未发布到 npm 的 `v0.1.2-alpha.1`。
- 发布前检查确认 `v0.2.7` 尚未占用、GitHub CLI 登录正常；普通 `npm whoami` 曾因默认 registry 指向镜像站返回 `ENEEDAUTH`。
- npm 问题已定位为默认 registry 使用 npmmirror；现有 `NPM_TOKEN` 有效，显式指定 npm 官方 registry 后 `npm whoami` 返回 `tangsz`。
- 已将 `package.json` 更新为 `0.2.7`，并将 CHANGELOG 的 Unreleased 条目固化为 `v0.2.7`（2026-08-29）。
- `npm test`、`npm run verify` 与 `git diff --check` 通过；首次打包预检因全局 npm cache 中旧的 root-owned 文件返回 `EPERM`，将使用隔离临时 cache 重试。
- 隔离 cache 下 `npm pack --dry-run --json` 通过：`dsh-omc-tui@0.2.7` 包含 61 个文件，压缩体积 358,584 bytes，解包体积 946,923 bytes。
- 已创建 release commit `12fb440` 和注释标签 `v0.2.7`，并将 `main` 与标签推送到 GitHub。
- 已通过 npm 官方 registry 发布 `dsh-omc-tui@0.2.7`，dist-tag 为 `latest`。
- 已创建正式 GitHub Release `v0.2.7`；复核确认 npm `latest=0.2.7`，GitHub Release 非草稿、非预发布。

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

### 阶段 14：v0.2.2 发布后全项目代码审查
- **状态：** complete
- 审查基线：`40a1c22`，`main`、`origin/main` 与标签 `v0.2.2` 完全对齐；开始审查时工作区干净。
- 范围：发布元数据与包内容、Harness 核心契约和资源生命周期、TUI 投影/输入、危险命令守卫、测试与平台边界。
- 本阶段只审查，不修改产品实现；规划与发现同步记录在现有审查文档中。
- 发布基线初查：`package.json` 为 `0.2.2`、Node `>=20`，README npm 安装指令和 CHANGELOG v0.2.2 描述一致；包文件白名单覆盖运行时 `src`、Cordis patch、文档与许可证。
- 记录错误：首次更新阶段 14 时 patch 上下文格式错误；改用标准多文件 patch 后成功，不涉及产品代码。
- 已阅读 Browser lease、历史/MRU、autocomplete 边界、Git 状态缓存、vision sidecar、命令注册、ScreenRenderer、ViewportState 与 InputRouter；暂未确认新的外部资源泄漏。
- 待验证风险：alternate screen 下 `/clear` 直接写物理清屏序列，但没有让 ScreenRenderer 的 `prevScreenLines` 缓存失效，可能造成差分帧漏绘。
- 已确认 CR-049（P1）：最小 ScreenRenderer 复现证明物理清屏后差分缓存未失效，后续相同帧不会重画内容。
- 已确认 CR-050（P1）：`agent.followup()` rejected Promise 会触发 `unhandledRejection`，普通消息提交失败也不会恢复草稿。
- TUI 投影复核：durable base transcript 已缓存，流式阶段只重投影 live tail；viewport 的语义锚点、滚轮隔离、选择映射和差分 screen 主链未发现新的确定性问题。
- 输入 Unicode 复核：InputRouter 会分发 UTF-16 surrogate halves，但 TuiApp 连续插入后可重组原始 emoji；当前未形成可复现丢字，因此不记录问题。
- 已确认 CR-051（P1）：Windows `pwsh/powershell/cmd` 已列入守卫作用域，但 PowerShell/CMD 的递归删除、清盘和格式化命令全部实测放行。
- 文档初查：Danger Guard 的配置文件、禁用开关和威胁模型只出现在源码/CHANGELOG，README 尚未提供用户配置与平台边界说明；最终文档结论待综合测试后给出。
- 已确认 CR-052（P2）：README 缺少 Danger Guard 配置、作用范围和安全边界说明。
- 验证：`npm test`、`npm run verify`、`git diff --check`、npm pack dry-run 均通过；v0.2.2 包含 60 个文件，约 335 KB，所有条目 mode 均为 0644。
- PTY：当前环境未设置 `DSH_HOME`/`DSH_TEST_FIXTURE_HOME`，`~/.dsh` 也不存在可复制的 `profiles/tui` fixture；为避免污染真实用户会话未强行运行，保持环境阻塞记录。
- 记录错误：第三次多文件 patch hunk 格式错误；后续固定使用单文件独立 patch，不涉及产品代码。
- 已确认 CR-053（P1）：编辑已有 Provider 留空密钥会从新 profile 中移除原 `apiKeyEnv`，与 UI 的“留空保持/替换”语义冲突。
- 已确认 CR-054（P1）：启动读取 shell rc 时会把未 export 的赋值提升进 `process.env`，随后被 Agent/本地 shell 子进程继承。
- 已确认 CR-055（P2）：credentials 服务缺失时仍报告 Provider 保存成功，但密钥只存在当前进程，重启即失效。
- 已确认 CR-056（P1）：`/btw` 临时 Agent 没有像 vision/prompt suggestion sidecar 一样 restrict/guard 工具，可能在所谓隔离问答中产生副作用。
- 已确认 CR-057（P1）：插件 stop 不释放当前 Agent handle 和 session skill overrides，也不与初始化竞态协调。
- 完整模块导入验证：递归导入 `src` 下 51 个 JavaScript 模块，零失败；关键大文件 `node --check` 通过。
- 已确认 CR-058（P1）：审批弹出前 composer 中已有的单独 `y` 会直接触发 allowed-once。
- 已确认 CR-059（P2）：排队期间已 abort 的审批因未预检 `signal.aborted`，轮到时会成为陈旧可操作卡片。
- 记录错误：第二次同步阶段 14 时多文件 patch hunk 格式错误；改为两个独立 patch 后成功，不涉及产品代码。
- 最终结论：新增 8 个 P1 与 3 个 P2。`npm test`、`npm run verify`、完整模块导入、语法检查、diff 检查和 npm pack dry-run 均通过；PTY 仍因安全 fixture 缺失未运行。P1 关闭前不建议继续发布。
