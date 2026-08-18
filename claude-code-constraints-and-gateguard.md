# Claude Code 内置约束 与 GateGuard（Fact-Forcing Gate）机制详解

> 文档日期：2026-08-17
> 用途：从文字完整还原 Claude Code harness 的**内置行为约束** 与 **GateGuard 事实强制门（Fact-Forcing Pre-Action Gate）** 两套机制的实现原理、触发时机、判定流程与所有相关文件，供后续会话/代理按文字重建或调整。
> 来源：本机 `~/.claude/skills/everything-claude-code/` 下 GateGuard 完整源码（SKILL.md + gateguard-fact-force.js 1278 行）+ Claude Code harness 实际运行行为观察。

---

## 一、总览：两套机制的分工

| 机制 | 来源 | 性质 | 触发对象 | 核心目的 |
|------|------|------|----------|----------|
| **Claude Code 内置约束** | Claude Code harness（客户端本体） | 运行时强约束（不可关） | 所有工具调用（Read/Edit/Write/Bash/Agent 等） | 保证工具调用与文件状态一致、结果可信 |
| **GateGuard（Fact-Forcing Gate）** | `everything-claude-code` 插件（社区） | PreToolUse hook（可关） | Edit/Write/MultiEdit/Bash | 强制修改前出示"事实"（importers/API/schema/指令），阻止凭猜测动手 |

两者**叠加生效**：内置约束管"怎么调用正确"；GateGuard 管"动手前先调查"。本会话实测：GateGuard 拦截 14 次；内置约束（未读先改、重复读）亦多次触发。

---

## 二、Claude Code 内置约束（Harness Runtime 约束）

### 2.1 来源与性质

- 内置于 Claude Code 客户端（harness），非用户可配置，无源码文件在用户目录（是官方 CLI 二进制内的行为）。
- 通过工具调用的**返回错误/行为**体现，不通过提示文本。

### 2.2 约束清单（共 5 条，本会话全部实测触发）

#### ① Edit/Write 前必须 Read
- 行为：对**未读过**的文件执行 Edit/Write 会直接失败，提示必须先 Read。
- 相关文件：任意目标文件（由 harness 按文件状态判定）。
- 机制：harness 维护"本会话已读文件集合"，Edit/Write 前校验目标文件是否在集合内。

#### ② 不可重复读取未变更文件
- 行为：对**已读过且未变更**的文件再次 Read，返回"file unchanged since your last Read"，并提示引用先前结果。
- 机制：harness 记录每个文件最后读取的内容 hash + 状态；文件未变更时复用上下文而非重复注入。

#### ③ 工具结果即事实
- 行为：工具调用成功/失败以**返回值为准**；成功返回值直接成为上下文，不可编造未发生的工具结果。
- 相关：Edit 成功返回"updated successfully"、Bash 返回 stdout/stderr、Write 返回"created"等。

#### ④ 后台任务结果不可预测
- 行为：sub-agent（Agent 工具）在后台运行时，**禁止报告其尚未返回的结果**；完成通知到达前只能说"仍在运行"。
- 机制：harness 以 `task-notification` 事件推送 sub-agent 完成；在此前任何关于其结果的陈述都是违规。

#### ⑤ 权限模式
- 行为：工具调用走用户选择的 permission mode（acceptEdits/plan/bypassPermissions 等）；被拒绝的调用**调整方案而非原样重试**。
- 相关：`~/.claude/settings.json` 的 `permissions`、`~/.claude/settings.local.json`。

> 注：原归类为第⑥条的"先展示证据再断言"并非 harness 内置约束，而是 GateGuard 等 PreToolUse hook 的拦截输出被 harness 当作"用户反馈"注入后的交互效应——详见第三章 3.9 节。

### 2.3 本会话内置约束实测记录

| 场景 | 触发约束 | 处理 |
|------|----------|------|
| 多次对已读文件再次 Read | ② | 改为直接基于上下文（如 short_circuit_board.py 二次 Read 被提示"unchanged"） |
| Edit 前未读文件 | ① | 先 Read 再 Edit（所有文件修改均先 Read） |
| sub-agent 后台运行中 | ④ | 等 task-notification 到达后才汇报结果（mnemon 子代理两次均如此） |
| 权限拒绝 | ⑤ | 展示事实调整后再试 |

---

## 三、GateGuard（Fact-Forcing Gate）

### 3.1 来源与文件

