# TUI 指令配置 & 内容输出 · 设计审查报告

> **审查日期**：2026-09-10　**基线提交**：`63fec4d`（CR-084~CR-106 已全部落地）
> **审查范围**：① 指令系统与配置系统（`src/commands/*`、`src/panels/*`、命令分发、settings/快捷键）；② 内容输出的设计与实现（`src/renderer/*`、投影与终端行为）
> **状态**：**全部未整改（open）**。本文件是审查产出，供后续优化使用。
> **编号**：`DR-###`（Design Review），与 `findings.md` 的 CR 序列独立；归档时可映射为 CR-107 起。

## 0. 阅读指南：验证等级

每条发现都标注验证等级，优化前建议先复现最高等级项：

| 标记 | 含义 |
|---|---|
| ✅ **本人复现** | 主审在本次审查中实跑（真实会话日志解码 / 渲染探针 / 上游源码与调用链逐行核对） |
| 🔍 **读码确认** | 上游契约与插件代码逐行对照，未跑端到端 |
| 📄 **审查员实测** | 并行审查员报告并附实测数据，主审未独立复核（优化前建议复现） |

## 整改追踪（2026-09-10，未提交）

本节记录审查基线后的当前工作区状态；下方各发现中的 ✅/🔍/📄 仍表示**审查验证等级**，不是整改状态。

| 状态 | 条目 | 当前结果 |
|---|---|---|
| 已完成 | DR-001、DR-002、DR-011、DR-012、DR-016、DR-017 | 命令图片契约、Esc 浮层优先级、工具结果下钻、本地输出投影、日志级别和 Markdown 文档事实已修正并有回归测试。 |
| 部分完成 | DR-014、DR-015 | 已完成折叠活动明细惰性构建、durable 事件突发合并重投影，以及 `tool/result.meta` 的文件/差异展示；PTC 子调用树与真正的尾部增量投影仍未实现。 |
| 未纳入本轮 | DR-003～DR-010、DR-013、DR-018～DR-025 | 保持审查结论，不应视作已完成。 |

本轮还补充了 `/btw` 富 Markdown 卡片对齐、`/compact` 本地结果投影、Context 条形显示，以及“文本非空时行首 Backspace 删除待发送图片”的回归覆盖。

---

## 1. 总体结论

| 维度 | 评价 |
|---|---|
| 架构取向 | **正确**：以 durable event 为唯一真相源的纯投影（`projectTranscript` → blocks/rows/layoutMap/rowSpans），写操作一律走官方 API 后重投影，不伪造状态 |
| 投影骨架 | **成熟**：源偏移滚动锚点、base+live 分层合并、块级复制映射、多数截断处有省略提示 |
| 内容语义层 | **落后上游一个版本**：真实 ptc 会话约 **60% 的 durable 事件不产生任何可见行**；工具结果正文与结构化载荷（`meta`、`ptc-dispatch`）几乎未被消费 |
| 指令/配置面 | **能用但元数据缺失**：命令没有统一描述符（hint/别名/参数形态/优先级），别名、参数解析、帮助、历史、优先级各自手写 —— 已产生 3 个不可达别名、1 个幽灵命令、1 处契约形状错误 |
| 交互安全性 | **一处高风险**：回合运行中按 Esc 会先中断模型，再才轮到关闭浮层 |
| 最大短板 | 信息密度（chrome 块 vs 答案）与投影性能（每事件全量重投影，1605ms/1487 事件）随会话增长恶化 |

**建议第一批动作**（4 项，均为小改动且已定位到行）：DR-011 工具结果下钻 + `meta.diffs` → DR-012 `/btw`、`/compact` 回执改走持久通道 → DR-016 `log()` 补齐 `level` → DR-001 命令附件契约。

---

## 2. 优先级总览

