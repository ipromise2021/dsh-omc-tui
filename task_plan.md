# 任务计划：关闭 2026-08-25 代码审查问题

## 目标
完成 `v0.2.7` 的版本固化、验证、Git/npm/GitHub 发布，并保留历史审查与 rc.2 兼容验证记录。

## 当前阶段
阶段 26（DSH v0.1.2-rc.1 上游兼容适配，进行中）

## 各阶段

### 阶段 1：确认审查基线
- [x] 记录全部审查意见、影响和代码位置
- [x] 记录当前测试与工作区状态
- [x] 确认修复优先级和实现顺序
- **状态：** complete

### 阶段 2：修复高优先级问题
- [x] 权限切换只在 Harness 官方 API 成功后更新投影
- [x] 活跃远程任务无法取消时阻止普通退出并显示原因
- [x] 为以上路径补充失败场景回归测试
- **状态：** complete

### 阶段 3：修复中优先级问题
- [x] 修复 Windows 下 SIGTERM 后无法升级 SIGKILL 的判断
- [x] 按原始字节/文本块边界拼接 Jobs 增量输出
- [x] 修正 Browser 保留与安全重连策略的 CHANGELOG 描述
- [x] 为进程清理和输出拼接补充回归测试
- **状态：** complete

### 阶段 4：验证
- [x] 运行 `npm test`
- [x] 运行 `npm run verify`
- [x] 运行 `git diff --check`
- [x] 运行 npm 打包预检
- [ ] 在具备 Harness fixture 时运行 PTY 集成测试
- **状态：** complete

### 阶段 5：交付
- [x] 修复 CR-006：回归测试不得向真实操作系统 PID/进程组发送信号
- [x] 完成 CR-007：resize 保留 footer 缩窄补偿并由真实 `onResize` 回归测试覆盖
- [x] 修复 CR-008：Option+左右使用 Unicode-aware 词边界且首尾不循环
- [x] 加强 CR-001 成功路径断言并使用正确的 `permission/preset` 事件
- [x] 复审修复差异，无新增阻断问题
- [x] 更新 `findings.md` 和 `progress.md` 记录本轮复审
- [x] 准备提交
- **状态：** complete

### 阶段 6：Shell 补全与历史边界整改
- [x] 将系统 Shell 历史改为显式启用，关闭历史时不读取任何系统历史文件
- [x] 仅选择当前 Shell 的单一历史文件，并限定读取范围
- [x] 为隐私开关、历史源选择和解析行为补齐回归测试
- [x] 完成提交前验证
- **状态：** complete

### 阶段 7：窗口 resize 全量重放整改
- [x] resize 后清屏并按新终端宽度格式化、重放当前会话
- [x] 保留普通运行时的增量输出，避免每回合全量重绘
- [x] 补充 resize 全量重放的回归测试
- [x] 完成提交前验证
- **状态：** complete

### 阶段 8：主分支界面渲染与输出折叠方案分析
- [x] 分析 resize、全量历史重排、scrollback 截断的现有调用链与状态边界
- [x] 分析流式输出、工具子树聚合、默认折叠和 Ctrl+O 展开的现有实现
- [x] 给出不修改产品代码的分阶段优化方案、测试矩阵与风险边界
- [x] 将结论写入独立分析文档并复核代码位置
- **状态：** complete

### 阶段 9：document + viewport 界面优化实施
- [x] 建立纯 transcript projection 与应用内 viewport，替代原生 scrollback 全量回放
- [x] 使用 alternate screen 差分渲染，resize 后按源文本锚点保留阅读位置
- [x] 聚合 text/reasoning/tool-call 流式 delta，并支持 activity 定向折叠
- [x] 接入统一输入路由、滚轮隔离和鼠标内容选择/复制
- [x] 覆盖 CJK、Markdown、表格、省略号截断和 resize 的选择回归
- [x] 完成单元、模块、diff 与打包预检验证
- **状态：** complete

### 阶段 10：发布前完整审查整改
- [x] 修复权限与计划模式写入失败时的错误投影
- [x] 修复会话预设切换的半初始化状态与退出清理
- [x] 修复多击选择状态与补全目录越界枚举
- [x] 补齐针对性回归测试并完成发布前验证
- **状态：** complete

### 阶段 11：会话切换原子性复审
- [x] 复核当前差异、单元/模块/打包验证
- [x] 将 `/preset` 和 `/resume` 的完整初始化移至会话提交点之前，或在失败时恢复旧投影
- [x] 为提交点之后的失败路径补充回归测试
- **状态：** complete

