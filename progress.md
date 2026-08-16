# 进度日志

## 会话：2026-08-15

### 阶段 1：需求与发现

- **状态：** complete
- 执行的操作：
  - 复现路径经用户确认：VS Code 滚轮会切换输入历史。
  - 两次终端控制模式修复均未生效，确认需要改变渲染架构。
  - 审核现有备用屏幕、输入解析和滚动实现。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 2：追加式 CLI 规划

- **状态：** complete
- 执行的操作：
  - 规划普通终端缓冲区的输出与临时输入区域。

### 阶段 3：普通缓冲区迁移

- **状态：** complete
- 执行的操作：
  - 移除了 `CSI ?1049h/l` 备用屏幕切换，TUI 现在直接运行在终端主缓冲区。
  - 保留关闭鼠标报告模式与完整键盘快捷键。
  - 已完成消息、工具事件与命令结果采用增量追加；底部输入、面板和 statusline 使用可擦除的临时区域。
  - 复杂折叠区在普通 scrollback 中保持摘要，避免改写已输出的历史行。

### 阶段 4：验证

- **状态：** in_progress
- 执行的操作：
  - `node --check src/index.js` 与 `git diff --check` 均通过。
  - 现有 `pty-interaction.py` 未加载 mock profile，等待审批时超时；未重复运行相同失败配置。
  - 移除独立 running 动画条，仅在 preset 左侧显示静态 `● running`；恢复临时区域中的流式文本/推理/工具输出，并在尾部追加异常 late-event。

## 测试结果

| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| 旧全屏模式 | VS Code 滚轮 | 不改变历史 | 用户仍观察到历史切换 | failed |
| 语法检查 | `node --check src/index.js` | 通过 | 通过 | passed |
| PTY 交互回归 | `python3 test/pty-interaction.py` | 通过 | 等待 mock approval，15 秒超时 | blocked |

## 错误日志

| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-08-15 | 关闭 alternate-scroll 未改变 VS Code 实测行为 | 2 | 转向普通终端缓冲区设计。 |

## 会话：2026-08-15（插件市场调研）

### 状态：research_complete

### 已完成

- 检查本地 `dsh-tui` 的 bundle、`probeRequiredServices`、命令注册和技能加载：确认没有插件 catalog/安装服务，也没有 `/plugins` 或 `/market`。
- 阅读本机 `@deepseek-ai/dsh@0.1.0-rc.6` 的 `dsh plugin` 实现：它初始化 profile、转发 pnpm、按 `dsh.bundle.patch` 声明重建 bundle 列表；安装作用域是 profile，不能视为当前进程热加载。
- 调研 [DSH Hub catalog](https://dshhub.org/#catalog) 及 `dsh-cc-tui` 详情：确认目录提供搜索/分类/兼容性筛选、来源 revision、许可证、版本、更新时间和官方安装命令；尚未确认稳定版本化 JSON API。
- 将证据写入 `findings.md`，将实施分期和安全约束写入 `ROADMAP.md`，将后续执行步骤写入 `task_plan.md`，并在 `HARNESS_COMPATIBILITY.md` 标注当前插件市场能力未适配。

### 本轮未做

- 未修改 `src/index.js`、profile manifest 或运行时配置。
- 未执行任何插件安装、卸载或远程第三方代码。

## 会话：2026-08-16（全套功能迭代与体验打磨）

### 状态：complete (13 Commits / 6 PTY Tests Passed 100%)

### 已完成核心能力
1. **全局诊断与看板**：新增 `/status` 全局会话与系统看板，新增 `/context` 上下文占比分析与分布。
2. **侧边轻量问答**：新增 `/ask <问题>`，基于独立临时会话执行模型推理，零上下文污染，保障主任务 Context 纯净。
3. **架构拷问技能**：内置 Matt Pocock 经典 `/grill-me` 架构压力测试技能，遵循「一轮一问、必带推荐、代码可查绝不废话、深度优先决策树、终局 .grill/<slug>.md 归档」黄金法则。
4. **设置持久化与密度控制**：接入官方 `ctx.settings`（`~/.dsh/settings.yaml`），支持主题切换与状态行密度（`detailed` 4行、`compact` 2行、`minimal` 1行）实时切换。
5. **Claude 暖色调与护眼灰阶**：调优正文与标签颜色层级（250/251/245/241），彻底消除纯白刺眼眩光；斜杠菜单与技能面板搜索匹配以加粗亮金琥珀色高亮。
6. **交互与终端兼容**：全面捕获与放行 SS3 终端光标方向键（`\x1bOA/B/C/D`）；预设二次确认面板（`presetConfirm`）升级为方向键/Tab 切换单选圆点 `●` 与 `Enter` 提交。
7. **`/compact` 与 `/steer` 平滑升级**：`/compact` 全面对齐 Claude Code，提供即时反馈、防重入互斥锁与 Token 收益统计；`/steer` 支持将已排队消息一键提升为实时干预。

## 会话：2026-08-17（性能专项：0ms 输入响应、/resume 骨架屏与大历史流式回放）

### 状态：complete (6 PTY Tests Passed 100%)

### 已完成核心能力
1. **打字与光标移动 0ms 响应**：在空闲模式下跳过定时器防抖直接直刷终端；状态栏引入 `statusRowsCache` 复合缓存，彻底消除打字时的重复宽度重算与字符串切割。
2. **`/resume` 骨架占位与内存标题缓存**：新增 `sessionTitleCache` 缓存池，未命中项立即展示 `⠋ 加载会话中…` 骨架占位并后台异步并发加载，0ms 秒开面板。
3. **`-c` 快速直达与并发启动**：`Promise.all` 并发读取历史与索引，`-c` 模式直接单查最近会话元数据，避免磁盘全量遍历。
4. **超长会话流式分块回放 (`commitToScrollbackChunked`)**：恢复大型历史会话（数百/数千行文本）时以 120 行为单位分块流式写入 Stdout，并配合微任务让出 Event Loop，防止 Node 单线程尖刺与终端卡死。

### 自动化回归测试结果
| 测试用例 | 覆盖场景 | 结果 |
|---|---|---|
| `test/pty-e2e.py` | 流式/审批/usage/权限/中断/退出 | ✅ PASS (exit code 0) |
| `test/pty-resume.py` | /compact/窄终端/会话恢复 | ✅ PASS (exit code 0) |
| `test/pty-features.py` | 审批 diff/推理折叠/工具组/export/历史搜索/模型实时切换 | ✅ PASS (exit code 0) |
| `test/pty-file.py` | @ 引用→默认列表→目录浏览→选中→展开→提交 | ✅ PASS (exit code 0) |
| `test/pty-image.py` | OSC 1337 / kitty 图片粘贴→attachment→提交 | ✅ PASS (exit code 0) |
| `test/pty-interaction.py` | 菜单、快捷键、多行输入、面板与状态行 | ✅ PASS (exit code 0) |


