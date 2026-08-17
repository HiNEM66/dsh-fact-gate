/**
 * Per-session fact-gate state machine — ported from GateGuard
 * `gateguard-fact-force.js` (state section, lines 717-958), logic preserved.
 *
 * - state file per session key (hashed), under FACT_GATE_STATE_DIR (default ~/.dsh/fact-gate)
 * - checked set bounded: MAX_CHECKED_ENTRIES=500, MAX_SESSION_KEYS=50 (LRU-ish prune)
 * - 30 min inactivity timeout (SESSION_TIMEOUT_MS); stale files pruned at >2x timeout
 * - atomic write: temp file + rename (with EEXIST/EPERM fallback)
 * - fact-force denial budget persisted as `fact_force_denials` (full-block → condensed)
 *
 * Upstream used `process.env.GATEGUARD_STATE_DIR` / HOME; dsh passes the state
 * dir via constructor so tests can point at a temp dir without env games.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const READ_HEARTBEAT_MS = 60 * 1000;
export const MAX_CHECKED_ENTRIES = 500;
export const MAX_SESSION_KEYS = 50;
export const ROUTINE_BASH_SESSION_KEY = '__bash_session__';
const DEFAULT_FULL_DENIALS = 3;
const EMPTY_STATE = () => ({ checked: [], last_active: Date.now(), fact_force_denials: 0 });
/** Sanitize a session key for a file name; hash when too long / unsafe. */
export function sanitizeSessionKey(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return '';
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitized && sanitized.length <= 64)
        return sanitized;
    return hashSessionKey('sid', raw);
}
export function hashSessionKey(prefix, value) {
    return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}
