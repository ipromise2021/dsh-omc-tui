# 发现与决策

## 需求

- 交互视觉与行为改为更接近 Claude Code 的简洁 CLI。
- VS Code 鼠标滚轮用于终端回看，不能修改输入框历史。
- 鼠标拖拽使用终端原生文本选择与复制；不使用 Shift 绕过模式。
- 保留 `↑/↓` 输入历史、多行编辑、Harness 会话与命令能力。

## 研究发现

- 现有实现使用 `CSI ?1049h` 进入备用屏幕，并以全帧重绘维持固定输入与状态区。
- 备用屏幕中的滚轮在部分终端会转化为方向键；这些字节与真实方向键完全相同，应用无法可靠地区分。
- VS Code 使用 xterm.js；当应用没有启用鼠标协议时，终端负责滚轮与选择。普通缓冲区天然提供可回看的 scrollback。
- 已尝试关闭 alternate-scroll 与常见鼠标协议，但用户实测仍会触发历史，因此不再重复该方案。

## 技术决策

| 决策 | 理由 |
|------|------|
| 主对话采用追加式普通缓冲区 | 让终端原生 scrollback 解决滚轮与选择。 |
| 输入、菜单和 statusline 只作为短生命周期的底部区域 | 避免全帧清屏，同时保持 CLI 的明确反馈。 |
| 先保留复杂面板的数据与键盘逻辑 | 降低与 Harness 适配层的风险；布局在迁移后逐项简化。 |

## 遇到的问题

| 问题 | 解决方案 |
|------|---------|
| 全帧 ANSI 重绘无法同时提供原生滚轮回看 | 改为普通缓冲区的增量输出模型。 |

## 资源