| ID | 优先级 | 主题 | 一句话 | 验证 |
|----|--------|------|--------|------|
| DR-001 | P1 | 指令 | `/plan`、`/goal` 携带图片被静默吞掉 | ✅ |
| DR-002 | P2 | 交互 | 回合运行中 Esc 先中断模型，关不掉 help/menu | ✅ |
| DR-003 | P2 | 指令 | `providers/image/presets` 不可达、`/cost` 幽灵提示、裸命令不进历史 | ✅ |
| DR-004 | P2 | 可发现性 | `/help` 无命令表；README 缺 9/26 命令；菜单无 n/total | ✅ |
| DR-005 | P2 | 指令 | 命令无 hint/args 元数据；参数解析三套并存；18 个命令静默忽略多余参数 | 🔍 |
| DR-006 | P2 | 指令 | 本地命令 vs 上游命令优先级硬编码在两处 | 🔍 |
| DR-007 | P3 | 配置 | settings 面板/schema/README 三方不一致；面板承诺的 Space 键无效 | ✅ |
| DR-008 | P3 | 配置 | warn/critical 交叉校验折进 schema；面板候选值有损 | 🔍 |
| DR-009 | P3 | 配置 | `/mcp`、`/hooks` 正则扫单层 patch，漏 home 层与 `--patch` overlay | 🔍 |
| DR-010 | P3 | 指令 | `/compact` 无取消路径，且压缩期间完全拒绝输入 | 🔍 |
| DR-011 | P1 | 输出 | 工具结果正文在真实事件形态下恒为空 → 展开看结果整体失效 | ✅ |
| DR-012 | P1 | 输出 | `commitToScrollback` 在 alt-screen 丢弃内容 → `/btw` 答案等不可见 | ✅ |
| DR-013 | P1 | 输出 | 60% 事件零输出；chrome 块 345 : 答案 12 | ✅ |
| DR-014 | P1 | 性能 | 折叠态仍付展开代价 + 每事件全量重投影 | ✅/📄 |
| DR-015 | P1 | 输出 | `tool/result.meta` 与 `ptc-dispatch` 结构化载荷零消费 | ✅/📄 |
| DR-016 | P2 | 输出 | `log(kind)` 与投影 `entry.level` 字段错配 → 65 处错误全灰字 | ✅ |
| DR-017 | P2 | 输出 | 文档宣称的"闭合代码卡片"不存在（渲染为字面围栏） | ✅ |
| DR-018 | P2 | 输出 | 回合收尾读 4 个不存在的 `turn/end` 字段；usage 未聚合 | 📄 |
| DR-019 | P2 | 输出 | 非 user 的 `user/message` 造成幽灵标题 + 子代理结论被丢弃 | 📄 |
| DR-020 | P2 | 输出 | 审批 diff 8+8 行静默截断 | 📄 |
| DR-021 | P2 | 交互 | 审批排队/拒绝语义/降档/被 question 遮蔽/切换不清理 | 📄 |
| DR-022 | P2 | 输出 | 后台任务失败不入状态栏计数 | 📄 |
| DR-023 | P3 | 输出 | Markdown 降级：嵌套列表、任务列表、转义竖线、分隔行 | 📄 |
| DR-024 | P3 | 输出 | 状态栏截断无省略号；welcome 窄终端溢出；恒显 0 计数 | ✅/📄 |
| DR-025 | P3 | 输出 | 流式↔durable 默认态跳变；Ctrl+T 提示与行为不符；localLog 不持久化 | 📄 |

---

## 3. A 面 · 指令与配置系统

### DR-001 · P1 · 命令携带图片时契约形状错误，`/plan`/`/goal` 静默丢图 ✅

- **位置**：`src/index.js:3286`（`useRegistryForImages = images.length > 0 && found?.input?.images === true`）、`src/index.js:3179-3185`（`commandImages()`）、上游 `dsh-commands/lib/types/types.d.ts:20-31`、`dsh-commands/lib/index.js:431-465`
- **证据**：
  - 上游 `CommandInputDescriptor` 只有 `{ hint, attachments? }` —— **没有 `input.images`**，判定永不命中；
  - `commandImages()` 产出 `{ mediaType, data, name }`，**缺 `type:'image'`**，而 `admitCommandAttachments` 按 `attachment.type === 'image'` 过滤（该文件 441 行）→ 全部跳过 → blocks 为空；
  - `/plan` 走 `useRegistryCommand` 分支、`/goal` 走 `found` 分支，两者都把 encodedImages 交给 `registry.execute`，上游丢弃后仍返回 success → `restoreImages` 不触发、`pendingImages` 已被清空。
