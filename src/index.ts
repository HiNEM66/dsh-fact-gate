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
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';

import { decideGate, type GateContext } from './gates.ts';
import { compileExemptGlobs, isGateGuardDisabled } from './detect-destructive.ts';
import { FactGateStateStore, resolveSessionKey, getFullDenialBudget } from './state.ts';
import { withRecoveryHint, EDIT_WRITE_HOOK_ID, BASH_HOOK_ID } from './messages.ts';
import { scanDangerApis, dangerAdvisoryMessage } from './run-code-advisory.ts';
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
export const inject = ['settings'] as const;

export const Config: typeof FactGateSettings = FactGateSettings;

// Tool-surface mapping: dsh tool name → gate category.
const WRITE_TOOLS = new Set(['write']);
const EDIT_TOOLS = new Set(['edit']);
const STR_REPLACE_EDITOR = 'str_replace_editor';
const SHELL_TOOLS = new Set(['pwsh', 'bash']);
const RUN_CODE_TOOL = 'run_code';

export function apply(ctx: Context, config: FactGateSettingsValue) {
  // ── Settings (live) + env fallbacks ──
  // SettingsScope is an object with get()/watch()/update() — NOT callable.
  // (packages/settings/settings/src/index.ts:103-116; dsh-ecc lib/index.js:38-49
  // wraps scope.get() the same way.)
  const scope = ctx.settings.register(FACT_GATE_NS, FactGateSettings, { applies: 'live' });
  const s = () => scope.get();

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
    // exec.agent is optional (no-subject calls); sub-agents have delegationDepth > 0.
    // delegationDepthOf handles a missing agent by returning 0 (depth.ts).
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

  // ── tools/post-execute: advisories (run_code danger API + warn-mode attach) ──
  ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
    // run_code danger-API advisory (phase-1, no deny).
    if (RUN_CODE_TOOL === exec.name && s().runCodeAdvisory && gateEnabled()) {
      const code = (exec.arguments as Record<string, string> | undefined)?.code ?? '';
      const labels = scanDangerApis(code);
      if (labels.length > 0) {
        return Promise.resolve({
          kind: 'accept',
          additionalContexts: [{ role: 'user', content: dangerAdvisoryMessage(labels) } as never],
        });
      }
    }

    // warn-only mode: attach a pending gate warn to the result context.
    const warn = pendingWarns.get(exec.callId);
    if (warn) {
      pendingWarns.delete(exec.callId);
      return Promise.resolve({
        kind: 'accept',
        additionalContexts: [{ role: 'user', content: warn } as never],
      });
    }

    return Promise.resolve(next());
  }, { prepend: true });

  // Mount log (fires once at apply — cordis has no typed 'ready' event in Events).
  ctx.logger.info(`[fact-gate] mounted: hooks=${FACT_GATE_HOOKS.join(',')} deny=${s().deny} profile=${s().profile}`);
}