### 阶段 12：会话切换提交后失败复审
- [x] 复核当前差异和已有失败注入测试的真实覆盖边界
- [x] 修复 `/resume` 提交后投影失败造成的混合状态
- [x] 将权限/Plan 当前状态读取纳入错误边界
- [x] 补充真正的提交后失败回归测试并重新验证
- **状态：** complete

### 阶段 13：会话切换与资源生命周期复审
- [x] 复核最新差异、完整单元测试、模块导入、diff 与打包清单
- [x] 检查候选会话提交点之后的异步操作和失败边界
- [x] 检查 `/resume` 的 session-scoped 投影重置完整性
- [x] 检查 request/skill override 的订阅与释放生命周期
- [x] 修复 CR-019～CR-021 并补齐失败注入测试
- **状态：** complete

### 阶段 14：v0.2.2 发布后全项目代码审查
- [x] 核对 Git/标签/发布元数据、安装说明与 npm 包清单
- [x] 审查 Harness 服务接入、会话切换、权限、Jobs、Browser 与资源释放
- [x] 审查 transcript/viewport/screen、流式输出、输入、鼠标选择与 resize
- [x] 审查危险命令守卫、跨平台与异常输入边界
- [x] 运行单元、模块和打包验证；确认 PTY 因 fixture 缺失而不可运行并汇总结论
- **状态：** complete

### 阶段 15：DSH v0.1.2-alpha.1 兼容性评估与文档计划
- [x] 核对官方发布说明及现有 rc.1 peer 依赖基线
- [x] 完成图片 Files API / 自动预处理的代码契约比对
- [x] 将风险分级、验证矩阵与升级顺序加入 README
- [x] 复核 README 链接与变更范围
- **状态：** complete

### 阶段 16：未提交代码审查与大段粘贴折叠整改
- [x] 审查 `/clear` 新会话生命周期、状态重置和命令返回值
- [x] 修复 CR-060：`submit()` 使用回调 replacement 防止 `$` 篡改，预校验后再展开且不对展开后文本应用通用正则，允许合法日志文本，增加回归用例
- [x] 修复 CR-061：将占位符作为不可分割编辑单元，支持原子跨越与删除，提交成功前不清空映射；`Ctrl+L` 独立为 `clearScreen()` 刷新清屏保留上下文
- [x] 运行单元与模块验证，测试全量通过
- **状态：** complete

### 阶段 17：DSH v0.1.1-rc.2 隔离环境适配验证
- [ ] 创建隔离的 rc.2 DSH Home 并安装当前本地插件
- [ ] 验证启动、模块导入、Profile 与会话创建契约
- [ ] 验证图片附件与视觉 Sidecar 的关键 API 路径
- [ ] 根据验证结果更新 peer 依赖与发布元数据
- **状态：** in_progress

### 阶段 18：v0.2.7 发布
- [x] 确认 Git、npm 与 GitHub Release 发布前状态
- [x] 更新 package 版本和 CHANGELOG 发布条目
- [x] 运行完整测试、模块验证、diff 检查与 npm 打包预检
- [x] 创建 release commit 与 `v0.2.7` 标签并推送
- [x] 发布 npm 包并创建 GitHub Release
- **状态：** complete

### 阶段 19：v0.2.8 发布
- [x] 完成 reasoning effort 持久化、能力校验和失败状态一致性修复
- [x] 更新 README、兼容性契约与变更日志，确认官方 npm DSH 基线
- [x] 运行发布前测试、模块验证、空白检查与 npm 打包预检
- [x] 创建 release commit、标签并推送
- [x] 发布 npm 包并创建 GitHub Release
- **状态：** complete

### 阶段 20：Jobs 与后台 Shell 体验改造
- [x] 确认 Jobs 是后台 Shell 的唯一管理入口，状态栏仅作汇总
- [x] 将 Jobs 列表改为任务动态视图，区分活跃、待处理和最近任务
- [x] 为 bash Job 增加 Shell 详情视图（状态、耗时、命令、实时输出）
- [x] 从状态栏的活跃 Jobs 摘要快速打开任务列表
- [x] 补充渲染与键盘交互回归测试
- [x] 运行完整验证
- **状态：** complete

### 阶段 21：Jobs/Shell 审查整改
- [x] 复核审查问题与真实输入路由
- [x] 修复 Shell 日志分页、格式保真和详情页选择状态
- [x] 为打开的远程 Shell 详情持续读取官方 Jobs 增量输出
- [x] 将 Jobs 列表与 durable-event 任务活动分离投影，避免名称误导
- [x] 补充端到端输入路由与输出更新回归测试
- [x] 运行完整验证
- **状态：** complete