- **影响**：用户 Cmd+V 贴图后执行 `/plan 按这张图改布局`，图片消失、无任何提示，与 README:193 的承诺不符。
- **建议**：
  1. `commandImages()` 补 `type: 'image'`；
  2. `useRegistryForImages` 改读 `found?.input?.attachments === true`；
  3. 附件未被消费时回填 `pendingImages` 并 log error（现有回填逻辑只需被真正触发）；
  4. 测试改用契约形状（`{ input: { attachments: true } }` + 断言 `args[2][0].type === 'image'`）。

### DR-002 · P2 · 回合运行中 Esc 先中断模型，关不掉 help/menu ✅

- **位置**：`src/index.js:7288-7293`（撤回排队 → `agent.cancel()`）vs `:7301`（help）、`:7306`（menu）
- **证据**：Esc 顺序是"滚回底部 → 撤回排队消息 → **取消 running 回合** → 关浮层 → 清输入"；settings/mcp/jobs 有独立分支（`:7232` 等）所以正常，`help`/`menu` 落在全局取消之后。
- **影响**：`?` 或输入 `/` 打开浮层后按 Esc —— **模型工作被中止**（不可逆），面板还留在屏幕上。
- **建议**：把 selection → help → menu 的关闭判断上移到 `:7288` 之前，其余顺序不变。

### DR-003 · P2 · 别名不可达、幽灵命令、裸命令不进历史 ✅

- **位置**：`src/commands/registry.js:127,135,180`（`providers`/`image`/`presets` 的 case）vs `:9-36`（`LOCAL_COMMANDS`）；`src/commands/compact.js:21`；`src/index.js:2915-2952`
- **证据（本次脚本核对）**：
  1. `LOCAL_COMMANDS` 26 项、`handleLocalCommand` case 29 个，多出的 `providers/image/presets` **不在任何菜单/补全数据源**；
  2. `/cost` 全仓库只出现在 `compact.js:21` 的 `COMPACT_TIPS`（每次 `/compact` 随机展示的提示），命令不存在；
  3. 菜单分支在 `2926` 执行后直接 return，早于 `2952` 的 `this.history.push(raw)`，而 `updateMenu` 的正则对裸命令必然命中 → `/status`、`/tasks` 等**永不进 ↑ 历史**。
- **建议**：命令描述符加 `aliases`，`submit()`/`updateMenu()`/`commandItems()` 共用；`/cost` 删除或落地为 `/context` 别名；菜单分支补 `recordHistory(raw)`。

### DR-004 · P2 · 可发现性：帮助无命令表、README 与实现不同步 ✅

- **位置**：`src/panels/help.js:4-11`（仅 4 行快捷键）、`README.md:208`、README 命令表
- **证据（本次脚本核对）**：README 命令表 17 行，TUI 有 26 个本地命令；`context/help/clear/effort/preset/paste/steer/hooks/recap` 未进表，其中 `context/clear/preset/paste/recap` 在 README 中**零提及**；`/help` 面板没有任何命令清单，也缺 Ctrl+P/B/T/L/R/U/W/D 与 `!`、`//`、``!!`` 前缀说明。
- **建议**：`/help` 改为 SHORTCUTS + COMMANDS 两段（快捷键抽常量，键位处理处引用同名常量；命令段由 `commandItems()` 渲染前 N 条 + 命令总数提示）；菜单/palette footer 加 `selected+1/total`；README 命令表补齐或从 `LOCAL_COMMANDS` 生成。

### DR-005 · P2 · 命令元数据缺失导致解析散落 🔍

- **位置**：`src/commands/registry.js:47,144,174,181`、`src/index.js:3905-3907`、`src/commands/btw.js:8`
- **现象**：8 个命令接受位置参数、用了 3 种解析法且都不支持引号（`/effort "high effort"` → `high`）；其余 18 个命令静默丢弃多余参数；上游 `input.hint` 未在菜单/palette 展示。
- **建议**：描述符加 `hint` 与 `args: 'none'|'rest'|'token'`，提供唯一 `parseArgs(descriptor, line)`；`extra` 非空时统一输出用法提示；`commandItemRow` 渲染 hint。

### DR-006 · P2 · 本地/上游命令优先级硬编码在两处 🔍

