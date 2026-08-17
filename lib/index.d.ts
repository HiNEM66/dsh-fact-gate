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
import { FactGateSettings, type FactGateSettingsValue } from './settings.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        settings: {
            register<T>(ns: string, schema: Schema<T>, options?: {
                applies?: 'live' | 'restart';
            }): {
                get(): T;
            };
        };
        /** Subagent runtime (dsh-base provides it); injected, never imported. */
        subagents: {
            list(): string[];
            getProvider(name: string): {
                capabilities: {
                    persona?: boolean;
                    outputSchema?: boolean;
                    toolFilter?: boolean;
                    depthLimit?: boolean;
                };
            } | undefined;
            start(provider: string, request: {
                label: string;
                prompt: {
                    type: 'text';
                    text: string;
                }[];
                parent?: unknown;
                signal?: AbortSignal;
                maxDepth?: number;
                outputSchema?: unknown;
                agentOptions?: {
                    provider?: string;
                    model?: string;
                    maxTokens?: number;
                };
            }): Promise<unknown>;
        };
    }
}
export declare const name = "fact-gate";
export declare const inject: readonly ["settings", "subagents"];
export declare const Config: typeof FactGateSettings;
declare module '@deepseek-ai/dsh-agent' {
    interface AgentOptions {
        subagentDepth?: number;
    }
}
export declare function apply(ctx: Context, config: FactGateSettingsValue): void;
