# 任务计划：关闭 2026-08-25 代码审查问题

## 目标
修复本轮代码审查发现的权限投影、后台任务退出、跨平台进程清理、Jobs 输出拼接和 Browser 文档一致性问题，并通过提交前验证。

## 当前阶段
阶段 9（document + viewport 界面优化实施）

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
| PTY 测试缺少 `DSH_HOME` 或 `DSH_TEST_FIXTURE_HOME` | 1 | 记录为环境阻塞；准备 Harness fixture 后补跑 |

## 备注
- 每完成一项修复，同步更新 `findings.md` 的状态与验证证据。
- 不在修复过程中顺手重构无关代码。