- **位置**：`src/index.js:3285`（`useRegistryCommand = commandName === 'plan' && Boolean(found)`）与 `:7681-7696`（`commandItems()` 内重复同一规则）
- **现象**：当前 profile 注册 `compact/export/feedback/goal/permission/plan` 6 个上游命令；`plan` 让位、`compact` 是"本地包装再调 registry"、其余本地命令静默遮蔽同名上游命令（`/export` 一旦上游挂载就会被本地实现顶替）；改规则必须同时改两处字符串。
- **建议**：改声明式字段（`registry: 'wrap' | 'prefer' | 'shadow'`），两处共用；启动时对 shadow 且上游存在的名字 log 一条 dim 提示。

### DR-007 · P3 · settings 面板 / schema / README 三方不一致；Space 键无效 ✅

- **位置**：`src/renderer/themes.js:216-233`（16 键）vs `src/panels/settings-panel.js:3`（`SETTINGS_KEYS` 13 键）与 `:21-35`（13 个手写 entries）、`:46`（footer 文案）vs `src/index.js:7232-7237`（按键处理）、`src/index.js:379`（`showWelcome`）
- **证据**：
  - 缺面板入口的 3 键：`visionProvider/visionModel`（走 `/vision`）、`disabledSkills`（走 `/skills`）；
  - `SETTINGS_KEYS` 与 `entries` 是两个**必须按 index 对齐**的手写数组，标签已与键名分叉（`statusline` ↔ "statusline density"）—— 顺序一旦调整，`cycleSetting` 会改到别的键且无报错；
  - footer 写着 "Enter / **Space** change"，但按键分支只处理回车/Tab/Esc/Ctrl+C/CSI；
  - `showWelcome` 只在默认对象里出现一次：不在 schema（首次 `applySettings` 即被覆盖），也没有读者。
- **建议**：面板改单一数据源 `SETTINGS_ROWS = [{ key, label, hint, kind }]`，`SETTINGS_KEYS = SETTINGS_ROWS.map(r => r.key)`；补 3 行只读跳转（vision route / disabled skills / welcome）；按键分支加空格或删文案；删除 `showWelcome`；README 补 16 键表。

### DR-008 · P3 · 阈值交叉校验放错层，面板是有损编辑器 🔍

- **位置**：`src/renderer/themes.js:147-152`、`src/index.js:3425-3446`
- **现象**：跨字段约束折进 schema → 对外 schema 不完整、单键写入永远无法把 warn 提到 critical 之上；面板候选值收窄成 `{50,60,70}×{75,80,90}`+当前值 → 自定义的 65 一旦离开**再也回不去**（schema 允许 1..99）。
- **建议**：交叉校验移到 `settings.register(..., { validate })`；提升 warn 时一次提交两键；阈值改 ±5 步进或行内输入。

### DR-009 · P3 · `/mcp`、`/hooks` 未读配置真相源 🔍

- **位置**：`src/index.js:3499-3530`、`:3565-3604`
- **现象**：以 `process.argv.indexOf('--profile')` + 逐行正则读取 `profiles/<name>/cordis.patch.yml`；上游组合顺序是 bundle → profile → **$DSH_HOME/cordis.patch.yml（优先级高于 profile 层）** → `--patch` overlay，插件只读中间层。
- **影响**：home 层被禁用的 MCP 仍列为已配置；home 层或 overlay 新增的 hook 永不显示；`--profile=tui` 等号写法会 fallback 到 web profile。
- **建议**：改用已组合的 loader 条目树（`ctx.get('loader')` 的 entries + 合并后 config），文件扫描仅作 fallback。

### DR-010 · P3 · `/compact` 无取消路径且阻断输入 🔍

- **位置**：`src/commands/compact.js:81-82`（AbortController 无 abort 调用点）、`src/index.js:2903-2906`（`compacting` 期间 submit 早退）
- **现象**：压缩卡住时 Ctrl+C 走退出确认、Esc 只清输入，用户既不能取消也不能继续对话，只能重启。
- **建议**：controller 挂到 app，压缩中 Esc = abort + 收回 `compacting/compactState`，footer 提示 "Esc cancel"；加 120s 兜底超时；harness 压缩只解除 submit 早退。

---

## 4. B 面 · 内容输出的设计与实现

### DR-011 · P1 · 工具结果正文在真实事件形态下恒为空 ✅（真实日志复现）

