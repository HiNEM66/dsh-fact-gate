# dsh-fact-gate

Fact-Forcing Gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a native cordis plugin that ports **Claude Code's GateGuard** (PreToolUse fact-forcing hook) and its surrounding guardrails to the dsh runtime: DENY→FORCE→ALLOW gates on file edits, destructive shell commands, and first-command discipline, plus scope/cost warnings, push security review, duplicate-read softening, project-level config, and compaction notices.

> "LLM 自我评估没用——问'你违反政策了吗'答案永远是'没有'。但问'列出所有 import 此模块的文件'会逼它跑 Grep 和 Read。**调查行为本身创造了自我评估永远无法创造的上下文。**"（GateGuard A/B 测试：平均 9.0 vs 6.75，+2.25 分）

---

## 功能总览

### 一期：四道事实强制门（GateGuard 移植）

| 门 | 触发 | 要求展示的事实 |
|---|---|---|
| Edit 门 | 每文件**首次**被编辑（`edit`、`str_replace_editor` str_replace/insert） | ① import/require 此文件的文件清单 ② 受影响公开函数/类 ③ 数据文件字段/结构/日期格式（脱敏）④ 用户指令原文 |
| Write 门 | 每文件**首次**创建（`write`、`str_replace_editor` create） | ① 将调用此新文件的文件与行 ② 确认无既有同用途文件 ③ 数据结构 ④ 用户指令原文 |
| Destructive 门 | **每次**破坏性命令 | ① 将修改/删除的文件与数据 ② 一行回滚步骤 ③ 用户指令原文 |
| Routine 门 | 会话内**第一次**命令 | ① 当前用户请求（一句话）② 此命令验证/产生什么 |

**三阶段闭环**：DENY（拦截首次）→ FORCE（明确要收集的事实清单，deny reason 注入模型上下文）→ ALLOW（展示事实后重试放行，`isChecked` 命中）。

**破坏性检测 5 层**（移植自 GateGuard `isDestructiveBash`，逐逻辑搬运）：
1. SQL/dd 短语正则（先剥引号防 commit 误报 + 展开 `$()`/反引号防绕过）
2. 操作员自定义正则（`bashExtraDestructive`，懒编译 + 非法正则 fail-open）
3. `find -exec` 检测（跨语法 BFS 提取可执行体）
4. `rm` / `git` 破坏性检测（token 化：rm -r -f、reset --hard、push --force、clean -f 等）
5. quote-aware 第二遍（封堵引号命令字/换行分隔/引号 find-exec/sh -c 包装四类绕过，GHSA-4v57-ph3x-gf55）

**PowerShell 原生 cmdlet 检测**（dsh 命令面适配，外部审查发现的盲区）：`Remove-Item` / `Remove-ChildItem` / `Remove-ItemProperty` / `Remove-PSSnapin` / `Clear-Content` / `Clear-Item` / `Clear-RecycleBin` / `Clear-Disk` / `Format-Volume` / `Format-Disk` / `Initialize-Disk`（12 个，与 bash 检测并列于层 4/5）。

### 二期：配套守卫

| 功能 | 行为 |
|---|---|
| 范围告警 | 会话内编辑 N 文件（默认 20）→ `SCOPE WARNING` 注入，每会话一次 |
| push 安全审查 | `git push` 成功后委派子代理审查（认证/IDOR/硬编码密钥/SQL 注入/资源泄漏/SSRF，"不得仅因内部服务而 dismiss"）→ 结构化 JSON 报告注入；失败降级不阻塞 |
| 重复读软化（默认 OFF） | 未变更文件重读 → `File unchanged since your last Read` 提示（不 deny——read 工具契约） |
| run_code 告警 | 代码含危险 API（fs.unlink/child_process/process.kill 等）→ advisory context（不 deny） |

### 三期：成本/配置/压缩

| 功能 | 行为 |
|---|---|
| 成本告警 | `session/event` 的 `assistant/message.usage` 累加（usage 随消息同行）→ 超阈值（默认 1M tokens）注入 `COST WARNING` |
| 项目配置 | `.fact-gate.yml` 项目级覆盖（`gateguard init` 对应物），按会话 cwd 动态刷新 |
| compaction 钩子 | `compaction/start` 事件（dsh 的 PreCompact 等价物）→ 压缩前注入保留提示 |

### 基础设施

- **状态机**：`~/.dsh/fact-gate/state-<sessionKey>.json`（按 agent.id 哈希）；500 checked 条目 / 50 会话键 / 30 分钟超时 / 临时文件 + rename 原子写 / 过期文件清理
- **Denial 预算**：前 3 次拦截输出完整四事实块，之后压缩单行（带序号 + 恢复提示），防上下文膨胀
- **豁免**：只读 git 内省（status/diff/log/show/branch/rev-parse）、settings 路径、`exemptGlobs`（支持 `**`）、子代理调用（`delegationDepthOf > 0`）
- **逃生**：`FACT_GATE=off` 完全禁用；settings `enabled:false` / `profile:none` / 按门 `enabledHooks`；`FACT_GATE_ROUTINE_BASH=off` 关 routine 门
- **warn-only 模式**：`deny:false` 时命中门不拦截，改为 post-execute 附加 context 告警
- **settings live 重载**：settings.yaml 修改即时生效（`applies:'live'`）

