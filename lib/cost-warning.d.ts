/**
 * Session token-cost warning (phase-3): accumulate token usage from
 * `assistant/message` session events (usage travels with the message —
 * packages/core/session/src/types.ts:265-273) and inject a warning once the
 * session exceeds a threshold — mirroring CC's COST CRITICAL alert without
 * needing a price table (token counts only; dollar conversion left to the
 * operator via the threshold).
 */
export interface CostWarningConfig {
    enabled: boolean;
    /** Total session tokens (input+output+cache) that trigger the warning. */
    threshold: number;
}
/** Usage shape from session events (TokenUsage, packages/llm/llm/src/types.ts:135). */
export interface TokenUsageLike {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** Track per-session token totals; fires once per session above threshold. */
export declare class CostWarningTracker {
    private config;
    private totals;
    constructor(config: () => CostWarningConfig);
    /** Accumulate one assistant step's usage; returns a warning message or null. */
    record(sessionKey: string, usage: TokenUsageLike): string | null;
}