- **位置**：`src/renderer/activity.js:138-154`（`resultTextFrom`）、`src/renderer/ansi.js:310-314`（`textOf`）、`src/renderer/transcript.js:221-248`
- **证据**：真实 durable 形状为 `data.message.content = [{ type:'tool-result', toolCallId, content:[{type:'text',text}] }]`。本次从 2399 事件真实会话抽一条实跑：

  ```
  toolResultText(sample.data)          = ""
  textOf(sample.data.message.content)  = ""
  （而 content 内确有 "vision files: [ ... ]" 全文）
  ```

  `textOf` 只挑顶层 `type==='text'`，`resultTextFrom` 对数组提前 `return ''`，整条回退链恒空。
- **影响**：任何工具卡片展开后只有 no displayable output returned by the runtime，"展开看结果"这条路径整体失效；连带 diff 分支不可达，`renderDiffLines` 在转写中事实不可用。
- **建议**：`resultTextFrom` 下钻 `tool-result.content → text`；`tool/result` 分支优先使用 `event.data.meta?.diffs`；补一条以真实事件 JSON 为 fixture 的单测（现有测试用的是旧形状，所以一直没暴露）。

### DR-012 · P1 · `commitToScrollback` 在 alt-screen 丢弃内容 ✅

- **位置**：`src/index.js:8098-8104`（alt-screen 分支直接 return，丢弃 `lines`）、`src/renderer/screen.js:30`（`initTerminal()` 无条件 `isAltScreen = true`）
- **证据**：全仓库 `isAltScreen` 赋值只有 init(false)/initTerminal(true)/restore(false) 三处，运行期恒为 true → 直写分支**永不执行**。调用方：

  | 模块 | 输出通道 | 结果 |
  |---|---|---|
  | `btw.js:18,23,112,114,117` | 仅 `commitToScrollback` | **答案卡片不可见** |
  | `compact.js:98,110` | 仅 `commitToScrollback` | **成功回执不可见**（只剩 durable 标记） |
  | `compact.js:113,117` 错误 | `app.log()` | 走 localLog，可见（但见 DR-016） |
  | `recap.js:127,137` + `:184` | `appendLocalLogEntry` **+** `commitToScrollback` | 正常（正确模板） |

- **影响**：`/btw` 跑完看不到任何答案；`/compact` 成功的 token 变化回执消失；外部 MCP stderr 路由与斜杠命令回显同样受影响。
- **建议**：把 `commitToScrollback` 改成"提交本地 transcript 块"（`local/log` 增加 `rawRows` 直通分支，宽度变化时按当前 columns 重排），或提供 `app.printCard()` 统一入口；recap 是现成的正确范例。

### DR-013 · P1 · 信息密度：60% 事件零输出，chrome 块 345 : 答案 12 ✅（我实测）

- **位置**：`src/renderer/activity.js:282-404`（span 边界按"连续工具事件"切分）、`src/renderer/transcript.js:101-278`、`430-460`
- **实测数据**（真实会话 1487 事件 / 120 列）：

  ```
  rows: 803 | 投影耗时: 1605ms
  blocks: activity:187  reasoning:158  answer:12  user:1  turn-header:1  turn-end:1
  assistant/messages: 188 | 含可见正文: 12
  零输出事件: step/start 188 + step/end 188 + ptc-dispatch 262 + ptc-dispatch-start 262
              = 900 / 1487 ≈ 60%
  ```

  另有 `todo/write` 3 条未被消费（上游已提供结构化 todos）。
- **影响**：12 段答案被 345 个 chrome 块包围；折叠态下要滚过上百条工具卡片才能找到上一段答案。`computeActivitySummary` 本支持多调用聚合，但 span 切分让它永远用不上。
- **建议**：① span 边界改为"同一 turn"（事件都带 `data.turn`，`turn/end` 收口）→ 一轮一行摘要；② 历史 reasoning 折进 turn 块（摘要 thought ×N），流式期间保持实时抽屉；③ `answer` 块保持独立不折叠。

### DR-014 · P1 · 折叠态仍付展开代价 + 每事件全量重投影 ✅/📄

- **位置**：`src/renderer/transcript.js:112-277`（detailRows 无条件构建，最后才丢弃）、`src/index.js:1426-1436` + `:1765`（每个 durable 事件都触发全量 reproject）、`src/renderer/ansi.js:7-24,77-81`
- **证据**：
  - 本人实测：真实会话 1487 事件单次投影 **1605ms**；
  - 审查员实测（📄）：2368 事件 **3223ms**；把 run_code 源码盒换成一行 → **521ms**（**84% 时间花在从不显示的折叠明细上**）；`widthOf` 77 字符 ASCII **255µs/次**（`visibleOf` 同串 1.1µs）。
