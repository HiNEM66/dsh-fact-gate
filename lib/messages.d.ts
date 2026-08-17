/**
 * Fact-Forcing Gate message templates — ported verbatim from GateGuard
 * `gateguard-fact-force.js` (messages section, lines 1054-1166).
 *
 * The recovery hint mentions FACT_GATE instead of ECC_GATEGUARD (dsh env),
 * and hook ids reference the dsh plugin's hook names.
 */
export declare const EDIT_WRITE_HOOK_ID = "pre:edit-write:fact-gate";
export declare const BASH_HOOK_ID = "pre:bash:fact-gate";
export declare function editGateMsg(filePath: string): string;
export declare function writeGateMsg(filePath: string): string;
/**
 * Condensed single-line denial used after the full-block budget is spent.
 * Carries the denial ordinal so consecutive denials differ textually.
 */
export declare function condensedGateMsg(action: string, filePath: string, ordinal: number): string;
export declare function destructiveBashMsg(): string;
export declare function routineBashMsg(): string;
export declare function withRecoveryHint(message: string, hookIds?: string[]): string;
