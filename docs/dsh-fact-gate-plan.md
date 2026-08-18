# dsh-fact-gate 插件方案：在 DSH 上复刻 Claude Code 内置约束 + GateGuard 机制

> 文档日期：2026-08-17（2026-08-18 更新：全部期次实现完成 + push 审查与 compaction 钩子真机验证通过）
> 状态：**已实现并真机验证（2026-08-18）**——一期 4 门、二期（push 审查/范围告警/重复读）、三期（成本告警/项目配置/compaction 钩子）全部落地；push 审查经四层根因排查后真机全链路打通（详见 11.6），compaction 钩子经扫描点演进（pre-step → +turn-stopping → +timer 兜底）后真机注入验证通过
> 参考源：本仓库 docs/claude-code-constraints-and-gateguard.md（CC 机制文字还原）+ dsh 运行时源码 D:\Pycharm\PycharmProjects\deepseek-harness（rc.5，与 rc.6 API 一致）+ 本机 dsh-ecc 0.3.4 插件源码 + GateGuard 原始实现 ~/.claude/skills/everything-claude-code/scripts/hooks/gateguard-fact-force.js（1278 行）与 shell-substitution.js
> 已确认决策：① 独立插件（非扩展 dsh-ecc）② 默认 deny（hooksDeny 语义）③ 一期 4 门全做 ④ 可行性评估先行（本文第 4 章）⑤ sub-agent 豁免采用方案 A（全局监听 + exec.agent 判定）

---

## 1. 背景与目标

本机 Claude Code 环境运行着两套叠加的约束机制（详见源文档）：

1. **Claude Code 内置约束**（harness 运行时强约束，不可关，5 条）
2. **GateGuard（Fact-Forcing Gate）**（everything-claude-code 插件 PreToolUse hook，可关，4 道事实强制门）

目标是开发一个 **dsh 标准插件 dsh-fact-gate**，在 DeepSeek Harness 上复刻这两套机制的效果，并保留 CC 生态的配套机制（mnemon hooks / push 后安全审查 / 范围告警）中 dsh 尚缺失的部分。

---

## 2. 源机制梳理（CC 侧）

### 2.1 Claude Code 内置约束（5 条）

| # | 机制 | 行为 | 本质 |
|---|------|------|------|
| ① | 改前必读 | 对未读过的文件 Edit/Write 直接失败，提示先 Read | harness 维护"会话已读文件集合"，写前校验 |
| ② | 不可重复读取未变更文件 | 已读且未变更的文件再 Read，返回 "file unchanged since your last Read" | 记录文件内容 hash + 状态，复用上下文 |
| ③ | 工具结果即事实 | 调用成败以返回值为准，禁止编造未发生的工具结果 | harness 行为 + 模型纪律 |
| ④ | 后台任务结果不可预测 | sub-agent 完成前禁止报告其结果，只能"仍在运行" | task-notification 事件推送，此前不可断言 |
| ⑤ | 权限模式 | 按 permission mode 放行/拒绝；被拒后调整方案而非原样重试 | settings.json permissions |

> 注：原第⑥条"先展示证据再断言"并非 harness 内置，而是 GateGuard 拦截输出被当作"用户反馈"注入后的交互效应。

### 2.2 GateGuard（Fact-Forcing Gate）

**核心理念**："LLM 自我评估没用——问'你违反政策了吗'答案永远是'没有'。但问'列出所有 import 此模块的文件'会逼它跑 Grep 和 Read。**调查行为本身创造了自我评估永远无法创造的上下文。**"（A/B 测试：平均 9.0 vs 6.75，+2.25 分）

**三阶段门**：DENY（拦截第一次）→ FORCE（明确告知要收集哪些事实）→ ALLOW（展示事实后重试放行）

**四道门**：

| 门 | 触发 | 要求展示的事实 |
|----|------|----------------|
| Edit 门 | 每文件**首次**被编辑 | ① 列出所有 import/require 此文件的文件 ② 列受影响的公开函数/类 ③ 若读写数据文件，展示字段名/结构/日期格式（脱敏/合成值）④ 引用用户当前指令原文 |
| Write 门 | 首次新建文件 | ① 命名将调用此新文件的文件与行 ② 确认无既有文件承担同一用途 ③ 数据文件结构（同 Edit）④ 用户指令原文 |
| Destructive Bash 门 | **每次**破坏性命令 | ① 此命令将修改/删除的所有文件与数据 ② 一行回滚步骤 ③ 用户指令原文 |
| Routine Bash 门 | 会话内**第一次** Bash | ① 当前用户请求（一句话）② 此命令验证/产生什么 |

**破坏性检测 5 层**（isDestructiveBash）：
1. SQL/dd 短语正则（先 stripQuotedStrings 剥引号防 commit 误报 + explodeSubshells 展开 $()/反引号防绕过）
2. 操作员自定义正则（GATEGUARD_BASH_EXTRA_DESTRUCTIVE，懒编译 + env 缓存，非法正则仅警告不 crash）
3. find -exec 检测（collectExecutableBodies 提取命令体 → 按 ;|& 切段 → 匹配 find ... -exec rm 类）
4. rm / git 破坏性检测（tokenize 后：rm + 递归/强制标志；git 子命令 reset --hard / push --force / clean -f 等）
5. quote-aware 第二遍（封堵"引号命令字 / 换行分隔 / 引号 find-exec / sh -c 前缀"四类绕过，GHSA-4v57-ph3x-gf55）

辅助解析器（shell-substitution.js）：extractCommandSubstitutions（$()）/ extractSubshellGroups / extractBraceGroups。

**状态机**：状态目录 ~/.gateguard/（或 GATEGUARD_STATE_DIR），按会话 key 哈希命名；已检查集合上限 MAX_CHECKED_ENTRIES=500（按最近使用剪枝）；会话键上限 MAX_SESSION_KEYS=50；30 分钟无活动超时（SESSION_TIMEOUT_MS=30*60*1000）；临时文件 + rename 原子写。

