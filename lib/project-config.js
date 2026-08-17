/**
 * Project-level `.fact-gate.yml` config (phase-3) — mirrors GateGuard's
 * `gateguard init` per-project config (SKILL.md Option B). Loaded from the
 * session workspace root at plugin start; merges OVER the user settings.yaml
 * (project-specific intent wins for this tree).
 *
 * yaml dependency is non-@deepseek-ai — no hoisted-instance risk (the
 * phase-1 #prepare root cause).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
/** Load `.fact-gate.yml` from cwd (also walks one level up for monorepo roots). Returns parsed object or null. */
export function loadProjectConfig(cwd) {
    if (!cwd)
        return null;
    const candidates = [resolve(cwd, '.fact-gate.yml'), resolve(cwd, '..', '.fact-gate.yml')];
    for (const path of candidates) {
        try {
            const text = readFileSync(path, 'utf8');
            const parsed = parseYaml(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch (_) {
            // missing or unreadable — try next candidate
        }
    }
    return null;
}
/**
 * Merge project config over the settings value. Only known keys are copied
 * (unknown keys are ignored — never crash on a stray field).
 */
const KNOWN_KEYS = [
    'enabled', 'deny', 'profile', 'fullDenials', 'exemptGlobs', 'bashExtraDestructive',
    'routineBashEnabled', 'enabledHooks', 'runCodeAdvisory', 'scopeWarningThreshold',
    'duplicateRead', 'pushReviewEnabled', 'pushReviewProvider', 'pushReviewMaxCommits',
];
export function mergeProjectConfig(base, project) {
    if (!project)
        return base;
    const merged = { ...base };
    for (const key of KNOWN_KEYS) {
        if (project[key] !== undefined)
            merged[key] = project[key];
    }
    return merged;
}
//# sourceMappingURL=project-config.js.map