### 阶段 22：Jobs/Shell 消费游标与日志整改
- [x] 限制自动输出读取到插件自身启动的后台 Shell，避免消费远程 DSH Job 游标
- [x] 在本地 Shell 完成事件后读取最终增量，保留日志跟随
- [x] 保留后台刷新期间的既有日志，并修复尾部换行占用显示额度
- [x] 限制任务活动投影到最近事件窗口，并在活动边界开始重建
- [x] 补充远程 Job 不自动读取、终态读取、日志尾部和刷新回归测试
- [x] 运行完整验证
- **状态：** complete

### 阶段 23：Jobs/Shell 审查回归整改
- [x] 恢复远程非 Shell Job 的显式 Enter 读取入口
- [x] 在会话提交时清理 Jobs 面板、TUI Shell 身份和日志缓存
- [x] 将任务活动投影限制为固定窗口，并向用户标示历史省略
- [x] 补充远程读取、会话隔离和活动窗口回归测试
- [x] 运行完整验证
- **状态：** complete

### 阶段 24：Jobs 输出读取审查整改
- [x] 终态非 Shell Job 重复读取时以最终输出覆盖缓存，避免重复拼接
- [x] 输出读取失败时保留当前可见日志，仅显示错误提示
- [x] 统一列表与 Shell 详情的尾部换行处理，避免空行占用日志额度
- [x] 补充回归测试并运行完整验证
- **状态：** complete

### 阶段 25：Jobs/Shell 竞态与跨平台日志整改
- [x] 切换任务时使在途输出读取失效，避免旧日志写入新选择
- [x] 验证 CRLF 已由安全文本层处理，并统一 Tab 的固定宽度显示
- [x] 修复 64KB 缓存截断后暂停态的新日志计数
- [x] 读取中或失败时继续展示已有列表日志
- [x] 修复本地 Shell 滑动缓冲与绝对读取游标，避免 32KB 后停止输出
- [x] 避免 DSH 管理的 Shell 同时经本地推送与 Jobs 读取重复写入缓存
- [x] 本地回退 Shell 使用推送更新，不让轮询破坏暂停跟随状态
- [x] 远程取消保留任务日志，并隔离切换任务后的异步结果
- [x] 让 Jobs 列表严格遵守可用行数，修复零活动预算反而显示全部活动
- [x] 后台本地 Shell 取消复用 SIGTERM→SIGKILL 升级机制
- [x] 规范化日志 Tab 显示，并保持取消后的列表排序和选择
- [x] 补充针对性回归测试并运行完整验证
- **状态：** complete

### 阶段 26：DSH v0.1.2-rc.1 上游兼容适配
- [x] 核对官方 release、标签与 `v0.1.1-rc.2...v0.1.2-rc.1` 代码差异
- [x] 建立本地 TUI 对 Harness API、durable events、配置与 Jobs 的调用映射
- [x] 识别已修复问题、新能力、破坏性风险与可利用优化
- [x] 以回归测试驱动完成必要的最小兼容改造
- [x] 运行单元、模块导入、空白及可用的集成验证
- [x] 新建独立中文适配报告，记录来源、结论、改动和后续验证矩阵
- **状态：** complete

### 阶段 27：DSH v0.1.2-rc.1 完整兼容验证
- [x] 审计可用的隔离 fixture、真实 Provider 与凭据边界，不输出任何密钥
- [x] 执行现有 PTY、恢复、preset、权限、Jobs 和命令验证
- [ ] 在独立临时工作区执行最小真实 Provider、工具、图片和 compact 验证（如凭据可用）
- [x] 对失败项区分环境限制、上游缺陷与 TUI 缺陷；修复必要的 TUI 问题并回归
- [x] 更新适配报告、验证矩阵和发布状态
- **状态：** in_progress

发布预检已完成；真实 Provider 与 Windows 平台验证仍为明确记录的外部扩展项，不阻塞 rc.1 mock Profile 发布门禁。

当前门禁结论：核心 rc.1 主链路与新增投影修复已验证；整套 PTY 因 interaction timing 旧文案和 preset/resume 标记两项尚未全绿，保持 `in_progress`，不移动现有 `v0.2.9` 标签。

## 建议实现顺序
1. CR-001 权限状态投影
2. CR-002 无取消能力时的退出保护
3. CR-003 Windows 进程终止升级
4. CR-004 Jobs 输出原样拼接
5. CR-005 Browser 生命周期文档
6. CR-006 测试隔离与进程信号安全
7. CR-007 turn/end 增量收尾与 footer 重绘