**防膨胀预算**：DEFAULT_FULL_DENIALS=3——前 3 次拦截输出完整四事实块，之后压缩为单行（带 denial 序号 + 一行恢复提示），避免近重复块堆积放大模型重复循环。

**豁免**：只读 git 内省命令（status/diff/log 等）直放行；Claude settings 路径；GATEGUARD_EXEMPT_GLOBS 豁免路径（支持 **）；sub-agent 调用（父会话已过首触门）。

**逃生开关**：ECC_GATEGUARD=off 完全禁用；ECC_DISABLED_HOOKS 按 hook 禁用；GATEGUARD_ROUTINE_BASH=off 关 routine 门（destructive 门仍生效）；拦截消息自带 (ECC_GATEGUARD=off disables this gate.) 恢复提示。

### 2.3 配套机制（4 类）

1. **mnemon 4-hook**：SessionStart=prime（预热）/ UserPromptSubmit=user_prompt（每消息召回）/ PreCompact=compact（压缩前沉淀）/ Stop=stop（收尾）——注册于 settings.json hooks，调用 mnemon CLI recall。
2. **security-guidance 插件**：git push 后（PostToolUse）后台审查 commits，生成 vulns_found + affected files + 逐条 severity/建议修复；"不得仅因内部服务而 dismiss"。
3. **superpowers skills**（引导型）：using-superpowers（1% 可能适用某 skill 就必须先调用）/ brainstorming / systematic-debugging / verification-before-completion / TDD / executing-plans 等。
4. **PostToolUse 跟踪**：成本告警（COST CRITICAL，超 $50 阈值）/ 范围告警（SCOPE WARNING：N files modified）/ 文件外部变更通知（was modified，重置已读状态）。

---

## 3. dsh 现状对照

dsh 侧现状（检查依据：dsh-ecc 0.3.4 源码 lib/index.js、dsh-mnemon 插件实测、dsh-balance、skill 体系）：

| CC 机制 | dsh 现状 | 状态 |
|---------|----------|------|
| 内置① 改前必读 | **dsh-ecc 已实现**（read-before-write 门，lib/index.js:87-94；本会话实测拦截过 write 未读文件） | ✅ 已生效 |
| 内置② 重复读去重 | 无 | ⚠️ 可软实现（可选开关） |
| 内置③ 工具结果即事实 | harness 天然行为 | ✅ |
| 内置④ 后台不可预测 | subagent 完成通知机制一致（dsh 后台 subagent 有独立完成通知） | ✅ |
| 内置⑤ 权限模式 | settings.yaml permission.defaultPreset（danger-full-access / workspace-write）+ 审批提示 | ✅ 已有（当前会话为放开态） |
| GateGuard Edit/Write 门 | dsh-ecc 只有纪律门（读/验），**无事实强制清单** | ❌ 核心缺口 |
| GateGuard Destructive/Routine Bash 门 | 无 | ❌ 核心缺口 |
| GateGuard 状态机/预算/豁免 | 有 state dir / 豁免路径 / hooksDeny 开关；无 budget 压缩、无 500/50/30min | ⚠️ 部分 |
| mnemon 4-hook | **dsh-mnemon 已实现**（每 turn 委派记忆子代理，读写已实测通过） | ✅ |
| security-guidance push 审查 | 无（仅手动 code-review-checklist skill） | ❌ 二期 |
| superpowers | 已有等价 skill 体系（mandatory-workflow 7 步 / code-review-checklist / tdd-workflow 等） | ✅ |
| PostToolUse 成本/范围 | dsh-balance 有成本展示；范围告警/文件变更通知无 | ⚠️ 二期 |

**分工设计**：dsh-ecc 管"纪律门"（改前必读、改后必验）；dsh-fact-gate 管"事实强制门"（调查行为强制）。两者叠加 = CC 的"内置约束 + GateGuard"组合。职责单一、可独立开关、不阻塞 dsh-ecc 升级。

---

## 4. 可行性评估（源码级证据）

> 结论先行：**一期 4 门全做 100% 可行**。每个关键能力都有 dsh 运行时源码中的 API 定义或专门测试保证，且 dsh-ecc 已在本机以同一 API 实际运行。

### 4.1 API 依据清单

| 方案能力 | 依赖的 dsh API | 源码证据 |
|----------|----------------|----------|
| 工具调用前拦截（DENY） | ctx.on('tools/pre-execute', (exec, next) => ...)，返回 {kind:'deny', reason} 或 {kind:'allow'} 或 next() | 事件签名：packages/core/tools/src/index.ts:152；deny 用法示例：packages/core/tools/tests/tools.spec.ts:1659；端到端插件权限模式测试：packages/core/agent-loop/tests/interception.spec.ts:692（describe: "native-plugin permission pattern, end-to-end through the loop"） |
| deny 消息回到模型（FORCE 生效的前提） | deny 以绑定错误（binding rejection）形式到达调用方 | packages/core/tools/tests/code-mode.spec.ts:1001 "a tools/pre-execute deny reaches the program as a binding rejection"；interception.spec.ts:740 同类 |
| 读取工具名/参数/cwd（判定 Edit/Write/pwsh） | exec 对象：{callId, name, arguments, cwd/agent} | exec 结构含 {callId, name, arguments, agent}：packages/core/scope/tests/invariant.spec.ts:80；dsh-ecc 已在用（exec.name/exec.arguments/exec.cwd，lib/index.js:60-75） |
| 三阶段门 + 重试放行 | 插件内状态（Set + 状态文件），无额外 API | dsh-ecc knownFiles Set 同款模式（本机已运行） |
| 状态机（checked≤500、会话键≤50、30min 超时、原子写） | 纯 node:fs，无 API 限制 | dsh-ecc 用 STATE_DIR = ~/.dsh/dsh-ecc 先例（lib/index.js:26） |
| sub-agent 豁免（方案 A） | 全局监听 + exec.agent 判定调用方身份 | exec 携带 agent：scope/invariant.spec.ts:80；agent 级 scoped 监听只 gate 自己的 agent：packages/core/tools/tests/scoped.spec.ts:266 |
| settings 实时开关（deny/warn/profile、逃生） | ctx.settings.register(NS, schema, {applies:'live'}) | dsh-ecc lib/index.js:38（本机实测：settings.yaml 修改实时生效） |
| 破坏性命令 5 层检测器 | 纯函数移植，零 API 依赖 | 原实现本机存在：~/.claude/skills/everything-claude-code/scripts/hooks/gateguard-fact-force.js + shell-substitution.js，可整模块移植并适配 dsh 工具面 |
| PostToolUse（二期） | ctx.on('tools/post-execute', (exec, result, next)) | packages/core/tools/tests/code-mode.spec.ts:666；examples/acp-agent/tests/fixtures/workspace-context-compaction.ts:11 |
| 会话级挂载（二期） | ctx.on('agent/created', ({agent}) => ...) / agent/turn-stopping | packages/preset/agent-presets/src/index.ts:166；packages/core/agent/tests/agent.spec.ts:326 |