- [VS Code terminal basics](https://code.visualstudio.com/docs/terminal/basics)
- [xterm.js Viewport source](https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/Viewport.ts)

## 插件市场与 TUI 安装调研（2026-08-15）

### 本地实现现状

- `dsh-omc-tui` 已经是一个可由 profile 挂载的 `dsh.bundle`：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 负责把 TUI 插入 Harness 组合树。
- 当前 `src/index.js` 的能力探测包含 `ctx.agents`、`ctx.commands`、`ctx.skills`、`ctx.settings`、`ctx.jobs` 等服务，但没有 `ctx.plugins`、catalog、package-manager 或安装 broker；`LOCAL_COMMANDS` 也没有 `/plugins`、`/market`、`/install`。
- 当前技能菜单只调用官方 `ctx.skills.list()`；它能发现已挂载的技能，不能安装或卸载新的 bundle。TUI 重启后会重新读取 profile 中的服务和技能。

### 官方 `dsh plugin` 的真实行为

本机 `@deepseek-ai/dsh@0.1.0-rc.6` 的 `dsh plugin` 实现位于 `lib/plugin-*.js`：

1. 首次使用时初始化 `$DSH_HOME/profiles/<profile>`。
2. 将参数原样转发给 profile 目录中的 `pnpm`，例如 `add <package>`、`remove <package>`、`why <package>`。
3. 安装成功后读取依赖包的 `dsh.bundle.patch`；含该声明的依赖会自动追加到 `dsh.profile.bundles`，被移除或不再声明 bundle 的包会从 bundle 栈移除。
4. Git 仓库插件可能运行 `prepare` 构建脚本，并受 pnpm `allowBuilds` 约束；失败时 CLI 会提示用户把精确的构建包名加入 `pnpm-workspace.yaml` 后重试。
5. 这是 profile 级安装，不是当前会话内热加载。安装完成后应重新启动 TUI，让 profile 重新 compose Cordis 树。

因此，TUI 可以发起官方安装流程，但不应自行改写 `package.json`、`cordis.yml` 或 bundle 列表，也不应假装已在当前进程热生效。

### DSH Hub 目录证据

实测 [DSH Hub catalog](https://dshhub.org/#catalog) 是一个公开的插件发现目录：页面显示约 2628 个结果，支持关键词搜索、类别、星标/更新时间/名称排序，以及“待验证/不兼容”等兼容性筛选。分类包括 Agent 协作、开发工具、integrations、界面、memory、skills、视觉等。

目录条目至少提供：

- GitHub 来源与固定 revision（部分条目是 `github:owner/repo#<commit>&path:<subdir>`）；
- 包名、版本、许可证、星标、最近更新时间、描述、分类和文档链接；
- 可复制的官方安装命令 `dsh plugin --profile <profile> add <source>`；
- 条目兼容性状态或待验证提示。

目录中的 TUI 示例 `dsh-cc-tui` 使用 BSD-3-Clause、版本 0.3.3，并给出固定 commit 的 GitHub 文档链接；web UI 家族插件也使用相同的 profile bundle 安装方式。目录目前更像公开仓库扫描/展示层，未观察到稳定、公开、版本化的 JSON API，因此首版不应让 TUI 直接依赖页面 HTML 抓取。

### 可行性结论

可行，但推荐把功能拆成“市场前端 + 官方安装委托”，而不是把包管理器搬进 TUI：

- TUI 负责搜索/筛选/详情/风险提示/用户确认和安装结果展示；
- 安装由宿主 `dsh plugin --profile tui add <source>` 执行，参数使用 argv 数组，不拼接 shell 字符串；
- 安装作用域固定为当前 TUI profile，安装完成明确提示“需重启 TUI 生效”；
- 第三方代码安装属于外部副作用，必须显示来源、revision、许可证、构建脚本风险、将新增的 bundle/工具/技能，并要求显式确认；
- `/plugins installed` 读取 profile manifest/lock 展示已安装包；移除同样委托官方 CLI，并要求二次确认；
- 在官方 catalog API 尚未明确前，先做可替换的 catalog adapter：优先官方/维护者提供的 JSON 索引，其次才是带缓存、版本和超时的独立适配器；不要把脆弱的 DOM 抓取写进 TUI 核心。

### 推荐交互

- `/plugins` 或 `/market`：打开市场列表，输入关键词过滤；`↑/↓` 移动，`Enter` 看详情，`r` 刷新，`Esc` 返回。
- 详情显示：名称/版本、来源与 revision、许可证、类别、星标/更新时间、兼容性、声明的 bundle/服务摘要、安装命令和风险。
- `i` 或 `Tab` 仅进入确认，不直接安装；确认后显示 pnpm 输出、退出码和是否需要 `allowBuilds`。
- `/plugins installed`：显示当前 profile 的 dependencies、bundle 状态和版本；`remove` 先预览依赖影响再确认。

### 分阶段实现方案

1. **Discovery contract（只读）**：定义 catalog schema、来源/commit 解析、缓存 TTL、离线和损坏数据降级；先接 mock JSON，不安装。
2. **TUI 市场面板**：新增可选的 `ctx`/adapter 能力探测；无 catalog 时隐藏入口并给出说明；实现列表、搜索、详情、已安装视图和键盘交互。
3. **Host install broker**：新增一个很薄的宿主命令适配层，调用 `dsh plugin --profile tui add/remove`；只传结构化 argv，捕获 stdout/stderr/退出码，禁止任意 shell 注入。
4. **重启与重新 compose**：安装成功后标记 profile dirty，展示“restart required”；首版不做进程内热加载，后续再评估安全的 relaunch。
5. **安全与验证**：覆盖 pinned commit、npm 包、GitHub 子目录、prepare/allowBuilds 失败、网络超时、取消、profile 隔离、回滚、Windows 路径和无 pnpm 环境。

### 不建议的方案

- 不在 TUI 内直接写 `$DSH_HOME/profiles/tui/package.json`、`cordis.yml` 或 `dsh.profile.bundles`。
- 不在当前 Cordis/Agent 进程里动态 import 新插件并宣称已经生效。
- 不把整个 DSH Hub HTML 页面嵌入终端；市场元数据应是独立、可测试、可缓存的 adapter。
- 不默认执行未固定 revision 的第三方安装；没有许可证或兼容性信息的条目应标记为高风险并要求额外确认。
