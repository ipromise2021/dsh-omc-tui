# DSH v0.1.2-rc.1 上游调研与 TUI 适配报告

> 调研与验证日期：2026-09-03
>
> TUI 发布版本：`dsh-omc-tui@0.2.9`（调研起点 `06df472`）
>
> 发布基线：`dsh-v0.1.2-rc.1` / `a66e4702047846cdaa10c66c9d3df3951f5ea70d`

## 1. 结论

`dsh-omc-tui` 可以适配 DSH `v0.1.2-rc.1`，但不是只提升依赖版本即可。rc.1 有两项会直接破坏现有 TUI 的 API 变化，以及一项只有真实 Profile 启动才能发现的 Host 服务依赖：

1. `Session.events` 已移除，改为 `snapshotEvents()`、`eventAt()` 和 `seq`；
2. `permissionPresets.current(events)` 改为 `current(session)`；
3. rc.1 自带 preset 会启用 subagent 模型选择策略，TUI Host 必须挂载 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`。

上述问题均已完成最小适配，并通过真实 rc.1 隔离 Profile 的启动、`/status` 和三档权限轮换验证。Agent、Jobs、附件、命令、模型能力和 reasoning effort 的现有调用签名仍兼容。

本次不复制 Web UI 的布局或交互实现，也不追随 rc.1 标签之后尚未发布的 `master` 内部接口；Harness 继续作为会话、权限、模型、preset、Jobs 和持久化状态的唯一真相源。

## 2. 调研范围与来源

- [官方 v0.1.2-rc.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)
- [v0.1.1-rc.2...v0.1.2-rc.1 官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-rc.1)
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [`@deepseek-ai/dsh` npm 版本列表](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)
- rc.2、rc.1 tag 源码，以及调研时的 `origin/master`
- 本项目 Harness 调用面、Cordis patch、单元测试与真实隔离 Profile

版本事实：

| 项目 | 调研结果 |
| --- | --- |
| GitHub Release | `dsh-v0.1.2-rc.1`，prerelease，2026-09-03 发布 |
| Release commit | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |
| npm dist-tag | `next=0.1.2-rc.1`；`latest=0.1.1-rc.2`；`alpha=0.1.2-alpha.5` |
| rc.2 → rc.1 | Git 比较包含 1735 个提交，属于大规模升级而非小补丁 |
| 调研时最新 master | `76fda729799fe9b3848dbe2c211d4b231032b81e`，拓扑上位于 rc.1 之后 99 个提交 |

因此本文将“当前已发布的 rc.1”与“仓库最新 master”分开处理。插件的可安装兼容基线是 rc.1，不声明兼容尚未发布的 master。

## 3. rc.1 发布内容梳理

### 3.1 与终端 TUI 直接相关

| 上游变化 | 影响判断 | TUI 处理 |
| --- | --- | --- |
| Session 改为 `seq`、`eventAt()`、`snapshotEvents()` 按需读取 | 高，旧 `.events` 读取会失败或静默变空 | 新增集中兼容薄层，所有生产读取点改用稳定快照 |
| 权限 preset 的 `current()` 改接收 Session | 高，旧调用传数组会失去正确投影 | 新版传 Session；兼容层保留旧签名回退 |
| Subagent 可选 provider/model/reasoning/max output，并以 `send_message` 双向通信 | 中，preset 和 Host 注入面变化 | 补挂官方 model-selection settings；删除已移除 report patch |
| 运行中输入可排队发送，图片与 follow-up 队列修复 | 中，TUI 已有 follow-up/steer 投影 | 保持使用 `agent.followup/steer` 官方 API，不自建 runtime 队列 |
| 图片后台压缩、上传与 compact token 统计 | 中，附件由 Harness 所有 | 保持 `validateImage/saveImages/readImage` 管道；不重复实现上游压缩器 |
| Preset 路径、健康检查和不可加载诊断修复 | 高，直接影响启动 | 用真实 standard preset 启动验收；Host 服务缺失已修复 |
| JSONL Session 日志尾部损坏可修复并提示 | 中，改善异常退出后的恢复 | TUI 不直接修改日志，继续走 `agents.resume/sessionQuery` |
| npm peer 依赖裁剪 | 中，安装组合发生变化 | 逐项核验 rc.1 包并更新 TUI peer；增加实际用到的 subagent 包 |
| Code Mode 更名为 PTC | 低，主要是命名和 runtime 组合 | patch 注释改用 PTC；继续挂载官方 worker-thread runtime |
| SQLite Session 持久化移除 | 低，TUI 未依赖 SQLite | 不增加替代存储，不访问底层 persistence 实现 |
| Headless stdout/stderr 分流、APIProxy 改 Remote | 无直接影响 | TUI 不依赖 Headless 文本协议或 Web Remote |

### 3.2 体验与性能优化

- 图片预处理转到后台并支持复用上传结果，降低发送前阻塞；图片也进入 compact 的上下文核算。
- Session 不再要求调用方拿到完整可变事件数组；`snapshotEvents()` 提供稳定、可缓存的只读快照，更适合长会话投影。
- 子代理模型选择、最大输出和双向消息能力更明确，减少 Host 与 preset 之间的隐式约定。
- preset 健康诊断、Profile 路径解析、会话日志尾部恢复和连接重试改善异常路径。
- Web 端增加进程/系统提示折叠、内容宽度调节、token/耗时 footer、全历史 turn 导航、排版与本地化优化。

最后一组属于 Web projection 的实现，不应原样移植到 ANSI TUI。TUI 已有 viewport、状态栏、折叠和 terminal scrollback 方案，只吸收共享 Runtime 契约。

### 3.3 相比上一基线 rc.2，已修复或改善的问题

| 既有问题类别 | rc.1 的上游处理 | 对本插件的意义 |
| --- | --- | --- |
| 大图片处理与发送前等待 | 后台压缩/上传、复用附件、补充 compact 统计 | 保留本地 2048px 防护，但最终附件生命周期交给 Harness |
| 子代理只能单向汇报、模型选择受限 | `send_message` 双向通信和独立模型参数 | 现有视觉 Sidecar API 仍可用；后续可单独评估迁移，不在本次扩大范围 |
| Profile/preset 路径或依赖损坏时诊断不足 | 路径与健康检查修复 | 真实启动成为版本升级的强制检查，而非只跑模块导入 |
| JSONL 尾部被中断写入后无法正常恢复 | 自动识别/修复尾部并警告 | `/resume` 继续由官方 durable log 恢复，不实现本地截断 |
| 长会话持有全量事件数组的耦合 | 按序号和范围提供事件快照 | TUI 集中读取快照，减少多处耦合旧 getter |
| 排队输入中的图片/follow-up 边界错误 | 上游修复队列及图片处理 | TUI 只投影官方 Agent 状态，不复制队列真相 |

## 4. 源码级兼容审计

### 4.1 已确认的破坏性变化

rc.2：

```js
session.events
permissionPresets.current(session.events)
```

rc.1：

```js
session.snapshotEvents()
session.eventAt(seq)
session.seq
permissionPresets.current(session)
```

原 TUI 约 30 个 `.session.events` 读取点覆盖初始化、恢复、投影、usage、权限、recap、compact、导出、Jobs 活动与 Browser lease。只修改一个入口不能解决问题，必须统一收口。

### 4.2 保持兼容的主要契约

- `agents.create()`、`agents.resume()`；
- `agent.followup()`、`agent.steer()`、`agent.cancel()`；
- `AgentOptions` 的 provider、model、reasoning effort 与 max tokens；
- Jobs 的 `list/read/kill/onJobsChanged`；
- 附件的 `validateImage/saveImages/saveImage/readImage`；
- 命令的 `list/find/execute(agent, line, images, signal)`；
- Session 查询、agent preset、默认模型选择和模型能力解析。

事件 payload 的 TUI 使用面保持兼容。`CallId` → `ToolCallId` 属于 TypeScript 类型命名变化，当前纯 JavaScript 代码无需迁移。

### 4.3 最新 master 的额外观察

rc.1 发布后，master 继续包含 HTTP proxy、模型发现、Python 单文件 runtime、Agent Team mailbox 排序/统一消息、图片结果卡片和 session-persistence handle seam 等变化。

当前 TUI 不直接访问 `sessionPersistence` service，也不使用 Web React 卡片或 Remote API，因此没有提前追随这些未发布接口。待下一官方 tag/npm 版本出现后，再按相同流程做源码和真实 Profile 验证。

## 5. 本次实现

### 5.1 Session/权限兼容层

新增 [`src/core/session-events.js`](src/core/session-events.js)：

- 优先调用 rc.1 `session.snapshotEvents()`；
- 仅在旧 Session 上回退 `.events`；
- 权限查询在 rc.1 传入 Session，在旧版本传入事件数组；
- 不缓存或复制 Harness 业务状态，返回值只用于当前投影。

生产代码中所有直接 `.session.events` 读取均已替换，覆盖：

- TUI 初始化、提交、恢复与切换；
- transcript、usage、工具结果与建议投影；
- `/status`、`/recap`、`/compact`、`/export`；
- 权限切换与审批；
- Jobs 活动和 Browser lease。

### 5.2 Profile/preset 适配

[`cordis.patch.yml`](cordis.patch.yml) 已：

- 挂载 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`；
- 删除 rc.1 已不存在的 `tool-subagent-report` patch 项；
- 将 Code Mode 注释更新为 PTC mode。