### 4.2 实测证据

本会话中，dsh-ecc 的 read-before-write 门实际拒绝了对 pnpm-workspace.yaml 的 write（报错："cannot overwrite existing ... without reading it first"），完整 reason 进入我的上下文；补 read 后重试即通过。**这正是 GateGuard DENY→FORCE→ALLOW 闭环在 dsh 上真实运转的证明**——dsh-fact-gate 复用的是同一条事件管道，只是把拦截判定从"纪律"升级为"事实强制"。

### 4.3 差异点与设计决策（如实说明）

| 差异 | CC 侧 | dsh 侧 | 设计决策 |
|------|-------|--------|----------|
| 命令工具面 | Bash | pwsh（命令在 arguments.command）+ run_code（TS 代码） | 一期只 gate pwsh（与 Bash 门对应）；run_code 列入二期探索（检测 rm/fs.unlink/child_process 等危险 API 模式），正则检测不可靠故不做首期 |
| MultiEdit | 存在（逐文件独立判定） | 无此工具 | 不需要 MultiEdit 分支，Edit 门天然逐文件 |
| sub-agent 豁免 | 父会话已过首触门，子代理直接放行 | 全局监听会连子代理一起 gate | **已定方案 A**：全局 tools/pre-execute 监听 + exec.agent 判定：若调用方是子代理（且其父链已过门）则放行，行为与 CC 完全一致 |
| 工具结果即事实 / 后台不可预测 | harness 内置 | harness 行为一致 | 插件无法强制（与 CC 相同，CC 也是 harness 内置），可在拦截消息中附带提醒（如"等待完成通知再汇报"）作为辅助 |
| 重复读去重（内置②） | harness 内置 | read 无去重 | 二期可选实现（pre-execute 对 read 计算 hash + 返回提示），**默认关闭**（避免与子代理/其他插件 read 语义冲突） |

---

## 5. 插件设计（dsh-fact-gate）

### 5.1 总体架构

```
dsh-fact-gate/
├── src/
│   ├── index.ts            # 插件入口：settings 注册、tools/pre-execute 挂载、状态注入
│   ├── gates.ts            # 四道门判定（Edit/Write/Destructive/Routine）+ 三阶段编排
│   ├── detect-destructive.ts  # 破坏性命令检测（5 层，移植自 gateguard-fact-force.js）
│   ├── shell-substitution.ts  # 命令解析（extractCommandSubstitutions/SubshellGroups/BraceGroups，整模块移植）
│   ├── state.ts            # 状态机（checked 集合、会话键、超时、原子写、剪枝）
│   ├── messages.ts         # 四门消息模板 + 压缩单行模板（逐字移植）
│   └── settings.ts         # settings schema（enabled/deny/profile/exemptGlobs/...）
├── lib/                    # 构建产物（提交，git 安装免构建）
├── tests/                  # node:test 单元测试
├── cordis.patch.yml        # bundle patch（挂载插件行）
├── dsh.plugin.json         # 插件元数据
└── package.json            # dsh.bundle.patch 声明（dsh-plugin-orchestra 同款工程）
```

### 5.2 事件挂载与拦截流

```ts
export function apply(ctx, config) {
  const scope = ctx.settings.register('fact-gate', SettingsSchema, { applies: 'live' })
  ctx.on('tools/pre-execute', async (exec, next) => {
    // 0) 逃生/开关判定：disabled / profile=none / deny=false → next()
    // 1) 工具归一化：edit/write → Edit/Write；pwsh → Bash
    // 2) sub-agent 豁免（方案 A）：exec.agent 为子代理 → next()
    // 3) 豁免路径（~/.dsh、temp、exemptGlobs、git 内省）→ next()
    // 4) 按门判定：
    //    - Edit/Write：isChecked(filePath) ? next() : markChecked + deny(FORCE 清单)
    //    - Bash：只读 git 内省 → next()
    //           isDestructive(command) && !isChecked(destructiveKey) → deny(破坏性清单)
    //           !isChecked('__bash_session__') → deny(routine 清单)
    //    - 其他工具 → next()
    // 5) denial 计数 → 第 4+ 次输出压缩单行
  }, { prepend: true })
}
```

拦截消息通过 deny 的 reason 注入模型上下文，模型展示事实后重试同一操作即放行（isChecked 命中）。

### 5.3 四道门规格

**Edit 门**（每文件首次编辑，isChecked(filePath) 为假时触发；多文件操作逐文件独立判定）：
- 要求展示：① 列出所有 import/require 此文件的文件（搜索树 Glob/Grep）② 受影响公开函数/类 ③ 数据文件字段/结构/日期格式（脱敏或合成值）④ 用户当前指令原文
- 首次拦截展示事实重试即放行

**Write 门**（首次新建文件）：
- ① 命名将调用此新文件的文件与行 ② 确认无既有文件承担同一用途（搜索树验证）③ 数据文件结构 ④ 用户指令原文