| 文件 | 路径 | 内容 |
|------|------|------|
| SKILL.md | `~/.claude/skills/everything-claude-code/skills/gateguard/SKILL.md` | skill 定义：gate 类型、三条 gate 规则、A/B 测试证据、最佳实践 |
| **gateguard-fact-force.js** | `~/.claude/skills/everything-claude-code/scripts/hooks/gateguard-fact-force.js`（**1278 行**） | **实际执行的 PreToolUse hook**：检测、判定、拦截、状态机、消息生成 |
| shell-substitution.js | `~/.claude/skills/everything-claude-code/scripts/lib/shell-substitution.js` | 被 JS 引入的 shell 命令解析工具（extractCommandSubstitutions / extractSubshellGroups / extractBraceGroups） |
| hooks 注册 | `~/.claude/settings.json` 的 `hooks` 字段 | 将两个 hook id 挂到 `PreToolUse` 事件：`pre:edit-write:gateguard-fact-force`、`pre:bash:gateguard-fact-force` |
| 项目级配置（可选） | `.gateguard.yml`（`pip install gateguard-ai` 后 `gateguard init` 生成） | 自定义消息、ignore 路径、gate 开关 |

> 注意：本机 `settings.json` 的 hooks 事件（SessionStart/UserPromptSubmit/PreCompact/Stop）当前挂的是 **mnemon** 的 4 个脚本（`~/.claude/hooks/mnemon/*.sh`），GateGuard 的 PreToolUse hook 经插件机制注册（`everything-claude-code` 插件）。

### 3.2 核心设计理念（SKILL.md 原文要点）

> "LLM 自我评估没用——问'你违反政策了吗'答案永远是'没有'。但问'列出所有 import 此模块的文件'会逼它跑 Grep 和 Read。**调查行为本身创造了自我评估永远无法创造的上下文。**"
>
> A/B 测试（相同 agent、相同任务）：Analytics 模块 8.0 vs 6.5；Webhook validator 10.0 vs 7.0；**平均 9.0 vs 6.75（+2.25 分）**。

**三阶段门（Three-stage gate）**：
```
1. DENY  — 拦截第一次 Edit/Write/Bash
2. FORCE — 明确告知要收集哪些事实
3. ALLOW — 展示事实后允许重试
```

### 3.3 Gate 类型与触发规则（对应消息模板）

#### ① Edit / MultiEdit Gate（每文件首次编辑）
- 触发：`tool_name ∈ {Edit, Write, MultiEdit}` 且文件**首次**被编辑（`isChecked(filePath)` 为假）。
- MultiEdit 逐个文件独立判定（`for edit of edits` 循环）。
- 要求展示（editGateMsg）：
  1. 列出所有 import/require 此文件的文件
  2. 列出受影响的公开函数/类
  3. 若读写数据文件，展示字段名/结构/日期格式（用脱敏/合成值）
  4. 引用用户当前指令原文
- **首次拦截后展示事实重试即放行**（`isChecked` 标记后不再拦）。

#### ② Write Gate（首次新建文件）
- 要求展示（writeGateMsg）：
  1. 命名将调用此新文件的文件与行
  2. 确认无既有文件承担同一用途（搜索树验证）
  3. 数据文件结构（同 Edit）
  4. 用户指令原文

#### ③ Destructive Bash Gate（每次破坏性命令）
- 触发：`isDestructiveBash(command)` 为真。
- 要求展示（destructiveBashMsg）：
  1. 此命令将修改/删除的所有文件与数据
  2. 一行回滚步骤
  3. 用户指令原文
- **每次**破坏性命令都拦（与 routine 不同，不是每会话一次）。

#### ④ Routine Bash Gate（每会话一次）
- 触发：会话内**第一次** Bash（`ROUTINE_BASH_SESSION_KEY = '__bash_session__'` 未标记）。
- 要求展示（routineBashMsg）：
  1. 当前用户请求（一句话）
  2. 此命令验证/产生什么
- 仅一次；其后普通 Bash 放行。

### 3.4 判定与执行流程（run() 主函数，源码逐段）

