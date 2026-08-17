/**
 * run_code danger-API advisory (phase-1 addition, per plan §10.7.3).
 *
 * `run_code` executes TypeScript in the harness runtime — the fact gates
 * cannot parse its semantics, and a heuristic deny would be unreliable. So
 * instead of gating, we attach a context message to the tool result when the
 * code string contains danger-API patterns (file deletion, child processes,
 * process kill, shell execution). The model sees the advisory and must weigh
 * it — advisory, not denial (decision #3, plan §10.7).
 */
export interface RunCodeAdvisoryConfig {
    /** Set false to disable the advisory entirely. */
    enabled: boolean;
}
/** Scan a code string for danger-API patterns; return matched labels (empty = safe). */
export declare function scanDangerApis(code: string): string[];
/** Build the advisory message injected as additional context (not a denial). */
export declare function dangerAdvisoryMessage(labels: string[]): string;