**Destructive Bash 门**（**每次**破坏性命令，key = '__destructive__' + sha256(command)[:16]）：
- ① 此命令将修改/删除的所有文件与数据 ② 一行回滚步骤 ③ 用户指令原文
- 与 routine 门不同：不是每会话一次，每次破坏性命令都拦（展示事实重试放行）

**Routine Bash 门**（会话第一次 Bash，key = '__bash_session__'）：
- ① 当前用户请求（一句话）② 此命令验证/产生什么

### 5.4 破坏性命令检测（5 层，移植规格）

按优先级：
1. **SQL/dd 短语正则**：/\b(drop\s+table|delete\s+from|truncate|dd\s+if=)\b/i；先 stripQuotedStrings（剥引号串防 commit message 误报）+ explodeSubshells（展开 $()/反引号防绕过）再匹配
2. **操作员自定义破坏性正则**：settings bashExtraDestructive（env FACT_GATE_BASH_EXTRA_DESTRUCTIVE 兼容）；懒编译 + 缓存，非法正则视为未配置并记录 warning，绝不 crash
3. **find -exec 检测**：collectExecutableBodies 提取命令体 → 按 ;|& 切段 → 匹配 find ... -exec rm 类
4. **rm / git 破坏性检测**（tokenize 后）：rm + 递归/强制标志；git 子命令 reset --hard / push --force / clean -f 等
5. **quote-aware 第二遍**：封堵"引号命令字 / 换行分隔 / 引号 find-exec / sh -c 前缀"四类绕过（对应 GHSA-4v57-ph3x-gf55）

### 5.5 状态机规格

- 状态目录：~/.dsh/fact-gate/（FACT_GATE_STATE_DIR 可覆盖）
- 状态文件：按会话 key 哈希命名（sanitize + hash），随会话 key 轮换
- 已检查集合：上限 MAX_CHECKED_ENTRIES=500，超限按最近使用剪枝
- 会话键上限：MAX_SESSION_KEYS=50
- 超时：30 分钟无活动会话过期
- 原子写：临时文件 + rename

### 5.6 Denial 预算与压缩

- FULL_DENIALS=3（settings fullDenials 可覆盖）：前 3 次拦截输出完整四事实块；第 4 次起压缩为单行（带 denial 序号 + 一行恢复提示），防近重复块堆积

### 5.7 豁免清单

- 只读 git 内省（git status/diff/log 等不修改命令）→ 直接放行（不触发 routine 门）
- ~/.dsh 路径、系统临时目录（与 dsh-ecc 豁免一致）
- settings 路径（本插件的 settings.yaml 等）
- FACT_GATE_EXEMPT_GLOBS（逗号分隔 glob → 正则，支持 ** 跨段）
- sub-agent 调用（方案 A：exec.agent 判定）

### 5.8 逃生开关与配置（settings.yaml）

```yaml
fact-gate:
  enabled: true          # 总开关（false = 完全放行）
  deny: true             # false = 仅告警不拦截（warn 模式）
  profile: full          # none = 关闭
  fullDenials: 3         # 全块拦截预算，之后压缩单行
  exemptGlobs: []        # 豁免路径 glob
  bashExtraDestructive: []  # 自定义破坏性正则
  routineBashEnabled: true  # false = 关 routine 门（destructive 门仍生效）
  enabledHooks: [edit, write, destructive-bash, routine-bash]  # 按门禁用
```

环境变量兼容：FACT_GATE=off（= enabled:false）、FACT_GATE_ROUTINE_BASH=off、FACT_GATE_EXEMPT_GLOBS。拦截消息自带恢复提示 (FACT_GATE=off disables this gate.)。

### 5.9 消息模板（逐字移植源文档 3.8 节）

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

**压缩单行（第 4 次起）**：
```
[Fact-Forcing Gate] (denial #{n} this session) First {action} of {file_path}: briefly state importers/callers, affected API, data schemas if any, and the user's verbatim instruction, then retry. (FACT_GATE=off disables this gate.)
```

（中文界面下可提供中英双语模板，默认英文与 CC 一致）

### 5.10 sub-agent 豁免（方案 A，已确认）

全局 tools/pre-execute 监听；当 exec.agent 指向子代理时，检查其父链是否已过首触门（继承父会话 checked 状态），放行 Edit/Write；与 CC 行为一致：父会话已过首触门，子代理不重复拦截。

---

## 6. 二期规划（基于 tools/post-execute）

1. **push 后安全审查**：post-execute 检测 git push → 委派子代理跑安全审查（复用 code-review-checklist 清单：认证/IDOR/硬编码密钥/SQL 注入/资源泄漏），生成 vulns_found + severity + suggested fix 报告注入会话；"不得仅因内部服务而 dismiss" 原则写入审查 prompt
2. **范围告警**：post-execute 统计会话修改文件数，超阈值注入 SCOPE WARNING: N files modified this session... 提示
3. **重复读软化**（内置约束②）：pre-execute 对 read 计算文件 hash，未变更返回 "unchanged" 提示——**默认关闭**的可选开关
4. **run_code 危险 API 检测**（探索）：检测代码字符串中的 fs.unlink/rm、child_process、process.kill 等危险模式（启发式，仅告警）

---

## 7. 工程计划

### 7.1 移植来源（本机现成）

| 源 | 路径 | 说明 |
|----|------|------|
| GateGuard 主实现 | ~/.claude/skills/everything-claude-code/scripts/hooks/gateguard-fact-force.js（1278 行） | 四门判定、状态机、预算、豁免逻辑 |
| shell 解析 | ~/.claude/skills/everything-claude-code/scripts/lib/shell-substitution.js | 命令解析工具（可整模块复用） |
| 工程模板 | D:\Pycharm\PycharmProjects\dsh-plugin-orchestra | dsh 标准 bundle 插件工程（package.json dsh.bundle.patch、cordis.patch.yml、lib/ 提交、dsh.plugin.json） |

### 7.2 仓库与安装

