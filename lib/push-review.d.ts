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
export interface PushReviewConfig {
    enabled: boolean;
    /** Subagent provider name; empty = use the first registered provider. */
    provider: string;
    /** How many commits (from HEAD) to audit. */
    maxCommits: number;
}
export declare function isGitPushCommand(command: string): boolean;
export declare const PUSH_REVIEW_PROMPT: (maxCommits: number) => string;
export interface PushFinding {
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    issue: string;
    suggested_fix: string;
}
export interface PushReviewResult {
    vulns_found: number;
    affected_files: string[];
    findings: PushFinding[];
}
export declare function formatReviewMessage(result: PushReviewResult): string;
