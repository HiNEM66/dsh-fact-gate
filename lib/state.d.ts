export declare const SESSION_TIMEOUT_MS: number;
export declare const MAX_CHECKED_ENTRIES = 500;
export declare const MAX_SESSION_KEYS = 50;
export declare const ROUTINE_BASH_SESSION_KEY = "__bash_session__";
export interface FactGateState {
    checked: string[];
    last_active: number;
    fact_force_denials: number;
}
/** Sanitize a session key for a file name; hash when too long / unsafe. */
export declare function sanitizeSessionKey(value: string): string;
export declare function hashSessionKey(prefix: string, value: string): string;
export declare class FactGateStateStore {
    readonly stateDir: string;
    constructor(stateDir?: string);
    private stateFileFor;
    load(sessionKey: string): FactGateState;
    save(sessionKey: string, state: FactGateState): boolean;
    markChecked(sessionKey: string, key: string): boolean;
    markCheckedAndCountDenial(sessionKey: string, key: string): {
        ok: boolean;
        denials: number;
    };
    isChecked(sessionKey: string, key: string): boolean;
    /** Prune stale state files older than 2x SESSION_TIMEOUT_MS (called at plugin load). */
    pruneStaleFiles(): void;
}
export declare function getDenialCount(state: Partial<FactGateState> | null | undefined): number;
export declare function getFullDenialBudget(envOverride?: string): number;
/** Resolve a stable session key from the agent id, with env/project fallbacks (mirrors upstream resolveSessionKey). */
export declare function resolveSessionKey(agentId: string | undefined, env: {
    FACT_GATE_SESSION_ID?: string;
    FACT_GATE_PROJECT_DIR?: string;
}): string;
/** Sanitize a file path for message embedding: strip control chars / bidi overrides / newlines. */
export declare function sanitizePath(filePath: string): string;
/** Is this a Claude-settings-like path (exempt from gating)? */
export declare function isSettingsPath(filePath: string): boolean;
