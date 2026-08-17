/**
 * Project-level `.fact-gate.yml` config (phase-3) — mirrors GateGuard's
 * `gateguard init` per-project config (SKILL.md Option B). Loaded from the
 * session workspace root at plugin start; merges OVER the user settings.yaml
 * (project-specific intent wins for this tree).
 *
 * yaml dependency is non-@deepseek-ai — no hoisted-instance risk (the
 * phase-1 #prepare root cause).
 */
export interface ProjectConfigSource {
    /** Workspace root to search for .fact-gate.yml (agent session cwd). */
    cwd: string;
}
/** Load `.fact-gate.yml` from cwd (also walks one level up for monorepo roots). Returns parsed object or null. */
export declare function loadProjectConfig(cwd: string): Record<string, unknown> | null;
export declare function mergeProjectConfig<T extends Record<string, unknown>>(base: T, project: Record<string, unknown> | null): T;