- **影响**：一个 ~46 次工具调用的回合产生 ~90 次全量重投影，同步阻塞事件循环；渲染定时器 32ms，表现为流式卡顿，且随会话变长单调恶化。
- **建议**：① `widthOf` 加纯 ASCII 快路径 + 记忆化；② 明细惰性构建；③ 增量投影（尾部投影 + `mergeTranscriptDocuments`，仅在 resize/展开变化/视图清空时全量）；④ 突发事件合并到下一帧只投影一次；⑤ run_code 源码盒加行数预算。

### DR-015 · P1 · 上游结构化展示通道零消费 ✅/📄

- **位置**：`tool/result.meta`（契约 `dsh-session/lib/types/types.d.ts:351-361`；`dsh-tool-fs` 提供 `{path,lines,totalLines,lang}` 与 `{diffs:[{path,oldText,newText}]}`；`dsh-tool-fs-search` 注明"UI 渲染的结构化形状必须走 meta"）；`tool/ptc-dispatch(-start)`（`name/arguments/isError/content`）
- **证据**：全仓库无 `event.data.meta` / `data?.meta` 读取；`ptc-dispatch` 事件 0 引用（真实会话中占 37% 事件量）。
- **影响**：Read/Write/Grep/Web 卡片拿不到官方结构化信息（行号、语言、命中数、官方 diff）；PTC 摘要与真实执行不一致（审查员实测：静态解析 54 个动作 vs 真实 74 个，循环场景 1 vs 29）。
- **建议**：① 工具卡片按 `meta` 分派专用渲染，缺失时回退文本卡片；② 把 `ptc-dispatch*` 纳入 `isToolEvent`，按 `subCallId` 配对渲染子调用树，折叠摘要改用真实计数。

### DR-016 · P2 · `log(kind)` 与投影 `entry.level` 字段错配 ✅

- **位置**：`src/index.js:2374-2375`（写 `kind`）vs `src/renderer/transcript.js:630-632`（读 `entry.level`）
- **证据**：两者永不匹配 → `color = ANSI.dim`、`icon = '·'`；全仓 `log('error', …)` **65 处**、`log('ok', …)` 40 处全部退化为灰字无标记（压缩失败、vision 失败、会话切换失败、jobs 失败…）。而正确处理该形状的卡片通道在 alt-screen 下被丢弃（DR-012），灰字是用户唯一能看到的形态。
- **建议**：`log()` 同时写 `level`；投影改 `entry.level ?? (entry.kind === 'error' ? 'err' : 'ok')`；补回归断言（error 行首含 ✗ 且带珊瑚色）。

### DR-017 · P2 · 文档宣称的"闭合代码卡片"不存在 ✅

- **位置**：`src/renderer/markdown.js:147-162`（渲染为字面代码围栏 + 缩进）vs `ARCHITECTURE.md:104`、`CHANGELOG.md:52`（宣称"四边闭合卡片"）
- **证据**：用渲染器直接渲染 js 代码块，输出为字面围栏行；历史提交 `a93cf9d`（viewport 重写）改掉了旧实现，文档未同步。
- **建议**：要么实现卡片（顶部边框带语言标签，复制时剥离边框 —— rowSpans 已具备该能力），要么修正文档并补一条视觉契约回归测试。

### DR-018 · P2 · 回合收尾行读错事件字段 📄

- **位置**：`src/renderer/transcript.js:494-531`（读 `data.durationMs / data.cost.totalTokens / data.toolCallsCount / data.recap`）
- **现象**：`turn/end` 契约只有 `{ turn, reason }` → 收尾行永远只能是 Worked for 9.4s；真实 usage 就在上方 `assistant/message.usage`。
- **建议**：按 `data.turn` 聚合本轮 usage，收尾行输出 tokens/时长/步数；清理同文件 3-4 处不可达分支。

### DR-019 · P2 · 注入型 `user/message`：幽灵标题 + 子代理结论被丢弃 📄