- 仓库：新建 D:\Pycharm\PycharmProjects\dsh-fact-gate，发布至 GitHub（如 github:HiNEM66/dsh-fact-gate）后可一行安装：dsh plugin --profile web add github:HiNEM66/dsh-fact-gate（或显式 git+https:// 依赖 + pnpm-workspace.yaml allowBuilds 配置，参照 dsh-plugin-orchestra 既有流程）
- 与 dsh-ecc 共存：两插件互不依赖；dsh-ecc 管纪律门、fact-gate 管事实门

### 7.3 测试与验证

1. **单元测试**（node:test，参照 dsh-plugin-orchestra 12/12 模式）：破坏性检测器逐层用例（含 4 类绕过）、状态机（500 剪枝/50 会话键/30min 超时/原子写）、budget 压缩、豁免判定
2. **集成测试**：注入伪 exec 事件断言 deny/allow 决策
3. **实测**：web profile 安装后，真实会话中触发 Edit 门/破坏性 Bash 门，验证 DENY→FORCE→ALLOW 闭环与消息注入
4. 与 dsh-ecc 的 read-before-write 门叠加验证（无冲突、无双重拦截混乱）

### 7.4 里程碑

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M1 | 工程骨架 + settings + pre-execute 挂载（先跑通 deny→next 管道） | web profile 可挂载、开关生效 |
| M2 | 移植检测器（shell-substitution + 5 层）与 4 门判定 | 单测全绿 |
| M3 | 状态机 + budget + 豁免 + 逃生 | 单测全绿 |
| M4 | 真机实测调优（消息长度、误报率、与 dsh-ecc 叠加） | 实测拦截记录 |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 误拦（破坏性误报） | 模型卡在 gate 前 | 只读 git 内省白名单 + 豁免 glob + warn 模式逃生 + 压缩单行提示恢复 |
| 上下文膨胀（重复拦截消息） | 模型重复循环 | denial 预算（3 次全块→单行），与 CC 同款 |
| run_code 绕过 pwsh 门 | 破坏性操作绕过检测 | 二期探索启发式检测；一期文档明示边界 |
| 与 dsh-ecc 双重拦截 | 消息混乱 | 职责分离（纪律 vs 事实），消息格式统一 [Fact-Forcing Gate] 前缀可区分 |
| 子代理被误拦 | 并行任务卡死 | 方案 A 豁免（exec.agent 判定），单测覆盖 |
| deny reason 长度 | 上下文消耗 | 模板精简 + 压缩单行 |

---

## 9. 决策记录

| 决策点 | 结论 | 状态 |
|--------|------|------|
| 独立插件 vs 扩展 dsh-ecc | **独立插件 dsh-fact-gate** | ✅ 已确认 |
| 默认模式 | **deny**（与 dsh-ecc hooksDeny=true 一致） | ✅ 已确认 |
| 一期范围 | **4 门全做**（Edit/Write/Destructive/Routine + 状态机 + budget + 豁免 + 逃生） | ✅ 已确认 |
| 可行性 | 核心能力有源码级证据支撑（第 4 章），一期 100% 可行 | ✅ 已评估 |
| sub-agent 豁免 | **方案 A**：全局监听 + exec.agent 判定（与 CC 行为一致） | ✅ 已确认 |
| run_code | 一期不 gate，二期探索 | ⏳ 待定 |
| 重复读软化 | 二期可选，默认关闭 | ⏳ 待定 |
| 文档/消息语言 | 默认英文（与 CC 一致），可中英双语 | ⏳ 待定 |

---

## 10. 独立评估报告（2026-08-17，源码级逐条验证）

> 评估方式：对 deepseek-harness 源码 + 已安装插件（dsh-ecc/dsh-plugin-orchestra）+ CC 插件缓存做并行探测，逐条核对方案第 4 章的 API 证据与移植来源。

### 10.1 结论

| 评估项 | 结论 |
|---|---|
| 方案可行性 | ✅ 可行 — 引用的 13 条 dsh API 证据逐一验证，全部属实且行号精确命中 |
| 一期 4 门完整移植 | ✅ 可行（Edit/Write/Destructive/Routine + 状态机 + 预算 + 豁免 + 逃生） |
| 插件安装后能力等价性 | ⚠️ 约 95% 等价 — 3 个固有差异（2 平台差异 + 1 配套缺口）无法完全消除 |
| 最大风险 | 🔴 GateGuard 移植来源本机缺失（第 7.1 章"本机现成"前提不成立） |

### 10.2 API 证据验证（第 4.1 章 13 条全绿）

```
tools/pre-execute (index.ts:152)
  → PreToolDecision { allow | deny(reason) | ask } (index.ts:588-591)
  → deny reason 物化为 "Error: {reason}" 工具错误回模型 (index.ts:1486-1498)
  → 模型看到错误 → 展示事实 → 重试 → isChecked 放行   [DENY→FORCE→ALLOW 闭环]
```

| # | 方案引用 | 验证结果 |
|---|----------|----------|
| 1 | pre-execute 签名 index.ts:152 | ✅ 精确命中；`@mode waterfall`，scope-filtered dispatch |
| 2 | deny 示例 tools.spec.ts:1659 | ✅ 命中；测试名 "a pre-execute deny short-circuits before tools/execute" |
| 3 | binding rejection code-mode.spec.ts:1001 | ✅ 命中；deny reason 到达 SDK 绑定调用方 |
| 4 | exec 结构 invariant.spec.ts:80 | ✅ 命中；`{callId, name, arguments, agent?}`，agent 可选 |
| 5 | post-execute code-mode.spec.ts:666 / workspace-context-compaction.ts:11 | ✅ 双命中 |
| 6 | scoped 监听 scoped.spec.ts:266 | ✅ 命中；"gates only its own agent" |
| 7 | settings live register | ✅ 存在（包路径 `packages/settings/settings/src/index.ts:34-41,435`，非方案写的 packages/core/settings） |
| 8 | 端到端 interception.spec.ts:692 | ✅ 命中；worked example NativeGuard 即同款插件形态 |
| 9 | agent/created | ✅ 存在（core/agent/src/index.ts:561 发布；dsh-ecc 已在用） |
| 10 | agent/turn-stopping | ✅ 存在（agent.spec.ts:326） |
| 11 | subagent 完成通知 | ✅ settlement notice（continuation.ts:1400-1449，source.kind='subagent-settled'，等价 CC task-notification） |
| 12 | 安装→加载→挂载链路 | ✅ dsh plugin add → pnpm → reconcilePlugins 自动入 bundles → loadProfile → composeProfile → Loader 激活（app-boot/profile.ts + profile-boot.ts） |
| 13 | 工程模板 | ✅ dsh-plugin-orchestra 完整（TS 源码 + lib 提交 + node:test + dsh.plugin.json + cordis.patch.yml） |

