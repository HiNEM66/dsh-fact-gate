/**
 * Push security review (phase-2): after a `git push` command completes,
 * delegate a sub-agent to audit the pushed commits against a security
 * checklist (auth / IDOR / hardcoded secrets / SQL injection / resource
 * leaks / SSRF), then attach the findings to the tool result via
 * additionalContexts — mirroring CC's security-guidance plugin.
 *
 * Uses ctx.get('subagents') (non-strict, sibling-entry service — see
 * index.ts runPushReview) with a
 * structured output schema; on any failure the review degrades to a notice
 * rather than blocking the push.
 */
// git push detection: allow global options with values (-C <path>, -c key=val)
const GIT_PUSH_RE = /\bgit\s+(?:-[a-zA-Z0-9-]+(?:\s+\S+)?\s+)*push\b/i;
export function isGitPushCommand(command) {
    return GIT_PUSH_RE.test(command);
}
export const PUSH_REVIEW_PROMPT = (maxCommits) => [
    'You are a security reviewer auditing the most recent git commits.',
    '',
    `Step 1 — run \`git log -p --name-only --format=%H%n%s -${maxCommits}\` to see the commits and their full diffs.`,
    'Step 2 — review ONLY the code changed in those diffs for:',
    '  1. Authentication/authorization flaws (IDOR, missing ownership checks, fail-open)',
    '  2. Hardcoded secrets / credentials',
    '  3. Injection (SQL, shell, path traversal, XSS)',
    '  4. Resource leaks (connections, file handles, threads)',
    '  5. SSRF / unsafe external requests',
    '',
    'Do NOT read whole repository source files — the diff above is the complete review scope. Do NOT run any other commands.',
    'Do NOT dismiss findings merely because the service is internal — internal services are common SSRF/IDOR targets.',
    '',
    'Step 3 — return ONLY the JSON: {"vulns_found": <int>, "affected_files": [<string>], "findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "issue": <string>, "suggested_fix": <string>}]}',
    'If no vulnerabilities, return {"vulns_found": 0, "affected_files": [], "findings": []}.',
].join('\n');
export function formatReviewMessage(result) {
    const lines = ['[Fact-Forcing Gate] Push security review:', ''];
    if (result.vulns_found <= 0) {
        lines.push('No vulnerabilities found in the pushed commits.');
        return lines.join('\n');
    }
    lines.push(`Found ${result.vulns_found} issue(s) in: ${result.affected_files.join(', ')}`, '');
    for (const f of result.findings) {
        lines.push(`- [${f.severity}] ${f.issue}`);
        if (f.suggested_fix)
            lines.push(`  Fix: ${f.suggested_fix}`);
    }
    lines.push('', 'Address each finding, or briefly note why it does not apply.');
    return lines.join('\n');
}
//# sourceMappingURL=push-review.js.map