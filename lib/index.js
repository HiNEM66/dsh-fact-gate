/**
 * dsh-fact-gate — Fact-Forcing Gate plugin for DeepSeek Harness.
 *
 * Port of Claude Code's GateGuard PreToolUse hook (gateguard-fact-force.js,
 * 1278 lines) to a native dsh cordis plugin. DENY→FORCE→ALLOW gates on:
 *   - edit / write / str_replace_editor  (per-file first touch)
 *   - pwsh destructive commands          (per command)
 *   - pwsh routine (first per session)   (once per session)
 *   - run_code danger-API advisory       (post-execute context attach, no deny)
 *
 * dsh API usage (verified against deepseek-harness source):
 *   - ctx.on('tools/pre-execute', (exec, next) => PreToolDecision)
 *       packages/core/tools/src/index.ts:152
 *       PreToolDecision = {allow} | {deny; reason} | {ask}  (index.ts:588-591)
 *       deny reason materializes as "Error: {reason}" tool result the model
 *       sees (index.ts:1486-1498) — the FORCE step of the gate.
 *   - ctx.on('tools/post-execute', (exec, result, next) => PostToolDecision)
 *       index.ts:175; additionalContexts on accept injects a user message
 *       into the next model request (advisory path).
 *   - ctx.settings.register(NS, Schema, { applies: 'live' })
 *       packages/settings/settings/src/index.ts:435; live = settings.yaml
 *       edits apply without restart (dsh-ecc precedent, lib/index.js:38).
 *   - exec.agent (optional) carries the initiating Agent; sub-agents are
 *       exempt via delegationDepthOf(exec.agent) > 0
 *       (packages/subagent/subagent/src/depth.ts:28-36; exec.agent set at
 *        packages/core/agent-loop/src/tool-calls.ts:67-79).
 */
import { randomUUID } from 'node:crypto';
import { decideGate } from "./gates.js";
import { compileExemptGlobs, isGateGuardDisabled, isRoutineBashGateDisabled } from "./detect-destructive.js";
import { FactGateStateStore, resolveSessionKey, getFullDenialBudget } from "./state.js";
import { withRecoveryHint, EDIT_WRITE_HOOK_ID, BASH_HOOK_ID } from "./messages.js";
import { scanDangerApis, dangerAdvisoryMessage } from "./run-code-advisory.js";
import { ScopeWarningTracker } from "./scope-warning.js";
import { DuplicateReadTracker } from "./duplicate-read.js";
import { CostWarningTracker } from "./cost-warning.js";
import { loadProjectConfig, mergeProjectConfig } from "./project-config.js";
import { isGitPushCommand, PUSH_REVIEW_PROMPT, PUSH_REVIEW_SCHEMA, formatReviewMessage } from "./push-review.js";
import { FACT_GATE_NS, FactGateSettings, FACT_GATE_HOOKS } from "./settings.js";
export const name = 'fact-gate';
// NOTE: 只注入 settings。subagents/agents 由 dsh-base bundle 的兄弟 entry
// 提供（subagent 行 / agent 行），当前 context 的 strict 属性读会抛
// "cannot get property without inject"（cordis reflect.ts:144-164）；同时
// subagents 在 profile 层可被移除，声明 inject 会让插件在缺少该服务时
// PENDING 卡死。统一走 ctx.get() 容错（见 apply 内 runPushReview）。
export const inject = ['settings'];
export const Config = FactGateSettings;
// Tool-surface mapping: dsh tool name → gate category.
const WRITE_TOOLS = new Set(['write']);
const EDIT_TOOLS = new Set(['edit']);
const STR_REPLACE_EDITOR = 'str_replace_editor';
const SHELL_TOOLS = new Set(['pwsh', 'bash']);
const RUN_CODE_TOOL = 'run_code';
/** Inline of dsh-subagent depth.delegationDepthOf (packages/subagent/subagent/src/depth.ts). */
function delegationDepthOf(agent) {
    const runtime = agent.options.subagentDepth;
    if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
        throw new TypeError('agent subagentDepth must be a non-negative safe integer');
    }
    return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);
}
/** Recursive deep-freeze (inline of dsh-llm message.freezeMessage's deepFreeze). */
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const k of Object.keys(value)) {
            deepFreeze(value[k]);
        }
        Object.freeze(value);
    }
    return value;
}
/**
 * Inline of dsh-llm message.createUserMessage (packages/llm/llm/src/message.ts:192):
 * complete content + source + fresh stable identity + freeze, role 'user'.
 */
