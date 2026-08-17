/**
 * run_code danger-API advisory (phase-1 addition, per plan §10.7.3).
 *
 * `run_code` executes TypeScript in the harness runtime — the fact gates
 * cannot parse its semantics, and a heuristic deny would be unreliable. So
 * instead of gating, we attach a context message to the tool result when the
 * code string contains danger-API patterns (file deletion, child processes,
 * process kill, shell execution). The model sees the advisory and must weigh
 * it — advisory, not denial (decision #3, plan §10.7).
 */
/** Danger-API patterns (heuristic, advisory only). */
const DANGER_PATTERNS = [
    { label: 'file deletion', re: /\b(?:fs\.)?(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/ },
    { label: 'recursive force delete', re: /\b(?:rm|rmSync)\([^)]*\{\s*(?:recursive|force)\s*:/ },
    { label: 'child process spawn/exec', re: /\b(?:child_process|cp)\.(?:exec|execSync|spawn|spawnSync|fork)\s*\(/ },
    { label: 'process kill', re: /\bprocess\.kill\s*\(/ },
    { label: 'shell command execution', re: /\b(?:execFile|execFileSync)\s*\(/ },
    { label: 'write to sensitive path', re: /\b(?:fs\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\([^,)]*(?:\/etc\/|\/home\/|\/root\/)/ },
];
/** Scan a code string for danger-API patterns; return matched labels (empty = safe). */
export function scanDangerApis(code) {
    const hits = [];
    for (const { label, re } of DANGER_PATTERNS) {
        if (re.test(code))
            hits.push(label);
    }
    return hits;
}
/** Build the advisory message injected as additional context (not a denial). */
export function dangerAdvisoryMessage(labels) {
    return [
        '[Fact-Forcing Gate] run_code advisory:',
        '',
        `This code contains danger-API patterns: ${labels.join(', ')}.`,
        'Confirm the operation is intended, review the affected paths/data, and state the user instruction it serves.',
    ].join('\n');
}
//# sourceMappingURL=run-code-advisory.js.map