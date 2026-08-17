/**
 * Scope warning (phase-2): after a session edits/writes N files, attach a
 * SCOPE WARNING context message so the model considers whether changes are
 * too scattered. Mirrors the everything-claude-code PostToolUse scope alert.
 *
 * Per-session counter; fires once per session (reset after firing).
 */
export interface ScopeWarningConfig {
    enabled: boolean;
    /** Fire after this many modified files in one session. */
    threshold: number;
}
/** Track per-session edit/write counts; returns warning message when threshold crossed. */
export declare class ScopeWarningTracker {
    private config;
    private counts;
    constructor(config: () => ScopeWarningConfig);
    /** Record a successful file modification; return a warning message or null. */
    record(sessionKey: string, toolName: string, isError: boolean): string | null;
}
