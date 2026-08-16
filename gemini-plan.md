# 性能与交互流畅度专项优化方案 (Performance & Latency Optimization)

针对用户反馈的四大痛点：
1. `dsh-tui` / `dsh-tui -c` 启动白屏与长时间等待
2. `/resume` 面板打开缓慢与会话标题加载卡顿
3. 恢复历史会话时的大量历史内容加载卡顿
4. 进入界面后输入打字和光标移动有延迟与粘滞感

本方案制定了 4 个渐进式优化阶段，并在所有异步加载/等待环节增加优雅的微状态加载指示。

---

## 阶段规划 (Phased Roadmap)

### 阶段一：输入打字 Fast-Path 与 状态行渲染缓存 (Phase 1)
- **目标**：彻底消除日常打字、光标移动时的 16ms 延迟与全量 Footer 字符串重复计算，实现 0 延迟即时输入响应。
- **改动点**：
  1. **Statusline Memoization**：将 `statusRows` 中静态部分（模型名、工作区路径、预设、Token 计量条、MCP/Skills 徽标）缓存起来，仅在 Token、模型、权限等数据实质变化时使缓存失效；
  2. **打字与光标移动 Fast-Path**：在没有弹出菜单/浮层时的普通打字与光标移动，支持即时同步渲染或极速刷新，跳过不必要的延时；
  3. **细粒度光标更新**：避免在单纯输入字符时光标乱跳或整行闪烁。

### 阶段二：`/resume` 面板 Title 内存缓存与视口懒加载 (Phase 2)
- **目标**：输入 `/resume` 瞬间秒级弹出面板，且滚动时光滑流畅，伴随动态加载占位。
- **改动点**：
  1. **Session Title LRU 缓存池**：建立内存 Map 缓存已解析的会话中文标题，二次打开秒级直出；
  2. **视口懒加载（Lazy Load on Visible Range）**：不再一次性对前 50 个 Session 发起 50 次磁盘 I/O，仅对当前屏幕可见的 6~8 条记录按需读取；
  3. **优雅加载态（Loading Skeleton）**：未读完标题的条目展示 `⠋ 加载会话中...` 微动画与 shortId，加载完成后平滑淡入中文标题。

### 阶段三：渐进式极速秒开启动与 `-c` MRU 快速命中 (Phase 3)
- **目标**：敲下回车 0 毫秒立即进入终端，呈现启动欢迎卡与加载指示，消除黑屏盲区；`-c` 秒级直达最新会话。
- **改动点**：
  1. **TTY 终端 0ms 提前开启**：在 `start()` 第一步立即启动终端并渲染欢迎卡骨架；
  2. **非阻塞并发挂载**：底座 loader、MCP、Skills 探查与 Session 创建并发执行，加载期间状态栏显示优雅的 `◌ 正在初始化环境...`；
  3. **`-c` 快速直读**：通过 `this.mru` 直接命中最新 Session ID，跳过全局文件遍历。

### 阶段四：历史会话流式分块回放与事件合并 (Phase 4)
- **目标**：恢复上百条消息的大型历史会话时，不再发生主线程冻结和卡死。
- **改动点**：
  1. **合并事件遍历**：将 `onSessionEvent`（状态重建）与 `formatEvents`（排版渲染）合并为单次遍历，减少 50% 内存分配；
  2. **流式 Chunked Commit**：采用分块（如每 40 行）流式写入 Stdout，保持终端事件循环随时响应。

---

## 逐文件修改计划 (Proposed Changes)

### 核心运行时组件 (`src/index.js`)

#### [MODIFY] [src/index.js](file:///Users/yy0812024/Documents/dsh-demo/dsh-tui/src/index.js)
- 添加 `statuslineCache` 缓存对象与脏标记机制 (`dirtyStatusline = true`)；
- 添加 `sessionTitleCache = new Map()` 标题缓存池；
- 优化 `scheduleRender()` 与 `insertText()` 的打字即时响应路径；
- 改造 `openPicker()` 与 `renderPicker()` 实现仅对可见区域发起标题异步查询与加载占位动画；
- 优化 `start()` 启动序列为渐进式分段挂载与 `-c` 快速直达；
- 重构 `resumeSelected()` 的历史回放为单次遍历与流式分块输出。

### 自动化测试套件 (`test/`)

#### [MODIFY] [test/pty-interaction.py](file:///Users/yy0812024/Documents/dsh-demo/dsh-tui/test/pty-interaction.py)
#### [MODIFY] [test/pty-resume.py](file:///Users/yy0812024/Documents/dsh-demo/dsh-tui/test/pty-resume.py)
- 验证所有自动化交互、`/resume` 恢复、提问面板及流式输出在性能优化后 100% 保持行为与渲染一致。

---

## 验证计划 (Verification Plan)

### 自动化测试 (Automated Tests)
依次执行全部 6 套 PTY 仿真回归测试：
```bash
python3 test/pty-e2e.py /tmp/test-e2e.log && \
python3 test/pty-resume.py /tmp/test-resume.log && \
python3 test/pty-features.py /tmp/test-features.log && \
python3 test/pty-file.py /tmp/test-file.log && \
python3 test/pty-image.py /tmp/test-image.log && \
python3 test/pty-interaction.py /tmp/test-interaction.log
```

### 性能体感验证 (Latency & Response Benchmarks)
- 测试高频输入（100 字符连续打字）事件循环延迟与 CPU 占用；
- 测试 `dsh-tui` 与 `dsh-tui -c` 从执行到画面渲染的启动时延（目标 < 200ms 首帧）；
- 测试 `/resume` 列表弹出耗时（目标 < 50ms 首帧出列表）及中文标题平滑补全；
- 验证所有加载等待阶段的动态加载指示效果。