- **位置**：`src/renderer/transcript.js:289-292`（先置 `turnHeaderPrinted = false`，再判断 source）
- **现象**：真实会话 source 分布 user:14、agent-message:5、subagent-settled:4、plugin:2、agent-instructions:1、skill-catalog:1 → 23 个 turn-header 但只有 14 个用户块（9 个幽灵标题）；`subagent-settled` 的结论正文与 `agent-message` 被整条丢弃。
- **建议**：`turnHeaderPrinted = false` 移入 `source.kind === 'user'` 分支；为 `subagent-settled` / `agent-message` 增加轻量投影（一行摘要 + 可展开）。

### DR-020 · P2 · 审批 diff 静默截断 📄

- **位置**：`src/renderer/diff.js:71-82`（`slice(0, 8)` × 2，无省略提示）
- **影响**：审批是唯一"用户据此授权"的界面；40 行改写只展示前 8+8 行且不说明省略 → 信任问题。
- **建议**：补省略提示；标题改为展示总行数，让规模先可见。

### DR-021 · P2 · 审批/提问的排队、语义与归属 📄

- **位置**：`src/index.js:2020-2047`（无排队提示）、`:6838-6921`（三种拒绝语义 + 选项 2 无条件写入 workspace-write）、`:8338-8340` vs `:8306`（审批遮蔽 question 面板）、`:4862-4906`（切换不清理 `pendingApproval`）
- **建议**：卡片 footer 加待处理数量；审批项绑定 session/agent 并在切换时取消；选项 2 按当前档位生成文案（避免降档）；审批卡出现且存在 question 时提示"还有待答问题"。

### DR-022 · P2 · 后台任务失败无提示 📄

- **位置**：`src/index.js:5748`（`recentUsage().jobs` 只留 running/stopping）、`src/renderer/statusline.js:68-76`、`:229-231`（compact 密度丢弃 jobs 段）
- **建议**：在 `onJobsChanged` 做状态跃迁检测，失败时 log 一条并提示查看 `/jobs`；失败计数与 density 解耦。

### DR-023 · P3 · Markdown 降级 📄

- **位置**：`src/renderer/markdown.js:387-428`（列表/引用）、`:168-180`（表格识别）
- **现象**：嵌套列表缩进被吞（层级丢失）、任务列表不转换、转义竖线被当分列符、短分隔行不识别、省略首尾竖线的 GFM 表格不识别、删除线与 setext 标题原样输出。
- **建议**：列表按前导宽度计算 depth 并加缩进前缀；任务列表用方框字符（比 emoji 安全）；表格分列改为忽略转义竖线并还原单元格内容，分隔行正则放宽。

### DR-024 · P3 · 窄终端与空状态的降级 ✅/📄

- **位置**：`src/renderer/statusline.js:81-83`（`fitRows` 用 `truncateAnsi` 硬截断、无省略号；本次实测 80 列时出现 jobs 1 acti、标题被硬切）、`src/renderer/welcome.js:5,25`（`columns < 52` 仍输出 52 列边框，Tip 行固定 73 列）、`statusline.js:248-250`（恒显 0 skills · 0 MCPs · 0 hooks）
- **建议**：行级截断统一走带省略号的 `shorten()`；welcome 下限改 `Math.min(52, Math.max(24, columns - 2))` 且 Tip 行走 `truncateWidth`；计数为 0 时省略对应 badge。

### DR-025 · P3 · 状态一致性与可恢复性 📄

- **位置**：`src/renderer/transcript.js:688,740`（live reasoning 默认展开）vs `:432,442`（durable 默认折叠）；`src/index.js:7722-7734`（Ctrl+O 的 key 与 durable 的 `reason-<seq>` 不同）；`src/index.js:7740-7746`（Ctrl+T 仅全完成时可展开，提示却写 Ctrl+T or /tasks）；`src/index.js:429,2357-2372`（`localLog` 纯内存、切换即清空）
- **建议**：live 与 durable 共用 `reason-<seq>` key 并统一默认折叠；Ctrl+T 提示按完成度分支或允许进行中展开；本地日志要么落成 log-only durable 事件，要么在 resume 时明确提示"本地输出不随会话恢复"。

---

## 5. 已验证良好的设计（优化时不要改坏）

