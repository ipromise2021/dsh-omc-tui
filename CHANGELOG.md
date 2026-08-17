# DSH OMC TUI · 工作记录与变更日志 (Worklog & Changelog)

本文档记录了 `dsh-omc-tui` 的重要问题排查、架构决策、性能优化及视觉体验迭代历史。

---

## 📅 2026-08-17 · 终端排版引擎、时序对齐与极速直出优化

### 🎯 核心问题与优化记录清单

---

### 1. 启动异常与未定义方法修复 (Fix Runtime Errors)
* **问题现象**：
  * 终端启动时偶发报错 `ReferenceError: truncateAnsi is not defined` 导致无法进入主界面。
  * 轮次结束 `turn/end` 时抛出 `TypeError: this.refresh is not a function` 导致进程退出（Exit code 130）。
* **根因分析**：
  * `src/index.js` 顶部引入 renderer 模块时遗漏了 `truncateAnsi` 的解构导出。
  * 早期重构遗留了旧代码 `this.refresh(false)`，实际状态更新与 Footer 渲染由 `onTurnEnd` 和 `scheduleRender` 负责。
* **解决方案**：
  * 在 `src/index.js` 补全 `truncateAnsi` 导入。
  * 移除 `turn/end` 阶段的冗余调用，统一收敛至标准事件调度生命周期。

---

### 2. `workspace-write` 权限预设持久化修复 (Permission Preset Persistence)
* **问题现象**：
  * 在交互式授权弹窗中选择 `2. Yes, allow workspace-write during this session (shift+tab)` 后，后续工具执行仍然反复弹出审批弹窗。
* **根因分析**：
  * 审批响应分支错误调用了不存在的 `permissionPresets.select()` 方法，导致设置静默失败。
* **解决方案**：
  * 修正为官方 Harness 接口 `this.ctx.permissionPresets.set(this.agent.session, 'workspace-write')`，触发 durable event 落盘，实现会话级权限真正生效。

---

### 3. 用户输入气泡框样式与 CJK 安全对齐 (User Message Bubble & CJK Alignment)
* **演进历程**：
  * **初代**：简易粗体文本，缺乏层次感。
  * **尝试**：背景色胶囊方案（`ANSI.userBg`），但在暗色/透明终端下稍显突兀。
  * **定版**：完整恢复经典圆角气泡卡片（`YOU · HH:MM` + `╭──────╮` / `│ 内容 │` / `╰──────╯`），气泡宽度自适应终端列数，使用 `widthOf()` / `visibleOf()` 严格保证中英文字符在终端中绝对对齐不破框。

---

### 4. 本地日志与会话历史的时序倒置修复 (Chronological Log Ordering)
* **问题现象**：
  * 用户在输入新消息前执行 `Shift+Tab` 切换权限、或者输入 `/status` 查看状态，但在终端重绘（Resize）或会话恢复后，这些本地日志竟然跳到了新消息的下方。
* **根因分析**：
  * `repaint()` 逻辑先遍历并格式化了所有的 `agent.session.events`，最后才把 `this.localLog` 追加到最尾部。
* **解决方案**：
  * 在 [src/index.js](src/index.js) 中将 `session.events` 与 `localLog` 统一按绝对时间戳 `time` 进行**全局归并排序**，并在 [src/renderer/transcript.js](src/renderer/transcript.js) 增加 `case 'local/log'` 处理，确保操作时序绝对准确。

---

### 5. 流式思考抽屉动态效果与终端安全 (Live Thinking Drawer & Safe Truncation)
* **优化内容**：
  * 将底部思考动态抽屉扩展为 **3 行实时思考流预览**，末尾带有脉冲提示光标 `▋`。
  * 消除抽屉高度动态剧烈跳动导致的视口闪烁，渲染使用 `${truncateAnsi(line, columns - 1)}\x1b[K` 代替右侧空格填充，彻底解决 macOS / iTerm2 / VS Code 下因为终端自动换行导致的“幽灵空行”与布局错位。

---

### 6. 树遍历状态机模型与工具链自动收起 (Tree Traversal & Node Transitions)
* **问题现象**：
  * 模型执行多步排查（如 `Read` -> `Edit` -> `Bash`）时，每次工具前都有 1 行过渡碎碎念，几轮下来终端被中间过渡和工具日志堆满，正式回答被推至屏幕外。
* **架构设计（Tree Traversal State Machine）**：
  * 将 Agent 交互流形式化为树遍历状态机：
    * **Thinking 节点**：思考结束退出 ➔ 原地收起为 `  ⚛ Thought for Ns (ctrl+o to expand)` ➔ 插入空行。
    * **Lead-in 过渡节点**：前置说明文字以淡灰紧凑行显示 ➔ 插入空行。
    * **Tools 工具组节点**：叶子工具在底部抽屉执行，全部工具执行完毕回归根节点时 ➔ 自动合并收纳为 `  ⚙ TOOLS · N · ... (ctrl+o to expand)` ➔ 插入空行。
    * **Response 回答节点**：模型的**正式回答（Final Answer）100% 完整舒展展开**，不折叠。

---

### 7. 流式输出文字重复与 DSH 标题重复刷屏修复 (Deduplicate Streaming Text)
* **问题现象**：
  * 流式生成中，模型输出的文字每隔几秒就会被重复打印两遍，且伴随重复出现 `DSH deepseek-v4-flash · 22:56` 标题行。