function createUserMessage(input) {
    return deepFreeze(structuredClone({
        ...input,
        id: `msg-${randomUUID()}`,
        role: 'user',
    }));
}
// NOTE: apply 必须是箭头函数（无 prototype）— cordis fiber.ts:251 的
// isConstructor() 对普通 function 返回 true，会把 apply 当类构造器用
// `new apply(ctx, config)` 调用（实测崩溃：`new apply` 栈 + "cannot get
// property without inject"）。dsh-ecc 同款坑，箭头函数是唯一修法。
export const apply = (ctx, config) => {
    // ── Settings (live) + env fallbacks ──
    // SettingsScope is an object with get()/watch()/update() — NOT callable.
    // (packages/settings/settings/src/index.ts:103-116; dsh-ecc lib/index.js:38-49
    // wraps scope.get() the same way.)
    const scope = ctx.settings.register(FACT_GATE_NS, FactGateSettings, { applies: 'live' });
    // Phase-3: project-level .fact-gate.yml overlays the user settings
    // (loaded from the process cwd; refreshed per agent when its cwd differs).
    let projectConfig = loadProjectConfig(process.cwd());
    const s = () => mergeProjectConfig(scope.get(), projectConfig);
    const stateStore = new FactGateStateStore(process.env.FACT_GATE_STATE_DIR);
    stateStore.pruneStaleFiles();
    // Denial budget: settings `fullDenials` (live, project-overridable) takes
    // precedence; the env override is the explicit CLI escape hatch.
    const fullDenials = () => {
        const envValue = getFullDenialBudget(process.env.FACT_GATE_FULL_DENIALS);
        const cfgValue = s().fullDenials;
        return Number.isInteger(cfgValue) && cfgValue >= 0 ? cfgValue : envValue;
    };
    // Per-call warn-mode bookkeeping (warnOnly gate hits → attach at post-execute).
    const pendingWarns = new Map();
    // Push review dedup: sessionKey → last-reviewed push target HEAD (new-commit
    // pushes always review; identical retries skip — see post-execute).
    const reviewedPushHeads = new Map();
    // Env escape hatches matching the recovery hints (messages.ts withRecoveryHint):
    //   FACT_GATE_DISABLED_HOOKS — comma-separated hook ids (`pre:edit-write:fact-gate`,
    //   `pre:bash:fact-gate`) or bare gate names (`edit`, `write`, `destructive-bash`,
    //   `routine-bash`); listed hooks are treated as disabled regardless of settings.
    //   FACT_GATE_ROUTINE_BASH=off — disables the routine Bash gate (README 逃生).
    const disabledHookIds = new Set(String(process.env.FACT_GATE_DISABLED_HOOKS ?? '').split(',').map(s => s.trim()).filter(Boolean));
    function gateEnabled() {
        if (isGateGuardDisabled(process.env.FACT_GATE))
            return false;
        return s().enabled && s().profile !== 'none';
    }
    function hookEnabled(hook) {
        if (isGateGuardDisabled(process.env.FACT_GATE))
            return false;
        if (disabledHookIds.has(hook))
            return false;
        const hookId = hook === 'edit' || hook === 'write' ? EDIT_WRITE_HOOK_ID : BASH_HOOK_ID;
        if (disabledHookIds.has(hookId))
            return false;
        return s().enabledHooks.includes(hook);
    }
    function sessionKeyFor(exec) {
        return resolveSessionKey(exec.agent?.id, {
            FACT_GATE_SESSION_ID: process.env.FACT_GATE_SESSION_ID,
            FACT_GATE_PROJECT_DIR: process.env.FACT_GATE_PROJECT_DIR,
        });
    }
    function isSubagentCall(exec) {
        // exec.agent is optional (no-subject calls) — delegationDepthOf(undefined)
        // would throw (depth.ts accesses agent.options), so guard first.
        if (!exec.agent)
            return false;
        return delegationDepthOf(exec.agent) > 0;
    }
    // ── tools/pre-execute: the fact-forcing gate ──
    ctx.on('tools/pre-execute', (exec, next) => {
        if (!gateEnabled())
            return Promise.resolve(next());
        const cfg = s();
        const toolName = exec.name;
        // Map tool surface → gate category; others pass through.
        const sessionKey = sessionKeyFor(exec);
        const gateCtx = {
            store: stateStore,
            sessionKey,
            exemptMatchers: compileExemptGlobs(cfg.exemptGlobs),
            detectorConfig: {
                bashExtraDestructive: cfg.bashExtraDestructive,
                exemptGlobs: cfg.exemptGlobs,
            },
            fullDenials: fullDenials(),
            warnOnly: !cfg.deny,
            pendingWarns,
            isSubagent: isSubagentCall(exec),
        };
        // Edit/Write surface — per-gate hook gating: `enabledHooks` is checked at
        // the granularity of the gate the call would hit (edit gate vs write gate),
        // NOT for the whole branch. Mapping: edit/str_replace_editor(str_replace|insert)
        // → 'edit' hook; write/str_replace_editor(create) → 'write' hook.
        const isEditTool = toolName === 'edit' || toolName === STR_REPLACE_EDITOR;
        const isWriteTool = toolName === 'write';
        if (EDIT_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) || toolName === STR_REPLACE_EDITOR) {
            if (isWriteTool && !hookEnabled('write'))
                return Promise.resolve(next());
            if (isEditTool) {
                // str_replace_editor command decides the gate: create → write gate.
                const command = typeof exec.arguments?.command === 'string'
                    ? exec.arguments.command
                    : '';
                const gate = command === 'create' ? 'write' : 'edit';
                if (!hookEnabled(gate))
                    return Promise.resolve(next());
            }
            const decision = decideGate({ toolName, args: (exec.arguments ?? {}) }, gateCtx, exec.callId ?? '');
            if (decision.kind === 'deny') {
                return Promise.resolve({ kind: 'deny', reason: withRecoveryHint(decision.reason, [EDIT_WRITE_HOOK_ID]) });
            }
            return Promise.resolve(next());
        }
        // Shell surface (pwsh / bash) — per-gate hook gating: destructive gate
        // and routine gate are each controlled by their own enabledHooks entry
        // (a gate whose hook is off is skipped, the other still fires).
        if (SHELL_TOOLS.has(toolName)) {
            const routineHook = hookEnabled('routine-bash')
                && cfg.routineBashEnabled
                && !isRoutineBashGateDisabled(process.env.FACT_GATE_ROUTINE_BASH);
            const destructiveHook = hookEnabled('destructive-bash');
            if (!routineHook && !destructiveHook)
                return Promise.resolve(next());
            const decision = decideGate({ toolName, args: (exec.arguments ?? {}) }, { ...gateCtx, gateFilter: { destructive: destructiveHook, routine: routineHook } }, exec.callId ?? '');
            if (decision.kind === 'deny') {
                // Destructive gate has no recovery hint (upstream includeRecoveryHint: false);
                // routine gate carries hook ids for per-hook disable.
                const reason = decision.reason.includes('Destructive command detected')
                    ? decision.reason
                    : withRecoveryHint(decision.reason, [BASH_HOOK_ID]);
                return Promise.resolve({ kind: 'deny', reason });
            }
            return Promise.resolve(next());
        }
        return Promise.resolve(next());
    }, { prepend: true });
    // ── Phase-2 trackers ──
    const scopeWarning = new ScopeWarningTracker(() => ({
        enabled: s().scopeWarningThreshold > 0,
        threshold: s().scopeWarningThreshold,
    }));
    const duplicateRead = new DuplicateReadTracker(() => ({ enabled: s().duplicateRead }));
    /** Attach a context message to the tool result (correct UserMessage shape). */
    function attachMessage(text) {
        return {
            kind: 'accept',
            additionalContexts: [createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin', plugin: 'fact-gate' },
                })],
        };
    }
    /** Run a sub-agent security review of the last N commits (push review). */
    async function runPushReview(exec) {
        const cfg = s();
        if (!cfg.pushReviewEnabled)
            return null;
        // subagents is provided by a sibling entry (@deepseek-ai/dsh-subagent in
        // the dsh-base bundle); strict ctx.subagents would throw at apply time —
        // read non-strict and degrade gracefully (subagent-less profiles skip).
        const subagents = ctx.get('subagents');
        if (!subagents)
            return null;
        const providers = subagents.list();
        if (providers.length === 0)
            return null;
        // SubagentRuntime.start contract: request.parent AND request.signal are
        // REQUIRED — the in-process driver accesses both directly
        // (dsh-subagent-in-process-driver lib:156-164: request.signal.aborted,
        // resolveChildDepth(parent), captureDelegatedPolicyOverrides(parent)).
        // Missing parent → resolveChildDepth TypeError; missing signal →
        // undefined.aborted TypeError — either silently kills the review.
        // No parent (subject-less call) → skip rather than crash.
        const parent = exec.agent;
        if (!parent) {
            ctx.logger.warn('[fact-gate] push review skipped: exec.agent (parent) missing');
            return null;
        }
        const provider = cfg.pushReviewProvider || providers[0];
        try {
            // signal: 插件自持 AbortController — 绝不复用 exec.signal。
            // exec.signal 是工具调用的 caller signal, 工具收尾时被 agent-loop
            // abort (runController/tool slots 释放) → 子代理 start 复用同一
            // signal 会在审查完成前被连带取消 (实测: 子代理创建后 ~1s 被
            // turn/end aborted/parent 杀死, 审查永不产出)。自持 signal 与
            // 工具生命周期解耦, 审查独立跑完。
            const run = await subagents.start(provider, {
                label: 'fact-gate push review',
                prompt: [{ type: 'text', text: PUSH_REVIEW_PROMPT(cfg.pushReviewMaxCommits) }],
                parent: parent,
                signal: new AbortController().signal,
                // outputSchema: 结构化子代理 (dsh-subagent structured.ts) — 注册
                // structured_output 工具 + 强制指令 "Do not finish with a plain text
                // answer: only the tool call counts", 调用即 concludeTurn() + capture
                // 后 guard 屏蔽其他工具 → 必然产出经 schema 校验的 JSON, 不再发散。
                // maxTokens 不传: 子代理继承父会话 256k (child-agent.ts), 显式传值
                // 反而钳制 (serialize.ts: maxTokens undefined = 不发送 max_tokens);
                // 收敛由 outputSchema 保证, 无需数值兜底。
                outputSchema: PUSH_REVIEW_SCHEMA,
                agentOptions: {},
            });
            // structured 优先: outputSchema 满足时 provider 返回校验过的 JSON。
            // 旧路径保留: stopReason 非 completed 或 structured 缺失时回退文本解析。
            if (run.structured !== undefined) {
                return formatReviewMessage(run.structured);
            }
            const text = run.output?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '';
            if (text.trim()) {
                const jsonStart = text.indexOf('{');
                if (jsonStart >= 0) {
                    try {
                        const result = JSON.parse(text.slice(jsonStart));
                        return formatReviewMessage(result);
                    }
                    catch (_) {
                        return `[Fact-Forcing Gate] Push security review (unparsed):\n${text.slice(0, 1200)}`;
                    }
                }
                return `[Fact-Forcing Gate] Push security review:\n${text.slice(0, 1200)}`;
            }
            return null;
        }
        catch (e) {
            ctx.logger.warn(`[fact-gate] push review failed: ${String(e)}`);
            return null;
        }
    }
    // ── tools/post-execute: advisories (run_code danger API + warn-mode attach + phase-2) ──
    ctx.on('tools/post-execute', (exec, result, next) => {
        const sessionKey = sessionKeyFor(exec);
        const cfg = s();
        // run_code danger-API advisory (phase-1, no deny).
        if (RUN_CODE_TOOL === exec.name && cfg.runCodeAdvisory && gateEnabled()) {
            const code = exec.arguments?.code ?? '';
            const labels = scanDangerApis(code);
            if (labels.length > 0) {
                return Promise.resolve(attachMessage(dangerAdvisoryMessage(labels)));
            }
        }
        // warn-only mode: attach a pending gate warn to the result context.
        const warn = pendingWarns.get(exec.callId ?? '');
        if (warn) {
            pendingWarns.delete(exec.callId ?? '');
            return Promise.resolve(attachMessage(warn));
        }
        // Phase-2: scope warning — N files modified in one session.
        const scopeMsg = scopeWarning.record(sessionKey, exec.name, result.isError === true);
        if (scopeMsg) {
            return Promise.resolve(attachMessage(scopeMsg));
        }
        // Phase-2: duplicate-read softening (default OFF).
        if (exec.name === 'read' && duplicateRead.enabled()) {
            const filePath = exec.arguments?.file_path ?? '';
            const { duplicate, path } = duplicateRead.recordRead(sessionKey, filePath);
            if (duplicate) {
                return Promise.resolve(attachMessage(DuplicateReadTracker.hintMessage(path)));
            }
        }
        // Phase-2: push security review — git push completed (NATIVE mode:
        // post-execute receives the pwsh exec directly).
        if (exec.name === 'pwsh' || exec.name === 'bash') {
            const command = exec.arguments?.command ?? '';
            if (!result.isError && isGitPushCommand(command) && gateEnabled()) {
                const stdoutText = JSON.stringify(result) ?? '';
                const triggered = maybePushReview(exec, stdoutText, exec.agent);
                if (triggered)
                    return next();
            }
        }
        return Promise.resolve(next());
    }, { prepend: true });
    /**
     * Shared push-review trigger (native post-execute AND code-mode
     * code-dispatch-log paths). Detects a REAL successful push (stdout contains
     * `->` or `new branch` — failed retry scripts never match), dedups by
     * target HEAD, and starts the review subagent fire-and-forget.
     * @returns true when a review was started (caller should not double-trigger).
     */
    function maybePushReview(exec, stdoutText, agentForInject) {
        if (!gateEnabled())
            return false;
        const pushSucceeded = /->/.test(stdoutText) || /new branch/.test(stdoutText);
        if (!pushSucceeded)
            return false;
        const targetHash = /([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/.exec(stdoutText)?.[2] ?? '';
        if (!targetHash)
            return true; // parse failure: trigger (never miss a review over dedup)
        const sessionKey = resolveSessionKey(exec.agent?.id, { FACT_GATE_SESSION_ID: process.env.FACT_GATE_SESSION_ID, FACT_GATE_PROJECT_DIR: process.env.FACT_GATE_PROJECT_DIR });
        const key = `push:${targetHash}`;
        if (reviewedPushHeads.get(sessionKey) === key)
            return false; // same HEAD retry — skip
        reviewedPushHeads.set(sessionKey, key);
        // Fire-and-forget: the review runs async; results inject via the agent
        // when available (code mode: agent.inject), else best-effort skip.
        void runPushReview(exec).then(msg => {
            if (!msg)
                return;
            const agentView = agentForInject;
            if (agentView?.inject)
                agentView.inject(createUserMessage({
                    content: [{ type: 'text', text: msg }],
                    source: { kind: 'plugin', plugin: 'fact-gate' },
                }));
        });
        return true;
    }
    // ── CODE-MODE push review: run_code sub-dispatches never reach the plugin's
    // post-execute (the code-mode driver digests nested post-execute internally,
    // code-mode.ts:365-390). The `tools/code-dispatch-log` waterfall (index.ts:189)
    // IS reachable and carries the sub-call's full rendered content — including
    // the pwsh stdout with the `->` success marker (verified in session
    // 505a06b3: content `0e3a287..3361171 test/push-review -> test/push-review`).
    // Listener must stay non-blocking (it sits on the log-append path) — only
    // detect + fire-and-forget, always `return next()`.
    ctx.on('tools/code-dispatch-log', (dispatch, next) => {
        if (dispatch.name !== 'pwsh' && dispatch.name !== 'bash')
            return next();
        // 命令本体在 exec.arguments.command（content 是命令输出，不含 "git push"）。
        const command = dispatch.exec.arguments?.command ?? '';
        if (!isGitPushCommand(command))
            return next();
        const text = dispatch.content.map(b => b.text ?? '').join('\n');
        maybePushReview(dispatch.exec, text, dispatch.agent);
        return next();
    });
    // ── Phase-3: cost warning + compaction hook + per-agent project config ──
    const costWarning = new CostWarningTracker(() => ({
        enabled: s().costWarningThreshold > 0,
        threshold: s().costWarningThreshold,
    }));
    // NOTE (verified against rc.6): session/event is dispatched on the session
    // STORE scope — the scopeTarget filter (dsh-scope lib:327-345) admits only
    // listeners whose ctx tag equals the store key or one of its ancestors.
    // Neither an agent-scoped listener nor a plugin fiber listener (even with
    // {global:true} — the store's events instance is out of reach) fires, so
    // token-usage accumulation via assistant/message is not implementable from
    // a plugin. FALLBACK: cost warning counts TURNS via agent/turn-stopping,
    // which IS reachable on agent.ctx (same pattern as dsh-balance).
    // RESUMED sessions do NOT re-emit agent/created (verified: announce() only
    // fires on register(); resumed agents are inserted without announce — same
    // blind spot dsh-ecc handles with ctx.agents.list() at lib:112-164). So
    // attachAgent() runs both on agent/created AND for already-live agents at
    // apply time (guarded by a seen set).
    const attachedAgents = new Set();
    function attachAgent(agent) {
        const agentView = agent;
        if (!agentView?.id || attachedAgents.has(agentView.id))
            return;
        attachedAgents.add(agentView.id);
        // Per-agent project config refresh (session cwd may differ from process cwd).
        const agentCwd = agentView.session.header.cwd;
        if (agentCwd && agentCwd !== process.cwd()) {
            const pc = loadProjectConfig(agentCwd);
            if (pc)
                projectConfig = pc;
        }
        // Cost warning via turn counting (agent-scope event, reachable).
        let turns = 0;
        agentView.ctx.on('agent/turn-stopping', () => {
            turns += 1;
            const threshold = s().costWarningThreshold > 0 ? Math.max(1, Math.floor(s().costWarningThreshold / 10000)) : 0;
            if (threshold > 0 && turns >= threshold) {
                turns = 0;
                agentView.inject(createUserMessage({
                    content: [{ type: 'text', text: `[Fact-Forcing Gate] COST WARNING: session reached ~${threshold * 10000} tokens (est. ${threshold} turns at ~10k tokens each). Consider whether the task warrants the accumulated cost.` }],
                    source: { kind: 'plugin', plugin: 'fact-gate' },
                }));
            }
        });
        // Compaction notice: compaction/start lives in the same store-scoped
        // session stream — not reachable from a plugin (platform limit). Kept as
        // a documented TODO for when dsh exposes a reachable pre-compaction event.
    }
    ctx.on('agent/created', ({ agent }) => {
        attachAgent(agent);
    });
    // Resumed sessions do not re-emit agent/created — attach to already-live
    // agents. NOTE: use ctx.get('agents') (non-strict) — the agents service is
    // provided by a SIBLING entry (@deepseek-ai/dsh-agent in the dsh-base
    // bundle layer), so a strict read (ctx.agents) throws "cannot get property
    // without inject" at apply time (cordis reflect.ts:144-164); strict reads
    // only resolve services of ancestor/own fibers. get() returns undefined
    // when the sibling has not started yet — that is fine, the agent/created
    // listener above still catches agents created later (dsh-ecc lib:162-164
    // precedent).
    const agentsService = ctx.get('agents');
    if (agentsService && typeof agentsService.list === 'function') {
        for (const agent of agentsService.list())
            attachAgent(agent);
    }
    // Mount log (fires once at apply — cordis has no typed 'ready' event in Events).
    ctx.logger.info(`[fact-gate] mounted: hooks=${FACT_GATE_HOOKS.join(',')} deny=${s().deny} profile=${s().profile} phase2=${s().scopeWarningThreshold > 0 ? 'scope' : ''}${s().duplicateRead ? '+dup' : ''}${s().pushReviewEnabled ? '+push' : ''}`);
};
//# sourceMappingURL=index.js.map