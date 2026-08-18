/**
 * Four fact-forcing gates — ported from GateGuard `run()` (lines 1170-1278),
 * adapted to the dsh tool surface:
 *
 *   CC tool        → dsh tool
 *   Edit           → edit, str_replace_editor(str_replace|insert)
 *   Write          → write, str_replace_editor(create)
 *   Bash           → pwsh (arguments.command)
 *   MultiEdit      → (no dsh equivalent — dropped)
 *
 * Gate semantics are preserved: per-file first-touch for edit/write,
 * per-command for destructive, once-per-session for routine; sub-agent calls
 * are exempt (parent session already passed first-touch); denial budget
 * collapses full blocks to a single line after `fullDenials`.
 */
import { type DetectorConfig } from './detect-destructive.ts';
import { FactGateStateStore } from './state.ts';
export type GateDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
};
export interface GateContext {
    store: FactGateStateStore;
    sessionKey: string;
    exemptMatchers: RegExp[];
    /** Operator extra destructive regexes + exempt globs (layer 2 of the detector). */
    detectorConfig: DetectorConfig;
    fullDenials: number;
    /** True = warn-only mode: hit gates record a pending warn instead of denying. */
    warnOnly: boolean;
    /** When warnOnly, gate hits are recorded here (callId → warn message) for post-execute attach. */
    pendingWarns?: Map<string, string>;
    isSubagent: boolean;
    /**
     * Per-gate arming filter (enabledHooks granularity). Absent = all gates
     * armed. Only consulted by the shell surface: the destructive gate fires
     * only when `destructive` is true, the routine gate only when `routine`
     * is true. Off gates are skipped entirely (state untouched).
     */
    gateFilter?: {
        destructive?: boolean;
        routine?: boolean;
    };
}
export interface GateInput {
    /** Normalized tool name (already mapped to dsh surface). */
    toolName: string;
    args: Record<string, unknown>;
}
/**
 * Decide the gate for one tool call. Mirrors upstream run() branch order:
 * Edit/Write → Bash(destructive → routine) → allow.
 */
export declare function decideGate(input: GateInput, ctx: GateContext, callId: string): GateDecision;
