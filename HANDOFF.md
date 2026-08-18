# dsh-fact-gate 开发交接文档 — push 安全审查修复历程

> 生成时间：2026-08-18（会话二结束，A 方案已落地 master `91a56b8`）
> 用途：新会话接手本任务时的完整上下文（前因后果、测试方法、改动、验证、遗留）

---

## 1. 项目背景

- **插件**：`dsh-fact-gate`（`C:\Code\dsh-fact-gate`，GitHub: `HiNEM66/dsh-fact-gate`）
- **宿主**：deepseek-harness（`C:\Code\deepseek-harness-src`，dsh CLI）
- **功能**：四道事实强制门（Edit/Write/Destructive/Routine）+ DENY→FORCE→ALLOW 闭环 + 状态机 + 范围/成本告警 + push 安全审查 + run_code 告警 + 项目配置
- **本插件核心架构约束**：运行时零 `@deepseek-ai` 依赖（hoisted 双实例会破坏 symbol 一致性）；`apply` 必须箭头函数（cordis isConstructor 误判）；兄弟 entry 服务必须 `ctx.get()` 非严格读取
- **测试基线**：51/51 单测（`node --test tests/*.test.mjs`）+ 真机（dsh web profile）

## 2. 本次任务：push 安全审查真机验证与修复

### 2.1 功能设计（原）

`git push` 成功后，post-execute 钩子检测 → 委派子代理审查最近 N 个提交（六项清单：auth/IDOR、密钥、注入、资源泄漏、SSRF + "内部服务不得 dismiss"）→ 结果 JSON 附加到工具结果。

### 2.2 三轮真机测试的失败历程

| 轮次 | 会话 | 现象 | 根因 |
|------|------|------|------|
| 1 | session-33d47ae9 | 3 个子代理全 max-tokens 终止零产出 | `maxTokens: 4000` 单步太小 + high reasoning（继承父会话）+ prompt 无范围约束（16 步通读全仓） |
| 2 | session-37849bf2 | 6-7 个子代理全 max-tokens 零产出 | 同上（虽已改 32000，但 **web profile 装的是旧版 4000**）；且 agent 网络重试（CreateFileMapping/连接失败）每次触发一个子代理白烧 |
| 3 | session-505a06b3 | **0 个子代理，审查完全不触发** | **结构性根因（A 方案发现）**：dsh web 是 **code mode**——所有工具经 `run_code` 子调度，内层 `pwsh` 的 post-execute 由 code-mode driver 内部消化（`code-mode.ts:365-390`），插件 post-execute 只收到 `run_code` 外层 exec → 匹配 `pwsh/bash` 的 push 分支永远不命中 |

### 2.3 已落地的修复（master 历史）

| commit | 内容 |
|--------|------|
| `8ae8fb9` | prompt 重构（只审 diff）+ maxTokens 4000→32000（第一版修复，真机验证仍失败） |
| `1fc28dd` | **outputSchema 结构化收敛**（`structured_output` 工具强制 + `PUSH_REVIEW_SCHEMA`）+ maxTokens 改不传（继承父 256k，serialize.ts 证实不传=不发送 max_tokens）+ 触发条件升级（stdout 含 `->`/`new branch`）+ HEAD 去重 |
| `41f50ba` | **A 方案落地**：code-mode push 审查 — `tools/code-dispatch-log` waterfall 路径 |

## 3. A 方案技术细节（当前实现，master `91a56b8`）

### 3.1 双路径触发

```
native 模式: post-execute (exec.name === 'pwsh'|'bash') → maybePushReview(exec, JSON.stringify(result), exec.agent)
code 模式:   tools/code-dispatch-log waterfall → maybePushReview(dispatch.exec, content文本, dispatch.agent)
```

### 3.2 关键机制（源码依据）

- **`tools/code-dispatch-log`**（`packages/core/tools/src/index.ts:189`）：waterfall 事件，插件可监听。`CodeDispatchLog` 含 `exec/agent/subCallId/name/isError/content`，content 是子调用完整渲染输出（实测含 `0e3a287..3361171 -> ...` 成功标志）
- **命令在 exec.arguments.command**（content 是输出文本，不含 "git push" 字样——第一版 e2e 失败的坑）
- **waterfall 必须 `return next()`**：它坐在日志落盘路径上，不能阻塞；监听器只检测 + fire-and-forget
- **结果注入**：code mode 无 post-execute decision 可返回 → 审查完成后 `agent.inject(createUserMessage(...))`（与 cost warning 同款模式）
- **outputSchema**（`packages/subagent/subagent-in-process-driver/src/structured.ts`）：子代理被强制调 `structured_output` 工具提交、调用即 `concludeTurn()`、capture 后 guard 屏蔽其他工具 → 必然产出校验 JSON。`run.structured` 优先取值，fallback 文本解析
- **maxTokens 不传**：子代理继承父会话 256k（`child-agent.ts` 只覆盖显式字段；`serialize.ts` 证实 undefined = 不发送 max_tokens）。`max-tokens` 是 sticky 的（`agent.ts:285-290`：单步触顶整个 turn 终止）——所以传小值必死，不传最优雅
- **HEAD 去重**：`reviewedPushHeads` Map（sessionKey → `push:<targetHash>`），相同 HEAD 重试跳过，新 HEAD 必审，解析失败保守降级（宁可多审）