```
run(rawInput):
  解析 JSON → data（解析失败直接放行）
  若 isGateGuardDisabled() → 放行          # ECC_GATEGUARD=off
  getStateFile(data)                        # 定位会话状态文件
  归一化工具名（TOOL_MAP: edit/write/multiedit/bash → Edit/Write/MultiEdit/Bash）
  若是 Edit/Write:
     文件路径为空 / 是 Claude settings 路径 / 豁免路径 → 放行
     sub-agent 调用 → 放行                   # 父会话已过首触门
     !isChecked(filePath):
        markCheckedAndCountDenial(filePath)
        若 denial 数 > getFullDenialBudget() → 压缩单行拦截(condensedGateMsg)
        否则 → 完整四事实拦截(editGateMsg/writeGateMsg)
     已检查 → 放行
  若是 MultiEdit: 同上，逐文件循环
  若是 Bash:
     只读 git 内省命令 → 放行                # isReadOnlyGitIntrospection
     isDestructiveBash(command):
        key = '__destructive__' + sha256(command)[:16]
        !isChecked(key) → markChecked + 拦截(destructiveBashMsg)
        已检查 → 放行（展示事实后重试放行）
     isRoutineBashGateDisabled() → 放行     # GATEGUARD_ROUTINE_BASH=off 逃生口
     !isChecked('__bash_session__') → markChecked + 拦截(routineBashMsg)
     已检查 → 放行
  其他工具 → 放行
```

### 3.5 破坏性命令检测（isDestructiveBash，最复杂的部分）

按优先级分五层，每层都可能触发：

1. **SQL/dd 短语正则**：`DESTRUCTIVE_SQL_DD = /\b(drop\s+table|delete\s+from|truncate|dd\s+if=)\b/i`
   - 先 `stripQuotedStrings`（剥离引号串，防 commit message 误报）+ `explodeSubshells`（展开 `$()`/反引号，防绕过）再匹配。
2. **操作员自定义破坏性正则**：环境变量 `GATEGUARD_BASH_EXTRA_DESTRUCTIVE`（懒编译 + 按 env 缓存，非法正则视为未配置并记录一次 warning，绝不 crash）。
3. **find -exec 检测**：`collectExecutableBodies` 提取命令体 → 按 `;|&` 切段 → `isDestructiveFindExec` 匹配 `find ... -exec rm` 类。
4. **rm / git 破坏性检测**（对每段 tokenize 后）：
   - `isDestructiveRm(tokens)`：匹配 `rm` + 递归/强制标志。
   - `isDestructiveGit(tokens)`：`findGitSubcommand` 定位 git 子命令（reset --hard / push --force / clean -f 等）。
5. **quote-aware 第二遍**（`isDestructiveQuoteAware`）：封堵"引号命令字 / 换行分隔 / 引号 find-exec / sh -c 前缀"四类绕过（GHSA-4v57-ph3x-gf55）。

辅助解析器（来自 shell-substitution.js）：
- `extractCommandSubstitutions`：抽取 `$(...)`。
- `extractSubshellGroups`：抽取子 shell。
- `extractBraceGroups`：抽取 `{...}` 展开。

### 3.6 状态机与防膨胀（State Management）

- **状态目录**：`GATEGUARD_STATE_DIR` 或 `~/.gateguard/`（`STATE_DIR`）。
- **状态文件**：按会话 key 哈希命名（`sanitizeSessionKey` + `hashSessionKey`），随会话 key 轮换。
- **已检查集合**：记录"已通过 gate 的文件/命令 key"，`isChecked` 判定重试放行；上限 `MAX_CHECKED_ENTRIES = 500`，超限剪枝（`pruneCheckedEntries`，按最近使用）。
- **会话键上限**：`MAX_SESSION_KEYS = 50`。
- **超时**：30 分钟无活动会话状态过期（`SESSION_TIMEOUT_MS = 30*60*1000`）。
- **原子写**：`saveState` 用临时文件 + rename 保证原子性。
- **Denial 预算（防上下文膨胀，issue #2142）**：`DEFAULT_FULL_DENIALS = 3`（可用 `GATEGUARD_FACT_FORCE_FULL_DENIALS` 覆盖）；前 3 次拦截输出完整四事实块，之后压缩为**单行**（`condensedGateMsg`，带 denial 序号 + 一行恢复提示），避免近重复块堆积放大模型重复循环。
- **仅读 git 内省豁免**：`isReadOnlyGitIntrospection`（如 `git status/diff/log` 等不修改的命令）直接放行，不触发 routine gate。
- **豁免路径 glob**：`GATEGUARD_EXEMPT_GLOBS` 环境变量（逗号分隔 glob → 正则，支持 `**` 跨段），`isExemptPath` 命中放行（如 `.venv/`、`node_modules/`）。
- **Claude settings 豁免**：`isClaudeSettingsPath`（settings.json / settings.local.json）不被 gate。
- **sub-agent 豁免**：`isSubagentInvocation`（hook 输入带 subagent 上下文）时 Edit/Write 直接放行——父会话已过首触门。