补充确认：dsh-ecc 已用同一管道实际运行（settings live + pre-execute deny + STATE_DIR + agent/created），方案 4.2 实测证据属实；其 read-before-write 门是本地 patch（~/.dsh/patches/），PR #8/#9 已合并上游。

### 10.3 方案与事实的差异（6 处）

| # | 差异 | 影响与处置 |
|---|---|---|
| 1 | 🔴 **GateGuard JS 源码本机不存在**：`gateguard-fact-force.js`(1278 行) + `shell-substitution.js` 全盘搜无；`~/.claude/skills/ecc/gateguard/` 仅 133 行 SKILL.md（声称 hook 在插件内但实际无 scripts/）；everything-claude-code marketplace 缓存残缺（仅 .git/FETCH_HEAD + objects，无 HEAD/工作树，不可恢复） | 第 7.1 章"移植来源本机现成"**不成立**。补救见 10.5 |
| 2 | 工具参数 snake_case：`write{file_path,content}`、`edit{file_path,old_string,new_string}`、`pwsh{command,...}`（非 camelCase） | 实现时按 exec.arguments 实际键名取 |
| 3 | 第三写工具 `str_replace_editor`（command: view/create/str_replace/insert，参数 path） | 建议一期覆盖（与 edit/write 同门语义） |
| 4 | settings 包路径 | `packages/settings/settings`（小偏差，不影响） |
| 5 | interception.spec.ts:740 是 deny 示例非 binding-rejection 测试 | 两处引用均真实（小偏差） |
| 6 | `exec.agent` 可选字段（无 subject 调用为 undefined） | 方案 A 豁免需兜底：`delegationDepthOf(exec.agent) > 0`（官方 helper，packages/subagent/subagent/src/depth.ts）或 `exec.agent?.session.header.origin === 'subagent'` |

### 10.4 能力等价性（安装后）

**完全等价（一期 4 门）**：write/edit 工具面存在（file_path 可从 exec.arguments 取）；pwsh.arguments.command 可跑 5 层检测器（仅工具名 Bash→pwsh）；三阶段门有测试双证；状态机/预算/豁免/逃生为纯 node 实现；sub-agent 豁免方案 A 进程内完全一致。

**固有差异（无法完全消除）**：

| 差异 | 性质 | 说明 |
|---|---|---|
| `run_code` 工具不 gate | dsh 平台差异 | dsh 特有工具（CC 无对应），一期放行 = 绕过 pwsh 门的旁路；二期启发式检测，一期文档明示边界 |
| 进程外子 agent 豁免局限 | dsh 平台差异 | spawn/claude-code provider 子 agent 在独立进程运行，父进程插件看不到其工具调用——不误拦但不参与门判定，跨进程"完全一致"无法保证 |
| PreCompact 无对应 | 配套缺口 | hooks-claude-code 兼容层支持 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop，**无 PreCompact**——mnemon compact.sh 沉淀无挂载点，需挂 agent/turn-stopping 或原生实现 |

**额外利好**：dsh 的 hooks-claude-code 兼容层可桥接 CC 现有 hooks.json（mnemon 4-hook 中 3 个可直接跑）；settlement notice 与 CC task-notification 等价（内置约束④有对应机制）。

### 10.5 移植来源修正（替代 7.1）

**原方案假设"本机现成"不成立**，但**远程获取已实测验证可行**（2026-08-17）：