## 已做决策
| 决策 | 理由 |
|------|------|
| Harness durable event 和官方服务是权限、Jobs 状态的唯一真相源 | 遵守项目架构契约，避免 TUI 伪造状态 |
| 普通交互退出必须确认任务取消成功 | 退出面板已向用户承诺停止所有活跃任务 |
| 宿主强制卸载仍采用 best-effort 清理 | 避免插件卸载被单个任务取消失败永久阻塞 |
| 专用 Chrome 默认保留并允许后续安全重连 | 与用户确认的登录和浏览器使用策略一致 |
| 本轮以 `main` 作为用户所称的 `master` 主分支 | 仓库不存在 `master`，`main` 与 `origin/main` 对齐 |
| 完整历史重排与原位折叠采用 document + viewport | 普通终端 scrollback 无法保证容量、阅读锚点或任意旧行原位改写 |
| 工具活动闭合前只更新 live block，闭合后默认折叠 | 防止逐节点内容先写入不可变 scrollback，避免结束时依赖全量重绘收回 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| `npm pack --dry-run` 因 `~/.npm/_cacache` 存在 root-owned 文件返回 `EPERM` | 1 | 不修改全局缓存权限；改用 `/private/tmp/dsh-omc-tui-npm-cache-v027` 隔离 cache 重试 |
| `npm whoami` 返回 `ENEEDAUTH` | 1 | 默认 registry 指向 npmmirror，而 token 绑定 npmjs；发布命令显式使用 `https://registry.npmjs.org/`，官方身份验证成功 |
| PTY 测试缺少 `DSH_HOME` 或 `DSH_TEST_FIXTURE_HOME` | 1 | 记录为环境阻塞；准备 Harness fixture 后补跑 |
| 首次同步阶段 14 记录时补丁上下文格式错误 | 1 | 拆分为标准多文件 patch 后成功写入 |
| 第二次同步阶段 14 记录时多文件 patch hunk 格式错误 | 1 | 分为两个独立 apply_patch 调用后写入 |
| 第三次同步阶段 14 记录时多文件 patch hunk 格式错误 | 1 | 后续固定使用单文件独立 patch |
| 阶段 25 首次测试仍按旧的 7 行列表输出预算断言 `log 1` | 1 | 按新容量契约更新为 5 行预算，验证首行 `log 3` 且末行 `log 7` |
| 阶段 25 取消排序测试桩缺少 `orderJobEntries` | 1 | 为测试对象绑定真实实例方法后重跑 |
| 临时 partial clone 未包含目标 tag，读取对象时触发受限网络失败 | 1 | 显式 fetch rc.2、rc.1 与 `origin/master` 后再比较，不重复依赖 lazy fetch |
| zsh 循环变量 `path` 覆盖特殊数组 `$path`，导致 `rg` 不可见 | 1 | 改用非保留变量名 `pkg_dir`；后续避免 shell 特殊变量名 |
| partial clone 补取 rc.2 blob 时 GitHub TLS 中断 | 2 | 不再重复 Git promisor fetch；切换 GitHub Contents API |
| `gh api -f ref=...` 默认变为 POST，Contents API 返回 404 | 1 | 改用带查询参数的 GET URL |
| 新增 session 适配层的首个多文件 patch 假定 `src/core/index.js` 导出 danger-guard | 1 | 读取实际文件后收窄上下文，只追加现有导出 |
| 首轮单测在 preset 切换断言失败：`commitSessionState` 参数 `sessionEvents` 遮蔽同名 helper | 1 | 保持外部对象键不变，在解构时别名为 `restoredEvents` |
| rc.1 Profile 首次真实启动时 standard preset 缺少 `subagentModelSelection` Host 服务 | 1 | 按官方 Web host 组合方式挂载 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`，并增加对应 peer |
| package + Cordis patch 的首次联合补丁未匹配删除行 | 1 | 分文件应用精确补丁并复核实际上下文 |
| 最终补取 GitHub Release body 时网络连接临时失败 | 1 | 不重试受限网络；使用本轮已保存的官方 Release/API、tag 与源码核对结果完成文档 |
| rc.1 mock Profile 的首组 PTY e2e 场景失败 | 1 | 先读取 `/tmp/dsh-tui-pty.log`，区分 fixture、rc.1 API 与 TUI 行为后采用针对性修复或更新 fixture |
| 补齐 mock adapter 后首组 PTY e2e 仍失败 | 2 | 读取最新日志，检查 rc.1 stream event 协议和 TUI/fixture 的工具请求路径；不重复使用旧假设 |
| 增加 rc.1 启动稳定窗口后首组 PTY e2e 仍失败 | 3 | 停止继续猜测；读取日志并重新审视 rc.1 与测试断言的 UI 语义差异，必要时只修复测试 fixture/断言并向用户报告未覆盖范围 |

## 备注
- 每完成一项修复，同步更新 `findings.md` 的状态与验证证据。
- 不在修复过程中顺手重构无关代码。