### 3.7 逃生开关（Recovery）

- **完全禁用**：`ECC_GATEGUARD=off`（或 0/false/disabled/disable）→ `isGateGuardDisabled()` 放行一切。
- **按 hook 禁用**：`ECC_DISABLED_HOOKS` 加 `pre:edit-write:gateguard-fact-force`（Edit/Write）或 `pre:bash:gateguard-fact-force`（Bash）。
- **routine gate 逃生口**：`GATEGUARD_ROUTINE_BASH=off`（破坏性 gate 仍生效）。
- **消息里的恢复提示**：拦截消息自带 `(ECC_GATEGUARD=off disables this gate.)`，且带 `withRecoveryHint` 附 hook id。

### 3.8 拦截消息模板（源码原文还原）

**Edit 门**：
```
[Fact-Forcing Gate]

Before editing {file_path}, present these facts:

1. List ALL files that import/require this file (search the tree — Glob/Grep, or find/grep via Bash)
2. List the public functions/classes affected by this change
3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)
4. Quote the user's current instruction verbatim

Present the facts, then retry the same operation.
```

**Write 门**：同 Edit，但第 1 条改为 "Name the file(s) and line(s) that will call this new file"，第 2 条改为 "Confirm no existing file serves the same purpose"。

**破坏性 Bash 门**：
```
[Fact-Forcing Gate]

Destructive command detected. Before running, present:

1. List all files/data this command will modify or delete
2. Write a one-line rollback procedure
3. Quote the user's current instruction verbatim

Present the facts, then retry the same operation.
```

**Routine Bash 门**：
```
[Fact-Forcing Gate]

Before the first Bash command this session, present these facts:

1. The current user request in one sentence
2. What this specific command verifies or produces

Present the facts, then retry the same operation.
```

**压缩单行（第 3 次之后）**：
```
[Fact-Forcing Gate] (denial #{n} this session) First {action} of {file_path}: briefly state importers/callers, affected API, data schemas if any, and the user's verbatim instruction, then retry. (ECC_GATEGUARD=off disables this gate.)
```

### 3.9 与 Claude Code 内置约束的交互

- GateGuard 拦截输出被 harness 当作**用户反馈**注入 → 触发内置约束⑥"先展示证据再断言"。
- GateGuard 是 PreToolUse hook（在工具执行**前**）；内置约束部分在工具执行**时/后**（文件状态校验、结果返回）。
- 两者互补：GateGuard 管"要不要做"，内置约束管"做得对不对"。

---

## 四、其他机制（mnemon hooks / security-guidance 插件 / superpowers skills / PostToolUse 跟踪）

> 本会话中，除 GateGuard 与内置约束外，还有四类机制在运行时实际触发。以下按"每次消息 / 上下文管理 / 推送时 / 对话判断辅助 / 工具调用后"五个时机逐一以文字还原。

### 4.1 每次用户消息时：mnemon UserPromptSubmit hook（记忆召回）

- **文件**：`~/.claude/hooks/mnemon/user_prompt.sh`；注册于 `~/.claude/settings.json` 的 `hooks.UserPromptSubmit`。
- **触发**：每次用户提交新消息（UserPromptSubmit 事件）。
- **行为**：
  1. hook 运行 `user_prompt.sh` → 调用 `mnemon recall "<关键词查询>" --limit N`（CLI：`~/.local/bin/mnemon.exe` v0.2.3）。
  2. mnemon 按关键词对 SQLite 主库（`~/.mnemon/data/default/mnemon.db`）做意图感知检索。
  3. 返回结构化 JSON（`results` 数组，每条含 `id/content/category/importance/matched_via/confidence/score`），注入会话上下文作为背景知识。
- **配套机制（mnemon 4-hook 全家，均注册于 settings.json hooks）**：

| hook 事件 | 脚本 | 作用 |
|-----------|------|------|
| `SessionStart` | `prime.sh` | 会话开始预热 mnemon 记忆 |
| `UserPromptSubmit` | `user_prompt.sh` | 每次消息召回相关记忆（本机制） |
| `PreCompact` | `compact.sh` | 上下文压缩前做记忆沉淀 |
| `Stop` | `stop.sh` | 会话结束时收尾写入 |

