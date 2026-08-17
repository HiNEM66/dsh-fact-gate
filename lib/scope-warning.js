/**
 * Scope warning (phase-2): after a session edits/writes N files, attach a
 * SCOPE WARNING context message so the model considers whether changes are
 * too scattered. Mirrors the everything-claude-code PostToolUse scope alert.
 *
 * Per-session counter; fires once per session (reset after firing).
 */
const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace_editor']);
/** Track per-session edit/write counts; returns warning message when threshold crossed. */
export class ScopeWarningTracker {
    config;
    counts = new Map();
    constructor(config) {
        this.config = config;
    }
    /** Record a successful file modification; return a warning message or null. */
    record(sessionKey, toolName, isError) {
        const cfg = this.config();
        if (!cfg.enabled || isError)
            return null;
        if (!EDIT_TOOLS.has(toolName))
            return null;
        const count = (this.counts.get(sessionKey) ?? 0) + 1;
        this.counts.set(sessionKey, count);
        if (count >= cfg.threshold) {
            this.counts.set(sessionKey, 0); // fire once per session
            return [
                '[Fact-Forcing Gate] SCOPE WARNING:',
                '',
                `${count} files modified this session. Consider whether changes are too scattered — ` +
                    'review whether each edit serves the user request before continuing.',
            ].join('\n');
        }
        return null;
    }
}
//# sourceMappingURL=scope-warning.js.map