缺少第一项时，真实 rc.1 的 standard preset 会在启动时报错：`modelSelectionSettings requires ... in Host scope`。补挂后可进入完整 TUI。

### 5.3 依赖与测试

- 19 个 `@deepseek-ai/dsh-*` peer dependency 对齐 `^0.1.2-rc.1`；
- 新增 `@deepseek-ai/dsh-tool-subagent` peer；
- 新报告加入 npm `files` 白名单；
- 单元测试覆盖 rc.2 getter、rc.1 snapshot、两代权限参数和缺失服务边界。

这里选择明确以 rc.1 为安装基线，而不是声明未经完整端到端验证的双版本范围。rc.2 的读取回退仍保留，便于代码层兼容和升级诊断，但发布依赖不会承诺旧 Profile 组合。

## 6. 验证记录

真实验证使用全新的临时 npm prefix 和 `DSH_HOME`，未改动用户日常 Harness 配置。

| 验证项 | 结果 |
| --- | --- |
| `@deepseek-ai/dsh@0.1.2-rc.1` 隔离安装 | 通过，CLI 与核心组件均解析到 rc.1 |
| 本地插件添加到隔离 `tui` Profile | 通过 |
| `dsh --profile tui --dump-config` | 通过，model-selection service 存在且无旧 report patch 警告 |
| 真实 TTY 启动 standard preset | 通过，进入完整欢迎页和输入状态 |
| `/status` | 通过，显示新 Session 为 3 events |
| Shift+Tab 权限轮换 | 通过：workspace-write → danger-full-access → read-only → workspace-write |
| 空闲 `Ctrl+C` 与恢复提示 | 通过，退出码 0 |
| 新旧 Session/权限回归单测 | 通过 |
| `npm test` | 通过 |
| `npm run verify` | 通过 |
| `git diff --check` | 通过 |
| npm pack dry-run | 通过，报告文件进入包内容 |

