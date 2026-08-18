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
/**
 * outputSchema for the review subagent (dsh-subagent structured runtime):
 * the child must call the structured_output tool with arguments matching
 * this schema; the provider validates and returns it as `run.structured`.
 */
export declare const PUSH_REVIEW_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly vulns_found: {
            readonly type: "integer";
            readonly minimum: 0;
        };
        readonly affected_files: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly findings: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly severity: {
                        readonly type: "string";
                        readonly enum: readonly ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
                    };
                    readonly issue: {
                        readonly type: "string";
                    };
                    readonly suggested_fix: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly ["severity", "issue", "suggested_fix"];
            };
        };
    };
    readonly required: readonly ["vulns_found", "affected_files", "findings"];
};
export declare function formatReviewMessage(result: PushReviewResult): string;
