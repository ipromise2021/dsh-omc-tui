---
name: git-commit
description: 规范化 Git 代码提交技能：分析工作区变动、生成符合 Conventional Commits 的提交信息，并通过 bash 工具安全执行提交。仅在用户明确要求提交（如“提交代码”“帮我 commit”“提交这次改动”或 /git-commit）时激活；任务完成后绝不自主提交或推送。
user-invocable: true
allowed-tools: "bash read"
metadata:
  version: "1.0.0"
---

# Git Commit 规范提交技能

> ⚠️ **触发铁律**：本技能只在用户明确要求提交时执行（如“提交代码”“帮我 commit”“提交这次改动”或 `/git-commit`）。任务完成、代码改完或用户未表达提交意图时，**绝不**主动执行 `git commit`，也**绝不**主动 `git push`。

当用户提到“提交代码”、“帮我 commit”、“提交改动”或输入 `/git-commit` 时，严格按照本 SOP 执行。

---

## 🎯 自动化执行 SOP

### 步骤 1：检查工作区状态与差异
优先使用 `bash` 工具执行以下命令快速了解当前变更：
```bash
git status -s && git diff --stat
```

### 步骤 2：生成 Conventional Commits 规范信息
根据修改的文件与内容类型，生成清晰、专业、遵循 Conventional Commits 的提交信息：
- `feat(...)`: 新特性或功能增强
- `fix(...)`: Bug 修复
- `docs(...)`: 文档更新
- `style(...)`: 代码格式、UI 样式微调
- `refactor(...)`: 代码重构（无功能改变）
- `perf(...)`: 性能优化
- `test(...)`: 测试用例增补
- `chore(...)`: 构建配置、依赖或杂项维护

### 步骤 3：精准暂存并提交
使用 `bash` 工具执行 `git add` 与 `git commit`：
```bash
git add <涉及的文件> && git commit -m "<type>(<scope>): <summary>"
```

### 步骤 4：向用户清晰汇报
输出本次提交的 Commit Hash、类型与核心修改点。**不要主动执行 `git push`**；仅在用户明确要求推送时才推送。