## 7. 尚未宣称完成的验证

- 未使用真实 API Key 发起 Provider 对话，因此流式响应、真实工具循环和 token usage 仍需发布前 smoke test；
- PNG/JPEG、多图、超大图、附件复用、compact 后恢复仍需在 rc.1 Provider 环境做 E2E；
- Windows Terminal 下的 CJK、PowerShell、剪贴板和 PTY 信号仍需平台验证；
- rc.1 之后 master 的 session-persistence handle seam 不在本次兼容承诺中。

这些是扩展验证项，不影响本次已复现并修复的启动、Session 快照和权限契约问题。

## 8. 安装与升级

rc.1 当前位于 npm `next` 而非默认 `latest`，请显式指定版本：

```sh
npx --yes @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile tui add dsh-omc-tui
npx --yes @deepseek-ai/dsh@0.1.2-rc.1 --profile tui
```

本地开发建议使用隔离目录：

```sh
export DSH_HOME=/private/tmp/dsh-tui-rc1
npx --yes @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile tui add /absolute/path/to/dsh-omc-tui
npx --yes @deepseek-ai/dsh@0.1.2-rc.1 --profile tui
```

DSH 和本插件都仍处于预发布阶段。升级前应备份重要工作，保留权限 preset 与沙箱隔离，不应把静态危险命令守卫视为唯一安全边界。
