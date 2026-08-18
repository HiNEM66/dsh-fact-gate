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

export const FACT_GATE_HOOKS = ['edit', 'write', 'destructive-bash', 'routine-bash'] as const;
export type FactGateHook = (typeof FACT_GATE_HOOKS)[number];

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
  /** Scope warning: warn when a session edits N files (mirrors CC SCOPE WARNING). */
  scopeWarningThreshold: Schema.number().default(20).min(1),
  /** Duplicate-read softening (CC built-in ②) — OFF by default. */
  duplicateRead: Schema.boolean().default(false),
  /** Push security review (CC security-guidance) — subagent provider; '' = first registered. */
  pushReviewEnabled: Schema.boolean().default(true),
  pushReviewProvider: Schema.string().default(''),
  pushReviewMaxCommits: Schema.number().default(5).min(1).max(20),
  /** Session token threshold for COST WARNING (0 = off). */
  costWarningThreshold: Schema.number().default(1_000_000).min(0),
  /**
   * Inject a notice when the session context is compacted (Claude Code
   * PreCompact equivalent). Implemented via agent/pre-step + incremental
   * scan of agent.session.events for compaction/start records (the event is
   * appended to the session stream, not emitted on a reachable cordis
   * event — compaction-basic/src/region.ts:189; the backend itself triggers
   * inside an agent/pre-step listener, index.ts:147). Default OFF.
   */
  compactionNotice: Schema.boolean().default(false),
});

export type FactGateSettingsValue = ReturnType<typeof FactGateSettings>;

