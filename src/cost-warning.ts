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
export class CostWarningTracker {
  private totals = new Map<string, number>();

  constructor(private config: () => CostWarningConfig) {}

  /** Accumulate one assistant step's usage; returns a warning message or null. */
  record(sessionKey: string, usage: TokenUsageLike): string | null {
    const cfg = this.config();
    if (!cfg.enabled) return null;
    const tokens =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
    if (tokens <= 0) return null;
    const total = (this.totals.get(sessionKey) ?? 0) + tokens;
    this.totals.set(sessionKey, total);
    if (total >= cfg.threshold) {
      this.totals.set(sessionKey, 0); // fire once per session
      return [
        '[Fact-Forcing Gate] COST WARNING:',
        '',
        `Session token usage reached ~${total.toLocaleString()} tokens (threshold ${cfg.threshold.toLocaleString()}). ` +
          'Consider whether the current task warrants the accumulated cost.',
      ].join('\n');
    }
    return null;
  }
}