- **与内置约束交互**：hook 输出即上下文注入，不经过工具调用，不受内置约束①②③约束。

### 4.2 上下文管理：PreCompact hook + 自动压缩（Compact）

- **文件**：`~/.claude/hooks/mnemon/compact.sh`（hooks.PreCompact）；harness 内置压缩逻辑（无用户目录源码，CLI 二进制内）。
- **触发**：①上下文接近上限时 harness 自动压缩；②用户手动 `/compact`。
- **行为**：
  1. 压缩前运行 `compact.sh`（mnemon 记忆沉淀——把当前会话的关键内容写入记忆系统）。
  2. harness 把旧内容摘要为"summary"（保留关键决策、文件、代码段、待办），未摘要的完整对话存 transcript（JSONL，可后续读取恢复细节）。
  3. 压缩后会话用摘要 + 剩余未压缩上下文继续，不需提前收尾。
- **补充事实**：本会话曾执行 `/compact`（PreCompact hook 输出 `completed successfully`），随后以摘要继续。
- **与内置约束④交互**：压缩不影响后台 sub-agent——其完成通知仍以 `task-notification` 独立推送。

### 4.3 提交/推送时：security-guidance 插件自动安全审查

- **来源**：`claude-plugins-official` marketplace 的 **security-guidance** 插件（`enabledPlugins` 中启用；缓存位于 `~/.claude/plugins/cache/claude-plugins-official/`）。
- **触发**：`git push` 之后（PostToolUse）。
- **行为**：
  1. 后台审查本次推送的 commits（`push_sweep: true`，扫描被推文件）。
  2. 生成漏洞报告注入会话：`vulns_found` 计数、`affected files`、逐条 `severity` + 问题描述 + `suggested fix`、`metrics`（pv/tok_in/tok_out/cost）。
  3. 要求"Address each, or briefly note why it doesn't apply"——每条发现必须处理或说明不适用理由，**不得仅因"内部服务"而 dismiss**（内网服务是常见 SSRF/IDOR 目标）。
- **本会话实测**：
  - 第一次 push 后报 4 项：`jwt-secret-overwrite`（CRITICAL，POST /api/settings 可覆写 jwt_secret）、`ssrf-socket-connect`（HIGH，DirectTransport SOCKET 无地址校验）、`fail-open-regression`（MEDIUM）、第 4 项未给详情。
  - 修复并再 push 后报 `SSRF / Incomplete Fix`（MEDIUM，N/A 占位）——评估后确认既有校验已覆盖其关切。
- **与 GateGuard 交互**：审查建议的修复仍走正常编辑流程（Edit 依旧被 GateGuard 拦截、需出示事实）。
- **合法不修的理由**（审查文档明示）：用户明确要求且已表面安全权衡；或模式在当前上下文不可利用。

### 4.4 对话/判断辅助：superpowers skill 体系

- **来源**：`superpowers@claude-plugins-official` 插件（`~/.claude/plugins/cache/claude-plugins-official/`）。
- **定位**：引导型（引导怎么做），非拦截型。与用户全局规则的关系：**用户指令 > skills > 默认行为**——mandatory-workflow（用户强制）优先于 superpowers 补充。
- **关键 skills 与触发场景**：

| skill | 触发场景 | 作用 |
|-------|----------|------|
| `using-superpowers` | 会话开始 | 强制"只要有 1% 可能适用某 skill 就必须先调用"；先处理流程类 skill（brainstorming/systematic-debugging）再实现类 |
| `brainstorming` | 创造性工作前（构建功能/加组件/改行为） | 探索用户意图、需求与设计，再谈实现 |
| `systematic-debugging` | 任何 bug/测试失败/异常行为 | 先复现、取证、定位根因，再提修复 |
| `verification-before-completion` | 声称"完成/修复/通过"之前 | 必须先跑验证命令并确认输出，证据先于断言 |
| `test-driven-development` | 实现功能或 bugfix 前 | 先写失败测试，再实现至绿 |
| `executing-plans` / `subagent-driven-development` | 有书面实现计划时 | 按计划分步执行 + 审查检查点 |
| `requesting-code-review` / `receiving-code-review` | 代码审查时 | 提交审查 / 收到反馈时先验证再采纳（不表演式同意） |
| `using-git-worktrees` | 需要隔离的 feature 工作 | 用 worktree 隔离工作区 |