---

## 安装

```bash
dsh plugin --profile web add github:HiNEM66/dsh-fact-gate
```

或本地依赖（`file:`）+ `dsh.profile.bundles` 追加 `dsh-fact-gate`（见 dsh-plugin-orchestra 流程）。

## 配置（`~/.dsh/settings.yaml`，live 重载）

```yaml
fact-gate:
  enabled: true            # 总开关（env FACT_GATE=off 也生效）
  deny: true               # false = warn-only（附加 context 不拦截）
  profile: full            # 'none' = 关闭
  fullDenials: 3           # 全块拦截预算，之后压缩单行
  exemptGlobs: []          # 豁免路径 glob（** 跨段）
  bashExtraDestructive: [] # 自定义破坏性正则（层 2）
  routineBashEnabled: true # false = 关 routine 门（destructive 仍生效）
  enabledHooks: [edit, write, destructive-bash, routine-bash]
  runCodeAdvisory: true    # run_code 危险 API 告警
  scopeWarningThreshold: 20  # 范围告警阈值（0 = 关）
  duplicateRead: false     # 重复读软化（默认关）
  pushReviewEnabled: true  # push 安全审查
  pushReviewProvider: ''   # 子代理 provider（空 = 第一个注册的）
  pushReviewMaxCommits: 5
  costWarningThreshold: 1000000  # 会话 token 告警阈值（0 = 关）
  compactionNotice: true   # 压缩前提示
```

**项目级配置**（`<项目根>/.fact-gate.yml`，覆盖用户 settings）：

```yaml
deny: false
scopeWarningThreshold: 10
```

---

## 架构与实现

```
src/
├── index.ts              # 插件入口：settings 注册 + pre/post-execute 挂载 + agent 级钩子
├── gates.ts              # 四门判定 + 工具映射（edit/write/str_replace_editor/pwsh/bash）
├── detect-destructive.ts # 破坏性检测 5 层 + pwsh cmdlet 12 个 + 只读 git 内省豁免
├── shell-substitution.ts # 命令解析器（$()/子 shell/brace 组，510 行 JS 搬运）
├── state.ts              # 状态机（500/50/30min/原子写/denial budget）
├── messages.ts           # 四门消息模板（逐字移植）
├── run-code-advisory.ts  # run_code 危险 API 扫描
├── scope-warning.ts      # 范围告警
├── duplicate-read.ts     # 重复读软化
├── push-review.ts        # push 安全审查（子代理委派）
├── cost-warning.ts       # token 成本告警
├── project-config.ts     # .fact-gate.yml 项目配置
└── settings.ts           # schemastery settings schema
```

### dsh API 依据（deepseek-harness 源码验证）

| 能力 | API | 源码位置 |
|---|---|---|
| 工具调用前拦截 | `ctx.on('tools/pre-execute', (exec, next) => PreToolDecision)` | packages/core/tools/src/index.ts:152 |
| deny 语义 | `PreToolDecision = {allow} \| {deny; reason} \| {ask}` | index.ts:588-591 |
| deny 注入模型 | deny → `Error: {reason}` 工具错误结果 | index.ts:1486-1498 |
| post 附加 context | `ctx.on('tools/post-execute', (exec, result, next) => PostToolDecision)` | index.ts:175 |
| 注入消息形状 | `createUserMessage({content: ContentBlock[], source})` | packages/llm/llm/src/message.ts:192（内联） |
| settings live | `ctx.settings.register(NS, Schema, {applies:'live'})` | packages/settings/settings/src/index.ts:435 |
| 子代理豁免 | `delegationDepthOf(exec.agent) > 0` | packages/subagent/subagent/src/depth.ts:28-36（内联） |
| push 审查委派 | `ctx.subagents.start(provider, request)` | packages/subagent（inject 注入） |
| token usage | `session/event` 的 `assistant/message.usage` | packages/core/session/src/types.ts:265-273 |
| 压缩前事件 | `compaction/start` session event | packages/compaction/compaction-basic/src/region.ts:189 |

### 关键设计约束

**运行时零 @deepseek-ai 依赖**——这是本插件最重要的架构决策（见"调试历程"#4 的 hoisted 双实例根因）。`@deepseek-ai/*` 包仅作为 `import type`（编译 elide）或 devDependencies；`delegationDepthOf` / `createUserMessage` / `deepFreeze` 内联为本地纯函数。运行时依赖只有 `@deepseek-ai/schemastery`（schema）与 `yaml`（项目配置解析），均无 symbol 机制、无副本风险。

---

## 与 Claude Code 的能力对照

### 已实现（≈95% 可移植面）