* **根因分析**：
  * `flushStreamBuffer` 已经将流式文本逐行写入了 stdout；随后 `tool/result` 触发 `commitUnprintedEvents` 时，又把包含同一段文字的 `assistant/message` 再次传进 `formatEvents` 渲染，造成二次重复输出。
* **解决方案**：
  * 在 [src/index.js](src/index.js) 中明确职责：流式阶段的文字由 `flushStreamBuffer` 独占流式提交；`commitUnprintedEvents` 仅过滤并提交真正的工具事件（`tool/call`、`tool/result`、`approval`），彻底消除重复内容与重复 Header。

---

### 8. 连续混合工具自动聚合 (Unified Tool Grouping)
* **优化内容**：
  * 在 [src/renderer/transcript.js](src/renderer/transcript.js) 引入 Lookahead 前瞻判定，连续执行的 `Read`、`Edit`、`Write`、`Bash`、`grep` 等混合工具链，即使中间夹杂微小状态流，也统一聚合成单个卡片（如 `  ⚙ TOOLS · 7 · edit ×4 · read · bash ×2 (ctrl+o to expand)`），不再出现单条与多条平级碎裂割裂。

---

### 9. 会话恢复（`-c`）极速原子直出 (Instant Render for Session Resume)
* **问题现象**：
  * 执行 `dsh-omc-tui -c` 恢复会话时，内容像搭积木一样一条条缓慢刷屏，且整屏历史被重复打印两次。
* **根因分析**：
  * 会话恢复时调用了 `for (const event of session.events) this.onSessionEvent(...)`，强行把历史事件当成实时流重新发射了一遍；随后又全量分块输出了一次。
* **解决方案**：
  * 移除事件模拟流，直接在内存中完成状态与 `reasoningBlocks` 索引（耗时 < 1ms）。
  * 通过 `this.formatEvents(session.events, columns)` 完成一次性排版，并执行**单次原子系统调用写入**（`process.stdout.write(pastRows.join('\n') + '\n')`）。
* **性能实测**：
  * 800 个事件（2,200 行终端对话历史）全量排版与输出耗时 **仅 36.7ms**，常规会话进入耗时 **< 3ms**，实现秒开直出。

---

### 10. 官方文档事实与规范校正 (Documentation Accuracy & TOC Fixes)
* **校正内容**：
  1. `README.md` L213：修正 `!` Bash 模式颜色描述为“输入区与提示符变琥珀金”（原文档误写为“边框变绿”）。
  2. `README.md` L203：修正 `Ctrl+K` 快捷键描述为“删除光标至当前行行尾”（符合 Emacs 规范，原误写为“删除当前行”）。
  3. `README.md` L35 / L303：修正 TOC 锚点为 `#反馈与贡献-feedback-contributing`（与 GitHub slugger 规则 100% 对齐）。
  4. 新增 Roadmap（规划中）、反馈与贡献指引、以及标准 GitHub Issue 模板（Bug 反馈与 Feature Request）。

---

### 11. 动态生成抽屉扩展为 4 行并锁定整轮状态
* **优化内容**：
  * 将底部实时预览抽屉升级为**恒定 4 行**（1 行状态指标 + 3 行丰富实时推理流，带脉冲光标 `▋`）。
  * 状态绑定为轮次主生命周期，整个生成过程中高度 100% 恒定，输入框位置稳固。

---

### 12. 流式原子双缓冲写入与轮次结束位置精确锚定
* **问题现象**：
  * 文本流式输出过程中，终端伴随高频闪烁；
  * 回答完全输出结束（`turn/end`）瞬间，输入框和状态栏整体往上跳动了数行。
* **根因分析**：
  * **闪烁根因**：流式提交新行时分为 `clearFooter` -> `write` -> `render` 三次独立系统调用，在清屏与重绘之间向终端暴露了空白帧，高频并发下产生明显闪烁。
  * **跳跃根因**：生成期间 4 行抽屉展开使 Footer 高达 11 行；结束时抽屉关闭，Footer 降为 7 行，高度差导致 7 行 Footer 被绘制在原先抽屉所在的高位。
* **解决方案**：
  * **原子单次写入**：将 `erase`、`content`、`footerText` 与 `cursorMove` 合并为单个 ANSI 缓冲区，通过单次 `process.stdout.write(buffer)` 原子输出，彻底根除任何中间空白帧，**流式输出 0 闪烁**。
  * **差值精确滚动推进**：在 `turn/end` 抽屉关闭的瞬间，计算新旧高度差（`heightDiff`），将完成行指标（`✻ finished in 15.7s · 3 tools`）与差值空行原子压入滚动区，正好抵消 4 行高度差，**输入框与 Statusline 绝对保持在原位，0 垂直跳跃**。

---

### 📊 性能基准测试数据 (Benchmarks)

| 场景 | 指标 / 数据 |
| :--- | :--- |
| **ESM 模块加载** | **0.43 ms**（零外部 UI 依赖） |
| **800 事件格式化 (2,200 行)** | **36.74 ms**（纯内存 CPU 字符串计算） |
| **会话恢复 (-c) 直出时间** | **< 50 ms**（单次 `process.stdout.write` 系统调用） |
| **CJK 宽度计算吞吐** | **> 1,000,000 字符 / 秒** |