1. **纯投影 + 源偏移锚点**：`projectTranscript(events, columns)` 只产出 blocks/rows/layoutMap；resize 后按源码偏移恢复视口，中文重排不跳。
2. **base + live 分层合并**：`hasTurnHeaderInCurrentTurn` + `suppressTurnHeader` 结构性解决了 CR-067 的重复标题。
3. **块级 rowSpans 复制模型**：框选复制得到原始 markdown 而非 ANSI 行（YOU 气泡还专门处理边框偏移）。
4. **多数截断是诚实的**：工具结果 N more lines、diff 行数上限、compaction 标记显式写出条目数与 token。
5. **写后重投影**：`togglePlanMode`/`cyclePermission`/`choosePreset`/`chooseModel` 都只在官方 API 成功后更新投影，无本地伪造。
6. **`/compact` 委托上游**：通过 `ctx.commands.find/execute` 调用官方实现，cordis.patch.yml 注释锁定 "command-compact 保持启用"。
7. **本地命令拒绝图片而非吞图**：带图片执行本地命令会回填 `pendingImages` 并报错（DR-001 正好绕过了这条保护）。
8. **结构化输出专用通道**：`local/log` 的 `structured:'status'` 走 `renderStatusPanelRows`，CR-080 的分组污染已根治；该模式值得推广到 goal/plan。
9. **审批参数靠 callId 回查**：不依赖非契约的 `request.args`；`settle` 幂等；stop/退出会 drain 队列。
10. **命令发现三链路同源**：`submit()` 的 isCommand、`updateMenu()`、`commandItems()` 共用 LOCAL_COMMANDS + ctx.commands.list() + skills 的 Map 去重。

---

## 6. 建议落地顺序

| 批次 | 内容 | 改动量 | 预期收益 |
|---|---|---|---|
| **第 1 批** | DR-011（下钻 + meta.diffs）、DR-012（本地卡通道）、DR-016（log level）、DR-001（命令附件契约） | 每项 3~20 行 + 回归测试 | 恢复"展开看结果/看 diff"、`/btw` 可见、错误有视觉分级、`/plan` 不再吞图 |
| **第 2 批** | DR-002（Esc 顺序）、DR-003（别名/幽灵/历史）、DR-004（help 命令表 + README）、DR-015（meta 卡片分派） | 中等 | 交互安全 + 可发现性 + 工具卡片质量 |
| **第 3 批** | DR-014（惰性明细 + widthOf 快路径 + 增量投影）、DR-013（turn 级分组） | 较大（投影层） | 长会话不再卡顿；chrome 块数量下降一个量级 |
| **第 4 批** | 其余 P2/P3（DR-005~010、017~025） | 零散 | 一致性收尾 |

---

## 7. 复现方法附录

1. **真实会话日志解码**（用于 DR-011/013/014/015）：
   - 定位：`find ~/.dsh/sessions -name '*.v3.jsonl.zstd' -exec ls -S {} + | head -3`
   - 解码：`zstd -dc <file>`（每行一个 durable event）
   - 注意：v3 日志为多帧 zstd，需用 `zstd` CLI；Node 的 `zstdDecompressSync` 只解第一帧。
2. **投影密度/耗时**：`projectTranscript(events, 120)` 后统计 `doc.blocks` 的 kind 分布与 `doc.rows.length`。
3. **工具结果形状**：对任意 `tool/result` 事件调用 `toolResultText(event.data)` 与 `textOf(event.data.message.content)`，真实会话下均为空串。
4. **渲染探针**：`renderMarkdownRows/renderMarkdownDocument` + `visibleOf` 打印，即可看到代码围栏、表格、状态栏截断的实际输出。
5. **命令面核对**：比对 `LOCAL_COMMANDS`、`handleLocalCommand` 的 case、README 命令表三者的集合差。

## 8. 未覆盖 / 待验证

- **PTY 端到端**：本机缺 `profiles/tui` fixture，所有结论均为单测 + 真实日志 + 读码，未跑 TUI 真实进程。
- **待复核的 📄 项**：DR-014 的 84%/255µs、DR-018 的字段缺失、DR-019 的幽灵标题数量、DR-021 的降档行为、DR-023 的 Markdown 对照。
- **未审区域**：`statusline.js` 的信息优先级策略、`themes.js` 配色对比度（无障碍）、`welcome.js` 首屏文案。
