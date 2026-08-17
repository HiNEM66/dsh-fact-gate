/**
 * fact-gate settings schema (schemastery, mirrors dsh-ecc's SettingsSchema
 * pattern — see D:\Pycharm\PycharmProjects\dsh-ECC\lib\index.js:38 for the
 * `ctx.settings.register(NS, Schema, { applies: 'live' })` idiom).
 *
 * Live settings: changes to settings.yaml take effect without restart
 * (SettingsApplies = 'live', packages/settings/settings/src/index.ts:34-41).
 */
import Schema from '@deepseek-ai/schemastery';
export declare const FACT_GATE_NS = "fact-gate";
export declare const FACT_GATE_HOOKS: readonly ["edit", "write", "destructive-bash", "routine-bash"];
export type FactGateHook = (typeof FACT_GATE_HOOKS)[number];
export declare const FactGateSettings: Schema<Schemastery.ObjectS<{
    /** Total switch. false = completely pass through (env FACT_GATE=off). */
    enabled: Schema<boolean, boolean>;
    /** false = warn-only mode: gate hits attach context instead of denying. */
    deny: Schema<boolean, boolean>;
    /** 'full' = gates active; 'none' = off (mirrors dsh-ecc hooksProfile). */
    profile: Schema<"full" | "none", "full" | "none">;
    /** Full-block denial budget; after this many, condensed single-line denials. */
    fullDenials: Schema<number, number>;
    /** Exempt path globs (comma-separated; supports ** across segments). */
    exemptGlobs: Schema<string[], string[]>;
    /** Operator extra destructive regex sources (layer 2 of detector). */
    bashExtraDestructive: Schema<string[], string[]>;
    /** false = skip the once-per-session routine Bash gate (destructive gate still fires). */
    routineBashEnabled: Schema<boolean, boolean>;
    /** Per-gate disable list (e.g. ['routine-bash']). */
    enabledHooks: Schema<("edit" | "write" | "destructive-bash" | "routine-bash")[], ("edit" | "write" | "destructive-bash" | "routine-bash")[]>;
    /** Enable the run_code danger-API advisory (post-execute context attach). */
    runCodeAdvisory: Schema<boolean, boolean>;
    /** Scope warning: warn when a session edits N files (mirrors CC SCOPE WARNING). */
    scopeWarningThreshold: Schema<number, number>;
    /** Duplicate-read softening (CC built-in ②) — OFF by default. */
    duplicateRead: Schema<boolean, boolean>;
    /** Push security review (CC security-guidance) — subagent provider; '' = first registered. */
    pushReviewEnabled: Schema<boolean, boolean>;
    pushReviewProvider: Schema<string, string>;
    pushReviewMaxCommits: Schema<number, number>;
}>, Schemastery.ObjectT<{
    /** Total switch. false = completely pass through (env FACT_GATE=off). */
    enabled: Schema<boolean, boolean>;
    /** false = warn-only mode: gate hits attach context instead of denying. */
    deny: Schema<boolean, boolean>;
    /** 'full' = gates active; 'none' = off (mirrors dsh-ecc hooksProfile). */
    profile: Schema<"full" | "none", "full" | "none">;
    /** Full-block denial budget; after this many, condensed single-line denials. */
    fullDenials: Schema<number, number>;
    /** Exempt path globs (comma-separated; supports ** across segments). */
    exemptGlobs: Schema<string[], string[]>;
    /** Operator extra destructive regex sources (layer 2 of detector). */
    bashExtraDestructive: Schema<string[], string[]>;
    /** false = skip the once-per-session routine Bash gate (destructive gate still fires). */
    routineBashEnabled: Schema<boolean, boolean>;
    /** Per-gate disable list (e.g. ['routine-bash']). */
    enabledHooks: Schema<("edit" | "write" | "destructive-bash" | "routine-bash")[], ("edit" | "write" | "destructive-bash" | "routine-bash")[]>;
    /** Enable the run_code danger-API advisory (post-execute context attach). */
    runCodeAdvisory: Schema<boolean, boolean>;
    /** Scope warning: warn when a session edits N files (mirrors CC SCOPE WARNING). */
    scopeWarningThreshold: Schema<number, number>;
    /** Duplicate-read softening (CC built-in ②) — OFF by default. */
    duplicateRead: Schema<boolean, boolean>;
    /** Push security review (CC security-guidance) — subagent provider; '' = first registered. */
    pushReviewEnabled: Schema<boolean, boolean>;
    pushReviewProvider: Schema<string, string>;
    pushReviewMaxCommits: Schema<number, number>;
}>>;
export type FactGateSettingsValue = ReturnType<typeof FactGateSettings>;