| CC 机制 | dsh-fact-gate | 等价性 |
|---|---|---|
| GateGuard Edit/Write/Destructive/Routine 四门 | ✅ 四门 + 三阶段闭环 | 语义等价（真机验证 DENY→FORCE→ALLOW） |
| GateGuard 状态机/预算/豁免/逃生 | ✅ 同机制移植 | 等价 |
| 内置约束② 不可重复读 | ⚠️ duplicate-read.ts（默认 OFF，hint 非强制） | 软实现 |
| 内置约束③④⑤ | ✅ harness 天然行为 | 等价 |
| security-guidance push 审查 | ✅ push-review.ts（子代理 + 清单 prompt） | 功能等价 |
| 成本告警 | ✅ cost-warning.ts（token 计数，非美元） | 量纲不同 |
| 范围告警 | ✅ scope-warning.ts | 等价 |
| PreCompact | ✅ compaction/start 钩子 | 事件等价 |
| mnemon 4-hook | ✅ dsh-mnemon 已有 | 等价 |

### 平台限制（未实现）

| 项 | 原因 |
|---|---|
| **文件外部变更通知**（CC `was modified`） | dsh 无内置工作区文件 watcher——全仓 chokidar/fs.watch 仅覆盖框架配置层（settings/credentials/skills/HMR）。插件自建需对照工具写入轨迹排除自身修改，编辑器/linter 后台运行会误报，信噪比不划算，判定不做 |
| **进程外子代理语义对齐** | spawn/claude-code provider 的子代理在独立进程运行，父进程插件看不到其工具调用——既不参与门判定也不豁免（平台架构差异） |

### 差异说明（平替后的细微差别）

1. **重复读**：CC 是 harness 强制（直接返回 unchanged），本插件是 post-execute 附加 hint（read 正常返回结果）——模型自律而非强制
2. **成本告警**：CC 显示美元成本，本插件用 token 计数（无单价表，运营商自行换算）
3. **run_code**：dsh 特有工具（CC 无对应），本插件做告警不拦截——仍是 pwsh 门的旁路

---

## 调试历程（真机根因沉淀）

| # | 报错 | 根因 | 修复 |
|---|---|---|---|
| 1 | `settings is not a function` | `SettingsScope` 是 `{get()}` 对象非函数 | `scope.get()`（对照 dsh-ecc lib/index.js:38-49） |
| 2 | `tool_calls must be followed by tool messages` | additionalContexts 传 OpenAI 形状（字符串 content + 无 source）→ 畸形 UserMessage 注入会话 | `createUserMessage({content: ContentBlock[], source})`（对照 interception.spec.ts:745-753） |
| 3 | `Cannot read properties of undefined (reading 'options')` | `exec.agent` 可选字段，无 subject 调用为 undefined → `delegationDepthOf(undefined)` 抛错 | 先判空再调用 |
| 4 | `Cannot read properties of undefined (reading 'prepare')` | **hoisted 双实例**：`@deepseek-ai` 运行时依赖装到 profile 根 node_modules → dsh-headless 的 agent-loop import 命中副本 → `TOOL_RUNTIME_SCHEDULER`（模块级 symbol）不匹配 → scheduler undefined | **运行时零 @deepseek-ai 依赖**（内联纯函数 + 依赖移 dev） |

外部审查发现的盲区：PowerShell 原生 `Remove-Item` 逃过 bash 形态检测（实测删除成功）→ 内置 12 个 pwsh 破坏性 cmdlet。

---

## 测试

51/51 单测全绿（node:test，直接测构建产物）：

- 破坏性检测 5 层逐层（含 4 类绕过 + pwsh cmdlet 12 个 + 引号绕过）
- 状态机（500 剪枝/50 会话键/30min 超时/原子写/合并）
- denial budget 压缩（第 4 次起单行）
- 豁免判定（git 内省/glob/settings 路径/子代理）
- 工具映射（edit/write/str_replace_editor 三分支/pwsh/run_code）
- warn-only 模式、DENY→FORCE→ALLOW 重试放行
- run_code 告警、范围告警、重复读、push 审查、成本告警、项目配置

真机验证（headless + web profile）：Write 门拦截（4 事实）、破坏性门拦截（rm + Remove-Item，目标/回滚/指令）、routine 门、DENY→FORCE→ALLOW 闭环、列目录/读写文件正常。

```bash
npm test          # 单测
npm run build     # tsc → lib/
```

---

## 期次规划

| 期 | 内容 | 状态 |
|---|---|---|
| 一期 | 4 门 + 状态机 + run_code 告警 | ✅ |
| 二期 | 范围告警 + 重复读 + push 审查 | ✅ |
| 三期 | 成本告警 + 项目配置 + compaction 钩子 | ✅ |
| 四期（待定） | 进程外子代理语义对齐 / run_code 全语义检测 / 市场发布与文档站点 / 与 dsh-mnemon 深度集成 | ⏳ 视需求 |

完整设计与评估记录见 [flex-ate-framework docs/dsh-fact-gate-plan.md](https://github.com/HiNEM66/flex-ate-framework/blob/master/docs/dsh-fact-gate-plan.md)。

## License

MIT
