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

import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { PreToolDecision, PostToolDecision } from '@deepseek-ai/dsh-tools';
// NOTE: 运行时零 @deepseek-ai 依赖（内联纯函数）— hoisted 双实例会破坏
// dsh 内部 symbol 一致性（TOOL_RUNTIME_SCHEDULER → 'prepare' undefined）。
import type { UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { randomUUID } from 'node:crypto';

import { decideGate, type GateContext } from './gates.ts';
import { compileExemptGlobs, isGateGuardDisabled } from './detect-destructive.ts';
import { FactGateStateStore, resolveSessionKey, getFullDenialBudget } from './state.ts';
import { withRecoveryHint, EDIT_WRITE_HOOK_ID, BASH_HOOK_ID } from './messages.ts';
import { scanDangerApis, dangerAdvisoryMessage } from './run-code-advisory.ts';
import { ScopeWarningTracker } from './scope-warning.ts';
import { DuplicateReadTracker } from './duplicate-read.ts';
import { CostWarningTracker, type TokenUsageLike } from './cost-warning.ts';
import { loadProjectConfig, mergeProjectConfig } from './project-config.ts';
import { isGitPushCommand, PUSH_REVIEW_PROMPT, formatReviewMessage, type PushReviewResult } from './push-review.ts';
import { FACT_GATE_NS, FactGateSettings, FACT_GATE_HOOKS, type FactGateHook, type FactGateSettingsValue } from './settings.ts';

// cordis service augmentation: ctx.settings is provided by the harness
// (dsh-base bundle registers the settings seam). Cordis convention —
// context.d.ts: "this interface is augmented by core services and plugins".
declare module '@deepseek-ai/cordis' {
  interface Context {
    settings: {
      register<T>(ns: string, schema: Schema<T>, options?: { applies?: 'live' | 'restart' }): { get(): T };
    };
  }
}

export const name = 'fact-gate';
// NOTE: 只注入 settings。subagents/agents 由 dsh-base bundle 的兄弟 entry
// 提供（subagent 行 / agent 行），当前 context 的 strict 属性读会抛
// "cannot get property without inject"（cordis reflect.ts:144-164）；同时
// subagents 在 profile 层可被移除，声明 inject 会让插件在缺少该服务时
// PENDING 卡死。统一走 ctx.get() 容错（见 apply 内 runPushReview）。
export const inject = ['settings'] as const;

export const Config: typeof FactGateSettings = FactGateSettings;

// Tool-surface mapping: dsh tool name → gate category.
const WRITE_TOOLS = new Set(['write']);
const EDIT_TOOLS = new Set(['edit']);
const STR_REPLACE_EDITOR = 'str_replace_editor';
const SHELL_TOOLS = new Set(['pwsh', 'bash']);
const RUN_CODE_TOOL = 'run_code';

// ── Inlined helpers (no runtime @deepseek-ai imports — see NOTE above) ──

// Same augmentation as dsh-subagent depth.ts (AgentOptions.subagentDepth).
declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    subagentDepth?: number;
  }
}

/** Inline of dsh-subagent depth.delegationDepthOf (packages/subagent/subagent/src/depth.ts). */
function delegationDepthOf(agent: Agent): number {
  const runtime = agent.options.subagentDepth;
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer');
  }
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);
}

/** Recursive deep-freeze (inline of dsh-llm message.freezeMessage's deepFreeze). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[k]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Inline of dsh-llm message.createUserMessage (packages/llm/llm/src/message.ts:192):
 * complete content + source + fresh stable identity + freeze, role 'user'.
 */
function createUserMessage(input: { content: ContentBlock[]; source: unknown }): UserMessage {
  return deepFreeze(structuredClone({
    ...input,
    id: `msg-${randomUUID()}`,
    role: 'user',
  })) as UserMessage;
}

