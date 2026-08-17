/**
 * fact-gate settings schema (schemastery, mirrors dsh-ecc's SettingsSchema
 * pattern — see D:\Pycharm\PycharmProjects\dsh-ECC\lib\index.js:38 for the
 * `ctx.settings.register(NS, Schema, { applies: 'live' })` idiom).
 *
 * Live settings: changes to settings.yaml take effect without restart
 * (SettingsApplies = 'live', packages/settings/settings/src/index.ts:34-41).
 */
import Schema from '@deepseek-ai/schemastery';
export const FACT_GATE_NS = 'fact-gate';
export const FACT_GATE_HOOKS = ['edit', 'write', 'destructive-bash', 'routine-bash'];
export const FactGateSettings = Schema.object({
    /** Total switch. false = completely pass through (env FACT_GATE=off). */
    enabled: Schema.boolean().default(true),
    /** false = warn-only mode: gate hits attach context instead of denying. */
    deny: Schema.boolean().default(true),
    /** 'full' = gates active; 'none' = off (mirrors dsh-ecc hooksProfile). */
    profile: Schema.union(['full', 'none']).default('full'),
    /** Full-block denial budget; after this many, condensed single-line denials. */
    fullDenials: Schema.number().default(3).min(0),
    /** Exempt path globs (comma-separated; supports ** across segments). */
    exemptGlobs: Schema.array(Schema.string()).default([]),
    /** Operator extra destructive regex sources (layer 2 of detector). */
    bashExtraDestructive: Schema.array(Schema.string()).default([]),
    /** false = skip the once-per-session routine Bash gate (destructive gate still fires). */
    routineBashEnabled: Schema.boolean().default(true),
    /** Per-gate disable list (e.g. ['routine-bash']). */
    enabledHooks: Schema.array(Schema.union(FACT_GATE_HOOKS)).default([...FACT_GATE_HOOKS]),
    /** Enable the run_code danger-API advisory (post-execute context attach). */
    runCodeAdvisory: Schema.boolean().default(true),
});
//# sourceMappingURL=settings.js.map