1. **远程获取（✅ 已验证）**：`git clone --depth 1 --filter=blob:none --sparse https://github.com/affaan-m/everything-claude-code` + `sparse-checkout set scripts/hooks scripts/lib` 成功——整仓 clone 会超时（网络慢），sparse + blob:none filter 只拉必要对象，秒级完成。已取得并归档到 `D:\Pycharm\PycharmProjects\dsh-fact-gate-src\`：
   - `gateguard-fact-force.js` — **1278 行**（与方案 7.1 声称完全一致），5 层检测/状态机/预算/豁免/消息模板组件全部在位（抽查确认）
   - `shell-substitution.js` — 510 行（extractCommandSubstitutions/SubshellGroups/BraceGroups）
   - raw.githubusercontent.com 单文件下载被 429 限流，git sparse clone 是可靠路径
2. **文字重建（回退）**：源文档（claude-code-constraints-and-gateguard.md）第 3 章对 5 层检测/状态机数值（500/50/30min/原子写）/预算（3 次全块→单行）/豁免/消息模板有足够详细的文字还原，可实现行为等效；风险是边界正则细节有偏差。
3. **行为自实现（最重）**：按 SKILL.md 133 行 + 源文档规格自行实现，仅作最后手段。

> 无论哪条路径，都需将 JS → TS/ESM、适配工具面（Bash→pwsh、snake_case 参数）、适配 deny 语义（CC hook 是 stderr 注入，dsh 是 deny reason 返回）——远程源码价值是行为参考与正则来源，非直接复用。

### 10.6 补充建议

1. 一期 Edit 门覆盖 `str_replace_editor`（第三写工具，成本低收益高）
2. 文档明示 3 个固有差异（run_code 旁路 / 进程外子代理 / PreCompact），避免"完全一样"预期落差
3. 配套机制二期优先级：PostToolUse 范围告警 > push 安全审查 > 重复读去重 > run_code 检测

### 10.7 移植策略（已拍板：M1 一步到位原生 TS）

> 决策（2026-08-17）：① 跳过 M0 薄包装，直接原生 TS 插件 ② `str_replace_editor` 纳入一期 Edit 门 ③ `run_code` 一期加危险 API 关键词告警（不 deny，post-execute attach context）

#### 10.7.1 源码现状（已归档 dsh-fact-gate-src/）

- `gateguard-fact-force.js`（1278 行，CJS 单文件）：入口 `run(rawInput)`，输入 CC hook 形状 `{tool_name, tool_input, session_id, subagent_id?}`，输出 `{stdout: JSON.stringify({hookSpecificOutput:{permissionDecision:'deny', permissionDecisionReason}})}` 或原样返回（allow）
- `shell-substitution.js`（510 行）：extractCommandSubstitutions / extractSubshellGroups / extractBraceGroups

#### 10.7.2 适配映射表（CC hook 协议 → dsh exec）

| CC 字段 | dsh 来源 | 映射 |
|---|---|---|
| `data.tool_name` | `exec.name` | 同名直映（edit/write）；`bash`→`pwsh`；新增 `str_replace_editor` |
| `data.tool_input.file_path` | `exec.arguments.file_path` | 同键（dsh 即 snake_case） |
| `data.tool_input.command` | `exec.arguments.command` | 同键（pwsh 参数名即 command） |
| `data.tool_input.edits` | — | dsh 无 MultiEdit，删分支 |
| `data.session_id`（状态键） | `exec.agent.id` | agent.id === session.id（官方统一） |
| `data.subagent_id`（子代理豁免） | `delegationDepthOf(exec.agent) > 0` | 官方 helper（subagent/src/depth.ts） |
| deny 输出 `hookSpecificOutput.permissionDecisionReason` | `{kind:'deny', reason}` | reason 即消息文本（含恢复提示） |

#### 10.7.3 搬运 vs 重写

| 类别 | 内容 | 方式 |
|---|---|---|
| 整段搬运（TS 化） | 5 层破坏性检测（~400 行）+ 3 个 shell 解析器（510 行）+ 消息模板 5 个（~150 行）+ 状态机（checked/剪枝/超时/原子写 ~300 行） | 逐函数搬运，行为对照原 JS |
| 必须重写（适配层） | exec→CC 形状转换、deny reason 输出、会话键（agent.id）、子代理判定（delegationDepthOf）、工具映射表（含 str_replace_editor：command in ['str_replace','insert','create'] 时按 Edit 门）、状态目录 ~/.dsh/fact-gate、环境变量 FACT_GATE* | ~200 行全新 |
| 一期新增 | run_code 危险 API 告警（post-execute）：检测代码字符串 fs.unlink/rm、child_process、process.kill 等 → `PostToolDecision {kind:'accept', additionalContexts:[告警消息]}` 注入模型，不 deny | ~80 行 |

#### 10.7.4 单测清单（照 dsh-plugin-orchestra node:test 模式）

1. 破坏性检测器逐层用例（含 4 类绕过：引号命令字/换行分隔/引号 find-exec/sh -c 前缀）
2. 状态机：500 剪枝 / 50 会话键 / 30min 超时 / 原子写
3. budget 压缩（第 4 次起单行）
4. 豁免判定：只读 git 内省 / 豁免 glob / settings 路径 / sub-agent（delegationDepthOf）
5. 工具映射：edit/write/str_replace_editor/pwsh/run_code 各分支
6. run_code 告警：危险 API 命中 → additionalContexts；安全代码 → 静默

#### 10.7.5 里程碑（M1 单期）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1.1 | 工程骨架（照 dsh-plugin-orchestra）+ 搬运检测器/解析器/模板/状态机 | 单测全绿 |
| M1.2 | 适配层（exec 转换/deny/会话键/子代理/工具映射）+ run_code 告警 | 单测全绿 |
| M1.3 | 真机实测（web profile 安装）：Edit 门/破坏性 pwsh 门/run_code 告警 三场景 | 实测拦截记录 + 与 dsh-ecc 叠加无冲突 |

---

## 11. 实施状态更新（2026-08-18）

### 11.1 一期（M1）— ✅ 已完成

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1.1 | 工程骨架 + 搬运（shell 解析器 510 行 / 检测器 5 层 / 状态机 / 消息模板） | ✅ |
| M1.2 | 适配层（exec 转换/deny/会话键/子代理/工具映射）+ run_code 告警 | ✅ |
| M1.3 | 真机实测（headless + web2） | ✅ 四门拦截闭环验证 |

**真机调试沉淀的 4 个根因**（均已修复）：
1. SettingsScope 是 `{get()}` 对象非函数（对照 dsh-ecc lib/index.js:38-49）
2. additionalContexts 需 `createUserMessage({content: ContentBlock[], source})`（对照 interception.spec.ts:745-753）
3. `exec.agent` 可选字段 → delegationDepthOf(undefined) 抛错
4. **hoisted 双实例**：@deepseek-ai 运行时依赖装到 profile 根 → dsh 内部模块 import 命中副本 → `TOOL_RUNTIME_SCHEDULER` symbol 不匹配 → 'prepare' undefined。**修复：运行时零 @deepseek-ai 依赖**（内联纯函数 + 依赖移 dev）

**外部审查发现的盲区**：pwsh 原生 cmdlet（Remove-Item 等）逃过 bash 形态检测 → 内置 12 个破坏性 cmdlet（层 4/5 并列）。

### 11.2 二期 — ✅ 已完成

| 功能 | 文件 | 行为 |
|---|---|---|
| 范围告警 | scope-warning.ts | 会话内 N 文件（默认 20）→ SCOPE WARNING，每会话一次 |
| 重复读软化 | duplicate-read.ts | 默认 OFF；未变更重读 → 'File unchanged' 提示（不 deny） |
| push 安全审查 | push-review.ts | git push 成功 → 子代理审查（认证/IDOR/密钥/SQL/泄漏/SSRF）→ JSON 报告注入；失败降级。**双路径触发**：native 模式 `tools/post-execute` + code mode `tools/code-dispatch-log`（真机验证，见 11.6） |
| run_code 检测 | run-code-advisory.ts | 一期已做（危险 API → advisory context） |

**设计约束**：`subagents` 兄弟 entry 服务走 `ctx.get()` 非严格读（strict 读抛 without inject；声明 inject 会让插件在无该服务的 profile PENDING 卡死）；`subagents.start()` 返回 `SubagentRun` 句柄，结果在 `run.result: Promise<SubagentResult>`（dsh-subagent types.ts:204），结束 `run.dispose()`。

### 11.3 测试与验证

- **54/54 单测全绿**（检测 5 层 + pwsh cmdlet + 状态机 + 预算 + 豁免 + 工具映射 + 四门 + 告警 + 二期三模块 + push 命令匹配 + schema 关键字守护 + compaction 扫描）
- headless 真机：Write 门拦截（4 事实）、破坏性门拦截（rm + Remove-Item，目标/回滚/指令）、routine 门、DENY→FORCE→ALLOW 闭环
- **web profile 真机（2026-08-18）**：门禁全链路 + push 安全审查双路径触发 + 子代理 structured_output 收敛 + 注入消息（两次 push 各审一次，第二次审出 4 个问题）
- GitHub: `github.com/HiNEM66/dsh-fact-gate`（master 最新）

### 11.4 三期 — ✅ 已完成

| 功能 | 文件 | 行为 |
|---|---|---|
| 成本告警 | cost-warning.ts | session/event 的 assistant/message.usage 累加（usage 随消息同行，types.ts:265-273）→ 超阈值（默认 1M tokens）注入 COST WARNING，每超一次告警 |
| 项目配置 | project-config.ts | `.fact-gate.yml` 项目级配置（GateGuard `gateguard init` 对应物）；process.cwd() 加载 + agent/created 按会话 cwd 刷新；已知键合并覆盖 settings |
| compaction 钩子 | compaction.ts + index.ts | **压缩后通知**（Claude Code PreCompact 的可达等价）：增量扫描 `agent.session.events` 发现新 `compaction/start` → 注入 "context was compacted" 通知。三个扫描点：`agent/pre-step`（waterfall，必须 next()）+ `agent/turn-stopping` + **timer 兜底**（30s 轮询所有 attached agent）——`/compact` 经 command 通道完成（command/done 是 session 事件非 cordis 事件），通常无后续 step/turn，前两扫描点不触发（真机测试5 实证），timer 保证 ≤30s 注入。`compaction/start` 是 session.append 写入事件流（compaction-basic region.ts:189）——"压缩前动作钩子"在 dsh 无可靠信号（压缩决策在 pre-step 监听器内部，无预告事件）；压缩后通知是可达的最大等价物。默认 OFF（compactionNotice） |

**平台限制（文档化）**：文件外部变更通知（CC was-modified）——dsh 无内置文件 watcher，自建成本高误报风险大，不实现。

**验证**：54/54 单测全绿 + web profile 真机加载正常 + 运行时零 @deepseek-ai 依赖保持（yaml 为非 @deepseek-ai 依赖，无副本风险）。

### 11.5 期次规划

| 期 | 内容 | 状态 |
|---|---|---|
| 一期 | 4 门 + 状态机 + run_code 告警 | ✅ |
| 二期 | 范围告警 + 重复读 + push 审查 | ✅（push 审查 2026-08-18 真机全链路验证） |
| 三期 | 成本告警 + 项目配置 + compaction 钩子 | ✅（compaction 2026-08-18 以 agent/pre-step 扫描方案落地） |
| 四期（视需求） | 进程外子代理语义对齐 / run_code 全语义检测 / 市场发布与文档站点 / 与 dsh-mnemon 深度集成 | ⏳ 待定 |

### 11.6 push 审查真机排查记录（2026-08-18，四层根因）

web profile 真机测试中 push 审查不触发，逐层排查定位四层独立根因（均已修复并验证）：

| 层 | 根因 | 修复 |
|---|---|---|
| 1 | **code mode 命令载体错位**：`CodeDispatchLog.exec` 是外层 run_code 执行（arguments = {code, description}），插件读 `exec.arguments.command` 恒 undefined（会话日志里序列化的 arguments.command 是内层参数副本，误导排查方向） | 命令来源改 `exec.arguments.code`（内层调用以 `tools.pwsh({command: \`git ${...} push\`})` 存在于 code 程序）+ 新增按行宽松匹配 `isGitPushCommandLax`（模板变量无法静态展开，误报由 `->` 成功标志兜底） |
| 2 | **PUSH_REVIEW_SCHEMA 的 `minimum` 关键字不被 provider 支持**：subagents.start 抛 JsonSchemaError（支持子集：type/oneOf/properties/required/additionalProperties/items/enum/const + annotations） | 移除 `vulns_found.minimum`；守护测试断言 schema 不再含 unsupported 关键字 |
| 3 | **start 结果读取协议错误**：`subagents.start()` 返回 `SubagentRun` 句柄（{id, localAgent, result, dispose}），结果在 `run.result: Promise<SubagentResult>` 异步 settle；插件直接读 `run.output/run.structured/run.stopReason` 全是 undefined → 判空返回 → 无注入，子代理孤跑 | `await run.result` 拿 SubagentResult（{output, stopReason, structured?}），finally `run.dispose()` |
| 支撑 | **插件日志真机无痕**：harness 未挂 console exporter，logger 只进内存 buffer——排查期间所有静默失败路径不可见 | 临时磁盘诊断日志（`<stateDir>/fact-gate-debug.log`，排查完成后移除，插件保持零额外日志） |

**排查方法论沉淀**：① 真机与本地复现的差异可能藏在"事件对象形状"（复现用伪造 dispatch 带 arguments.command，真机是 run_code 载体——形状不一致误导验证）；② 静默失败路径必须有可观测性（磁盘日志一轮定位）；③ 类型文档是协议（SubagentResult "resolved by SubagentRun.result" 原文）——读 API 文档先于猜字段。