- **本会话实际调用**：`/ecc:code-review`（未提交改动本地审查，按 Phase 1 GATHER → Phase 2 REVIEW → Phase 3 REPORT 执行）。

### 4.5 工具调用后：PostToolUse 跟踪（成本/范围/变更提醒）

> 补充：上节 3.1"工具调用时"中除 GateGuard/内置约束外的第三类机制，本会话多次触发，为文档完整补录。注意：成本与范围告警来自 everything-claude-code 插件；文件变更通知是 harness 内置能力，两者来源不同。

- **触发**：每次工具调用之后。
- **行为（本会话实测输出）**：
  1. **成本跟踪**（everything-claude-code 插件 PostToolUse hook）：`COST CRITICAL: session total ~$1185（over $50）`——会话累计花费 + 阈值告警（超 $50 提示，仅信息性，不指示停止）。
  2. **范围警告**（everything-claude-code 插件 PostToolUse hook）：`SCOPE WARNING: N files modified this session. Consider whether changes are too scattered.`——提醒改动分散度（本会话峰值 93 文件）。
  3. **文件变更通知**（harness 内置，非插件 hook）：`Note: {file} was modified, either by the user or by a linter. This change was intentional...`——harness 检测到文件在外部（用户/linter/其他进程）被改动时，注入差异摘要并重置该文件的已读状态，要求基于新内容继续（如本会话 models.py/local_store.py 等被注入"modified"通知）。
- **与内置约束交互**：文件变更通知更新 harness 的文件状态——此后对该文件的 Edit/Read 以新内容为准（内置约束①②基于新状态，相当于自动触发一次"重新 Read"）。

---

## 五、本会话（2026-08-17）GateGuard 实测记录

| 拦截类型 | 次数 | 实际处理 |
|----------|------|----------|
| Edit 门（首次编辑文件） | 多次 | 展示四事实（importers/API/schema/指令原文）后重试通过 |
| Write 门（新建文件） | 多次 | 展示调用方/无重复用途/指令后重试通过 |
| Destructive Bash 门 | 1 次（git checkout -- tools/） | 展示影响文件 + 回滚步骤 + 指令后重试通过 |
| Routine Bash 门 | 1 次（会话首条 Bash） | 展示请求一句话 + 命令目的后重试通过 |
| 压缩单行（denial #N） | 会话后期（第 4+ 次） | 单行事实简述后重试通过 |

---

## 六、还原要点速查

要从文字重建这两个机制（及配套机制），最少需要：

1. **内置约束**：5 条规则（Edit 前 Read / 不可重复读 / 结果即事实 / 后台不可预测 / 权限模式）。"证据先于断言"是 hook 输出被当作用户反馈后的交互效应，非 harness 内置约束。
2. **GateGuard**：4 个 gate（Edit/Write/Destructive/Routine）+ 三阶段（DENY→FORCE→ALLOW）+ 状态机（`~/.gateguard/`、500 上限、50 会话键、30min 超时、原子写）+ 预算（3 次全块→单行）+ 逃生（`ECC_GATEGUARD=off`、`ECC_DISABLED_HOOKS`、`GATEGUARD_ROUTINE_BASH=off`）+ 豁免（git 内省/settings/glob/sub-agent）+ 破坏性五层检测（SQL 正则→自定义→find-exec→rm/git→quote-aware）。
3. **关键文件**：见 3.1 表格；核心实现 `gateguard-fact-force.js`（1278 行）。
4. **配套机制**：mnemon 4-hook（SessionStart=prime / UserPromptSubmit=user_prompt / PreCompact=compact / Stop=stop，注册于 settings.json hooks，调用 `~/.local/bin/mnemon.exe recall`）；security-guidance 插件（push 后自动审查，vulns_found+逐条 severity+建议修复，合法不修理由=用户明示/上下文不可利用）；superpowers skills（引导型非拦截：using-superpowers 强制先考虑 skill、brainstorming/systematic-debugging/verification-before-completion 等按场景触发）；PostToolUse 跟踪（成本告警 `COST CRITICAL`、范围告警 `SCOPE WARNING`、文件变更通知 `was modified`）。
5. **机制层级**：用户指令 > skills > 默认行为；拦截型（GateGuard/内置约束）vs 引导型（superpowers/mnemon）之分。

---