export class FactGateStateStore {
    stateDir;
    constructor(stateDir) {
        this.stateDir = stateDir || join(homedir(), '.dsh', 'fact-gate');
    }
    stateFileFor(sessionKey) {
        return join(this.stateDir, `state-${sessionKey}.json`);
    }
    load(sessionKey) {
        const stateFile = this.stateFileFor(sessionKey);
        try {
            if (existsSync(stateFile)) {
                const state = JSON.parse(readFileSync(stateFile, 'utf8'));
                const lastActive = state.last_active || 0;
                if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
                    try {
                        unlinkSync(stateFile);
                    }
                    catch (_) {
                        /* ignore */
                    }
                    return EMPTY_STATE();
                }
                return {
                    checked: Array.isArray(state.checked) ? state.checked : [],
                    last_active: typeof state.last_active === 'number' ? state.last_active : Date.now(),
                    fact_force_denials: getDenialCount(state),
                };
            }
        }
        catch (_) {
            /* ignore malformed/transient */
        }
        return EMPTY_STATE();
    }
    save(sessionKey, state) {
        const stateFile = this.stateFileFor(sessionKey);
        let tmpFile = null;
        try {
            mkdirSync(this.stateDir, { recursive: true });
            // Merge with disk state to avoid clobbering concurrent writers.
            let mergedChecked = Array.isArray(state.checked) ? [...state.checked] : [];
            let mergedLastActive = typeof state.last_active === 'number' ? state.last_active : 0;
            let mergedDenials = getDenialCount(state);
            try {
                if (existsSync(stateFile)) {
                    const diskState = JSON.parse(readFileSync(stateFile, 'utf8'));
                    if (Array.isArray(diskState.checked)) {
                        mergedChecked = Array.from(new Set([...diskState.checked, ...mergedChecked]));
                    }
                    if (typeof diskState.last_active === 'number') {
                        mergedLastActive = Math.max(mergedLastActive, diskState.last_active);
                    }
                    mergedDenials = Math.max(mergedDenials, getDenialCount(diskState));
                }
            }
            catch (_) {
                /* ignore malformed or transient disk state */
            }
            const finalState = {
                checked: pruneCheckedEntries(mergedChecked),
                last_active: Math.max(mergedLastActive, Date.now()),
                fact_force_denials: mergedDenials,
            };
            // Atomic write: temp file + rename prevents partial reads.
            tmpFile = `${stateFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
            writeFileSync(tmpFile, JSON.stringify(finalState, null, 2), 'utf8');
            try {
                renameSync(tmpFile, stateFile);
            }
            catch (error) {
                if (error && error.code === 'EEXIST' || error.code === 'EPERM') {
                    try {
                        unlinkSync(stateFile);
                    }
                    catch (_) {
                        /* ignore */
                    }
                    renameSync(tmpFile, stateFile);
                }
                else {
                    throw error;
                }
            }
            tmpFile = null;
            return true;
        }
        catch (_) {
            if (tmpFile) {
                try {
                    unlinkSync(tmpFile);
                }
                catch (_) {
                    /* ignore */
                }
            }
            return false;
        }
    }
    markChecked(sessionKey, key) {
        const state = this.load(sessionKey);
        if (!state.checked.includes(key)) {
            state.checked.push(key);
            return this.save(sessionKey, state);
        }
        return true;
    }
    markCheckedAndCountDenial(sessionKey, key) {
        const state = this.load(sessionKey);
        if (!state.checked.includes(key)) {
            state.checked.push(key);
        }
        const denials = getDenialCount(state) + 1;
        state.fact_force_denials = denials;
        return { ok: this.save(sessionKey, state), denials };
    }
    isChecked(sessionKey, key) {
        const state = this.load(sessionKey);
        const found = state.checked.includes(key);
        if (found && Date.now() - (state.last_active || 0) > READ_HEARTBEAT_MS) {
            this.save(sessionKey, state);
        }
        return found;
    }
    /** Prune stale state files older than 2x SESSION_TIMEOUT_MS (called at plugin load). */
    pruneStaleFiles() {
        try {
            const files = readdirSync(this.stateDir);
            const now = Date.now();
            for (const f of files) {
                const isStateFile = f.startsWith('state-') && (f.endsWith('.json') || f.includes('.json.tmp.'));
                if (!isStateFile)
                    continue;
                const fp = join(this.stateDir, f);
                try {
                    const stat = statSync(fp);
                    if (now - stat.mtimeMs > SESSION_TIMEOUT_MS * 2) {
                        unlinkSync(fp);
                    }
                }
                catch (_) {
                    /* ignore files that disappear between readdir/stat/unlink */
                }
            }
        }
        catch (_) {
            /* ignore */
        }
    }
}
export function getDenialCount(state) {
    const n = Number(state && state.fact_force_denials);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
export function getFullDenialBudget(envOverride) {
    const raw = Number.parseInt(envOverride || '', 10);
    if (Number.isInteger(raw) && raw >= 0) {
        return raw;
    }
    return DEFAULT_FULL_DENIALS;
}
function pruneCheckedEntries(checked) {
    if (checked.length <= MAX_CHECKED_ENTRIES) {
        return checked;
    }
    const preserved = checked.includes(ROUTINE_BASH_SESSION_KEY) ? [ROUTINE_BASH_SESSION_KEY] : [];
    const sessionKeys = checked.filter(k => k.startsWith('__') && k !== ROUTINE_BASH_SESSION_KEY);
    const fileKeys = checked.filter(k => !k.startsWith('__'));
    const remainingSessionSlots = Math.max(MAX_SESSION_KEYS - preserved.length, 0);
    const cappedSession = sessionKeys.slice(-remainingSessionSlots);
    const remainingFileSlots = Math.max(MAX_CHECKED_ENTRIES - preserved.length - cappedSession.length, 0);
    const cappedFiles = fileKeys.slice(-remainingFileSlots);
    return [...preserved, ...cappedSession, ...cappedFiles];
}
/** Resolve a stable session key from the agent id, with env/project fallbacks (mirrors upstream resolveSessionKey). */
export function resolveSessionKey(agentId, env) {
    const candidates = [agentId, env.FACT_GATE_SESSION_ID];
    for (const candidate of candidates) {
        const sanitized = sanitizeSessionKey(candidate || '');
        if (sanitized) {
            return sanitized;
        }
    }
    const projectFingerprint = env.FACT_GATE_PROJECT_DIR || process.cwd();
    return hashSessionKey('proj', resolve(projectFingerprint));
}
/** Sanitize a file path for message embedding: strip control chars / bidi overrides / newlines. */
export function sanitizePath(filePath) {
    let sanitized = '';
    for (const char of String(filePath || '')) {
        const code = char.codePointAt(0);
        const isAsciiControl = code <= 0x1f || code === 0x7f;
        const isBidiOverride = (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
        sanitized += isAsciiControl || isBidiOverride ? ' ' : char;
    }
    return sanitized.trim().slice(0, 500);
}
/** Is this a Claude-settings-like path (exempt from gating)? */
export function isSettingsPath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    return /(^|\/)\.dsh\/settings\.yaml$/.test(normalized);
}
//# sourceMappingURL=state.js.map