/**
 * Fact-Forcing Gate message templates — ported verbatim from GateGuard
 * `gateguard-fact-force.js` (messages section, lines 1054-1166).
 *
 * The recovery hint mentions FACT_GATE instead of ECC_GATEGUARD (dsh env),
 * and hook ids reference the dsh plugin's hook names.
 */
import { sanitizePath } from "./state.js";
export const EDIT_WRITE_HOOK_ID = 'pre:edit-write:fact-gate';
export const BASH_HOOK_ID = 'pre:bash:fact-gate';
export function editGateMsg(filePath) {
    const safe = sanitizePath(filePath);
    return [
        '[Fact-Forcing Gate]',
        '',
        `Before editing ${safe}, present these facts:`,
        '',
        '1. List ALL files that import/require this file (search the tree — Glob/Grep, or find/grep via Bash)',
        '2. List the public functions/classes affected by this change',
        '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
        "4. Quote the user's current instruction verbatim",
        '',
        'Present the facts, then retry the same operation.',
    ].join('\n');
}
export function writeGateMsg(filePath) {
    const safe = sanitizePath(filePath);
    return [
        '[Fact-Forcing Gate]',
        '',
        `Before creating ${safe}, present these facts:`,
        '',
        '1. Name the file(s) and line(s) that will call this new file',
        '2. Confirm no existing file serves the same purpose (search the tree — Glob/Grep, or find/grep via Bash)',
        '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
        "4. Quote the user's current instruction verbatim",
        '',
        'Present the facts, then retry the same operation.',
    ].join('\n');
}
/**
 * Condensed single-line denial used after the full-block budget is spent.
 * Carries the denial ordinal so consecutive denials differ textually.
 */
export function condensedGateMsg(action, filePath, ordinal) {
    const safe = sanitizePath(filePath);
    return (`[Fact-Forcing Gate] (denial #${ordinal} this session) First ${action} of ${safe}: ` +
        "briefly state importers/callers, affected API, data schemas if any, and the user's verbatim instruction, then retry. " +
        '(FACT_GATE=off disables this gate.)');
}
export function destructiveBashMsg() {
    return [
        '[Fact-Forcing Gate]',
        '',
        'Destructive command detected. Before running, present:',
        '',
        '1. List all files/data this command will modify or delete',
        '2. Write a one-line rollback procedure',
        "3. Quote the user's current instruction verbatim",
        '',
        'Present the facts, then retry the same operation.',
    ].join('\n');
}
export function routineBashMsg() {
    return [
        '[Fact-Forcing Gate]',
        '',
        'Before the first Bash command this session, present these facts:',
        '',
        '1. The current user request in one sentence',
        '2. What this specific command verifies or produces',
        '',
        'Present the facts, then retry the same operation.',
    ].join('\n');
}
export function withRecoveryHint(message, hookIds = [EDIT_WRITE_HOOK_ID]) {
    const disableTargets = hookIds.map(hookId => `\`${hookId}\``).join(' or ');
    return [message, '', `Recovery: if GateGuard is blocking setup or repair work, run this session with \`FACT_GATE=off\` or add ${disableTargets} to \`FACT_GATE_DISABLED_HOOKS\`.`].join('\n');
}
//# sourceMappingURL=messages.js.map