### 3.3 修改的文件

- `src/index.ts`：`maybePushReview` 共享函数 + code-dispatch-log 监听器 + post-execute 分支改造 + `reviewedPushHeads` Map
- `src/push-review.ts`：`PUSH_REVIEW_SCHEMA` + prompt Step 3 对齐工具调用（原手写 JSON 与 structured 强制指令冲突已消除）
- `README.md`：待更新（见遗留项）

### 3.4 验证状态

- ✅ tsc 全绿；51/51 单测
- ✅ 5 项 code-dispatch e2e（真实 cordis，临时脚本已删）：成功触发注入 / 失败不触发 / 同 HEAD 去重 / 异 HEAD 各审 / waterfall 不破坏日志
- ❌ **真机复测尚未完成**（A 方案代码刚 push，用户还没在 dsh web 里重装验证）

## 4. 新会话接手步骤

### 4.1 复测（真机）

1. 重装最新 master（用户需执行）：
   ```bash
   pnpm dsh plugin --profile web remove dsh-fact-gate
   pnpm dsh plugin --profile web add github:HiNEM66/dsh-fact-gate
   grep -n "code-dispatch-log" "C:\Users\nsghiguo\.dsh\profiles\web\node_modules\dsh-fact-gate\lib\index.js"  # 应命中
   pnpm dsh --profile web
   ```
2. 新会话让 agent 在 `test/push-review` 分支改 README + commit + push
3. **成功标志**：push 后 agent 会话出现 `[Fact-Forcing Gate] Push security review:` 消息（经 agent.inject 注入）；子代理 ≤5 步收敛（structured_output 强制）
4. 导出 session log 验证：`tool/code-dispatch` 记录含 `->`；子代理有 `structured_output` 工具调用且 `turn/end reason: completed`

### 4.2 已知风险与待确认

- **`tools/code-dispatch-log` 的 scope 过滤**：文档说 agent-scoped listener 只收自己 agent 的 dispatch；插件 fiber 非 agent-scoped 应收全部——**真机唯一风险点**，如收不到需查 `@deepseek-ai/dsh-scope` 的 scopeTarget 过滤（`dsh-scope lib:327-345` 同款机制，session/event 的坑）
- **`agent.inject()` 在审查完成时的可用性**：agent 可能已结束 turn/会话——注入失败需降级（静默或 logger.warn）
- **e2e 临时脚本已删**，如需重跑：`tests/fact-gate.test.mjs` 是唯一保留的测试；code-dispatch e2e 需重写（参照本文档 3.4 的 5 项）

### 4.3 遗留项

1. **README 更新**（未做）：push 审查新增 code-mode 支持说明 + outputSchema 结构化说明；"已实现"对照表 push 审查行补真机验证状态
2. **测试分支清理**：`test/push-review` 分支（本地+远程）测试完删除；注意 master 已含 `3361171 test: push review 验证占位提交 3`（README 占位注释，真机测试 agent 加的）——**需确认已清理**（上一轮合并时只清了冲突，3361171 的 README 改动可能还在）
3. **`attachMessage` 在 native 路径的返回**：`maybePushReview` 返回 boolean 后 native post-execute `return next()`——审查结果走 agent.inject 而非 attachMessage，native 模式的注入方式与 code 模式统一了（行为变化，README/测试需确认）

## 5. 关键源码位置速查

| 组件 | 位置 |
|------|------|
| dsh 插件入口 | `C:\Code\dsh-fact-gate\src\index.ts` |
| push 审查模块 | `src/push-review.ts` |
| code-dispatch-log 事件 | `C:\Code\deepseek-harness-src\packages\core\tools\src\index.ts:189` |
| code-mode driver | `packages/core/tools/src/code-mode.ts`（post-execute 内部消化 365-390；子调度日志 512-521） |
| structured runtime | `packages/subagent/subagent-in-process-driver/src/structured.ts` |
| max-tokens sticky | `packages/core/agent-loop/src/agent.ts:285-290` |
| maxTokens 序列化 | `packages/llm/llm-deepseek/src/serialize.ts:184` |
| 子代理继承 | `packages/subagent/subagent/src/child-agent.ts:75-82` |

## 6. 本插件既有踩坑（防再犯）

1. **apply 必须箭头函数**（cordis isConstructor 误判，`new apply` 崩溃）
2. **兄弟 entry 服务必须 `ctx.get()`**（strict 读抛 without inject；settings/subagents/agents 全是兄弟 entry）
3. **运行时零 @deepseek-ai 依赖**（hoisted 双实例破坏 symbol 一致性）
4. **store 作用域事件不可达**（session/event、compaction/start——插件 fiber 收不到）
5. **code mode 下 post-execute 只收 run_code 外层**（内层子调用走 code-dispatch-log）
6. **max-tokens sticky**：传小值必死，不传（继承）最优雅
7. **e2e 必须用独立 `FACT_GATE_STATE_DIR`**（磁盘状态跨场景污染）
8. **git push 触发要看 stdout 成功标志**（`->`），不能信 `!result.isError`（重试脚本 exit 0 吞错）