// NOTE: apply 必须是箭头函数（无 prototype）— cordis fiber.ts:251 的
// isConstructor() 对普通 function 返回 true，会把 apply 当类构造器用
// `new apply(ctx, config)` 调用（实测崩溃：`new apply` 栈 + "cannot get
// property without inject"）。dsh-ecc 同款坑，箭头函数是唯一修法。
export const apply = (ctx: Context, config: FactGateSettingsValue) => {
  // ── Settings (live) + env fallbacks ──
  // SettingsScope is an object with get()/watch()/update() — NOT callable.
  // (packages/settings/settings/src/index.ts:103-116; dsh-ecc lib/index.js:38-49
  // wraps scope.get() the same way.)
  const scope = ctx.settings.register(FACT_GATE_NS, FactGateSettings, { applies: 'live' });
  // Phase-3: project-level .fact-gate.yml overlays the user settings
  // (loaded from the process cwd; refreshed per agent when its cwd differs).
  let projectConfig = loadProjectConfig(process.cwd());
  const s = () => mergeProjectConfig(scope.get(), projectConfig) as FactGateSettingsValue;

  const stateStore = new FactGateStateStore(process.env.FACT_GATE_STATE_DIR);
  stateStore.pruneStaleFiles();

  // Denial budget from env override (FACT_GATE_FULL_DENIALS), like upstream.
  const fullDenials = () => getFullDenialBudget(process.env.FACT_GATE_FULL_DENIALS);

  // Per-call warn-mode bookkeeping (warnOnly gate hits → attach at post-execute).
  const pendingWarns = new Map<string, string>();

  function gateEnabled(): boolean {
    if (isGateGuardDisabled(process.env.FACT_GATE)) return false;
    return s().enabled && s().profile !== 'none';
  }

  function hookEnabled(hook: FactGateHook): boolean {
    return s().enabledHooks.includes(hook);
  }

  function sessionKeyFor(exec: { agent?: { id?: string } }): string {
    return resolveSessionKey(exec.agent?.id, {
      FACT_GATE_SESSION_ID: process.env.FACT_GATE_SESSION_ID,
      FACT_GATE_PROJECT_DIR: process.env.FACT_GATE_PROJECT_DIR,
    } as { FACT_GATE_SESSION_ID?: string; FACT_GATE_PROJECT_DIR?: string });
  }

  function isSubagentCall(exec: { agent?: unknown }): boolean {
    // exec.agent is optional (no-subject calls) — delegationDepthOf(undefined)
    // would throw (depth.ts accesses agent.options), so guard first.
    if (!exec.agent) return false;
    return delegationDepthOf(exec.agent as never) > 0;
  }

  // ── tools/pre-execute: the fact-forcing gate ──
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (!gateEnabled()) return Promise.resolve(next());
    const cfg = s();
    const toolName = exec.name;

    // Map tool surface → gate category; others pass through.
    const sessionKey = sessionKeyFor(exec);
    const gateCtx: GateContext = {
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

    // Edit/Write surface.
    if (EDIT_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) || toolName === STR_REPLACE_EDITOR) {
      if (!hookEnabled('edit') && !hookEnabled('write')) return Promise.resolve(next());
      const decision = decideGate(
        { toolName, args: (exec.arguments ?? {}) as Record<string, unknown> },
        gateCtx,
        exec.callId ?? '',
      );
      if (decision.kind === 'deny') {
        return Promise.resolve({ kind: 'deny', reason: withRecoveryHint(decision.reason, [EDIT_WRITE_HOOK_ID]) });
      }
      return Promise.resolve(next());
    }

    // Shell surface (pwsh / bash).
    if (SHELL_TOOLS.has(toolName)) {
      const decision = decideGate(
        { toolName, args: (exec.arguments ?? {}) as Record<string, unknown> },
        gateCtx,
        exec.callId ?? '',
      );
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
  function attachMessage(text: string): PostToolDecision {
    return {
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'fact-gate' },
      })],
    };
  }

  /** Run a sub-agent security review of the last N commits (push review). */
  async function runPushReview(exec: { agent?: unknown; signal?: AbortSignal }): Promise<string | null> {
    const cfg = s();
    if (!cfg.pushReviewEnabled) return null;
    // subagents is provided by a sibling entry (@deepseek-ai/dsh-subagent in
    // the dsh-base bundle); strict ctx.subagents would throw at apply time —
    // read non-strict and degrade gracefully (subagent-less profiles skip).
    const subagents = ctx.get('subagents') as { list(): string[]; start(...args: unknown[]): Promise<unknown> } | undefined;
    if (!subagents) return null;
    const providers = subagents.list();
    if (providers.length === 0) return null;
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
    const provider = cfg.pushReviewProvider || providers[0]!;
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
        parent: parent as never,
        signal: new AbortController().signal,
        agentOptions: { maxTokens: 4000 },
      }) as { output: { content?: { type: string; text?: string }[] }; stopReason?: string };
      const text = run.output?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '';
      if (text.trim()) {
        const jsonStart = text.indexOf('{');
        if (jsonStart >= 0) {
          try {
            const result = JSON.parse(text.slice(jsonStart)) as PushReviewResult;
            return formatReviewMessage(result);
          } catch (_) {
            return `[Fact-Forcing Gate] Push security review (unparsed):\n${text.slice(0, 1200)}`;
          }
        }
        return `[Fact-Forcing Gate] Push security review:\n${text.slice(0, 1200)}`;
      }
      return null;
    } catch (e) {
      ctx.logger.warn(`[fact-gate] push review failed: ${String(e)}`);
      return null;
    }
  }

  // ── tools/post-execute: advisories (run_code danger API + warn-mode attach + phase-2) ──
  ctx.on('tools/post-execute', (exec, result, next): Promise<PostToolDecision> => {
    const sessionKey = sessionKeyFor(exec);
    const cfg = s();

    // run_code danger-API advisory (phase-1, no deny).
    if (RUN_CODE_TOOL === exec.name && cfg.runCodeAdvisory && gateEnabled()) {
      const code = (exec.arguments as Record<string, string> | undefined)?.code ?? '';
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
      const filePath = (exec.arguments as Record<string, string> | undefined)?.file_path ?? '';
      const { duplicate, path } = duplicateRead.recordRead(sessionKey, filePath);
      if (duplicate) {
        return Promise.resolve(attachMessage(DuplicateReadTracker.hintMessage(path)));
      }
    }

    // Phase-2: push security review — git push completed.
    if (exec.name === 'pwsh' || exec.name === 'bash') {
      const command = (exec.arguments as Record<string, string> | undefined)?.command ?? '';
      if (!result.isError && isGitPushCommand(command) && gateEnabled()) {
        return runPushReview(exec).then(msg => (msg ? attachMessage(msg) : next()));
      }
    }

    return Promise.resolve(next());
  }, { prepend: true });

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
  const attachedAgents = new Set<string>();

  function attachAgent(agent: unknown): void {
    const agentView = agent as {
      id: string;
      session: { header: { cwd?: string; delegationDepth?: number } };
      inject(context: UserMessage): void;
      ctx: Context;
    };
    if (!agentView?.id || attachedAgents.has(agentView.id)) return;
    attachedAgents.add(agentView.id);
    // Per-agent project config refresh (session cwd may differ from process cwd).
    const agentCwd = agentView.session.header.cwd;
    if (agentCwd && agentCwd !== process.cwd()) {
      const pc = loadProjectConfig(agentCwd);
      if (pc) projectConfig = pc;
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
  const agentsService = ctx.get('agents') as { list(): unknown[] } | undefined;
  if (agentsService && typeof agentsService.list === 'function') {
    for (const agent of agentsService.list()) attachAgent(agent);
  }

  // Mount log (fires once at apply — cordis has no typed 'ready' event in Events).
  ctx.logger.info(`[fact-gate] mounted: hooks=${FACT_GATE_HOOKS.join(',')} deny=${s().deny} profile=${s().profile} phase2=${s().scopeWarningThreshold > 0 ? 'scope' : ''}${s().duplicateRead ? '+dup' : ''}${s().pushReviewEnabled ? '+push' : ''}`);
}
