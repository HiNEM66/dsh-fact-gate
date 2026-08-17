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

import { createHash } from 'node:crypto';
import { isDestructiveBash, isExemptPath, isReadOnlyGitIntrospection, type DetectorConfig } from './detect-destructive.ts';
import {
  condensedGateMsg,
  destructiveBashMsg,
  editGateMsg,
  routineBashMsg,
  writeGateMsg,
} from './messages.ts';
import { FactGateStateStore, ROUTINE_BASH_SESSION_KEY } from './state.ts';

export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string };

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
}

export interface GateInput {
  /** Normalized tool name (already mapped to dsh surface). */
  toolName: string;
  args: Record<string, unknown>;
}

/** Does this tool call act on a file (edit/write surface)? */
function fileTarget(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'edit' || toolName === 'write') {
    return typeof args.file_path === 'string' ? args.file_path : null;
  }
  if (toolName === 'str_replace_editor') {
    const command = typeof args.command === 'string' ? args.command : '';
    // create → write gate; str_replace/insert → edit gate; view/diff → no gate
    if (command === 'create' || command === 'str_replace' || command === 'insert') {
      return typeof args.path === 'string' ? args.path : null;
    }
    return null;
  }
  return null;
}

function isWriteTarget(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'write') return true;
  if (toolName === 'str_replace_editor') {
    return typeof args.command === 'string' && args.command === 'create';
  }
  return false;
}

function denyOrWarn(ctx: GateContext, callId: string, reason: string, opts: { includeRecoveryHint?: boolean } = {}): GateDecision {
  if (ctx.warnOnly) {
    ctx.pendingWarns?.set(callId, reason);
    return { kind: 'allow' };
  }
  return { kind: 'deny', reason: opts.includeRecoveryHint === false ? reason : reason };
}

/**
 * Decide the gate for one tool call. Mirrors upstream run() branch order:
 * Edit/Write → Bash(destructive → routine) → allow.
 */
export function decideGate(input: GateInput, ctx: GateContext, callId: string): GateDecision {
  const { toolName, args } = input;

  // ── Edit / Write surface ──
  const filePath = fileTarget(toolName, args);
  if (filePath !== null) {
    if (!filePath || isSettingsPathLike(filePath) || isExemptPath(filePath, ctx.exemptMatchers)) {
      return { kind: 'allow' };
    }
    if (ctx.isSubagent) {
      return { kind: 'allow' }; // parent session already passed the first-touch gate
    }
    if (!ctx.store.isChecked(ctx.sessionKey, filePath)) {
      const { ok, denials } = ctx.store.markCheckedAndCountDenial(ctx.sessionKey, filePath);
      if (!ok) {
        // State could not be persisted; allow rather than risk a retry loop.
        return { kind: 'allow' };
      }
      if (denials > ctx.fullDenials) {
        const action = isWriteTarget(toolName, args) ? 'creation' : 'edit';
        return denyOrWarn(ctx, callId, condensedGateMsg(action, filePath, denials), { includeRecoveryHint: false });
      }
      const msg = isWriteTarget(toolName, args) ? writeGateMsg(filePath) : editGateMsg(filePath);
      return denyOrWarn(ctx, callId, msg);
    }
    return { kind: 'allow' };
  }

  // ── Shell surface (pwsh / bash-like) ──
  if (toolName === 'pwsh' || toolName === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (isReadOnlyGitIntrospection(command)) {
      return { kind: 'allow' };
    }
    if (isDestructiveBash(command, ctx.detectorConfig)) {
      // Gate destructive commands on first attempt; allow retry after facts presented.
      const key = '__destructive__' + createHash('sha256').update(command).digest('hex').slice(0, 16);
      if (!ctx.store.isChecked(ctx.sessionKey, key)) {
        if (!ctx.store.markChecked(ctx.sessionKey, key)) {
          return { kind: 'allow' };
        }
        return denyOrWarn(ctx, callId, destructiveBashMsg(), { includeRecoveryHint: false });
      }
      return { kind: 'allow' };
    }
    if (!ctx.store.isChecked(ctx.sessionKey, ROUTINE_BASH_SESSION_KEY)) {
      if (!ctx.store.markChecked(ctx.sessionKey, ROUTINE_BASH_SESSION_KEY)) {
        return { kind: 'allow' };
      }
      return denyOrWarn(ctx, callId, routineBashMsg(), { includeRecoveryHint: false });
    }
    return { kind: 'allow' };
  }

  return { kind: 'allow' };
}

/** Settings-path exemption (dsh settings file) — mirrors upstream isClaudeSettingsPath. */
function isSettingsPathLike(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)\.dsh\/settings\.yaml$/.test(normalized);
}
