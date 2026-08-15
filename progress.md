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

### 下一步（用户确认后）

1. 先实现只读 catalog adapter 和 mock 数据测试。
2. 再实现 TUI 市场列表/详情/已安装面板。
3. 最后通过官方 `dsh plugin` 做显式确认后的安装委托，并验证重启生效。
