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

// git push detection: allow global options with values (-C <path>, -c key=val)
const GIT_PUSH_RE = /\bgit\s+(?:-[a-zA-Z0-9-]+(?:\s+\S+)?\s+)*push\b/i;

export function isGitPushCommand(command: string): boolean {
  return GIT_PUSH_RE.test(command);
}

// Code-mode carrier: `CodeDispatchLog.exec` is the OUTER run_code execution,
// whose `arguments` are `{ code, description }` (packages/core/tools/src/
// code-mode.ts:505 — the inner sub-call's own arguments are not exposed on
// the event). The command text lives inside the `code` program as a
// `tools.pwsh({ command: ... })` call, often a template literal whose
// interpolations (`${safe}`) cannot be statically expanded. Match per line:
// `git ... push` with anything in between; false positives (e.g.
// `git log --grep=push`) are filtered downstream by the `->` success-marker
// check in maybePushReview.
const GIT_PUSH_LAX_RE = /\bgit\s[^\n]{0,200}\bpush\b/i;

export function isGitPushCommandLax(text: string): boolean {
  return GIT_PUSH_LAX_RE.test(text);
}

export const PUSH_REVIEW_PROMPT = (maxCommits: number): string => [
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
  'Step 3 — when the review is complete, call the structured_output tool with your findings (vulns_found, affected_files, findings). Do not finish with a plain text answer — only the tool call counts.',
].join('\n');

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
export const PUSH_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    // NOTE: `minimum` is NOT a supported keyword in the subagent provider's
    // JSON-schema subset (type/oneOf/properties/required/additionalProperties/
    // items/enum/const + annotations) — including it makes subagents.start
    // throw JsonSchemaError and silently kills the review (real-machine debug
    // log, session "切push-review分支改README提交2").
    vulns_found: { type: 'integer' },
    affected_files: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          issue: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['severity', 'issue', 'suggested_fix'],
      },
    },
  },
  required: ['vulns_found', 'affected_files', 'findings'],
} as const;

export function formatReviewMessage(result: PushReviewResult): string {
  const lines = ['[Fact-Forcing Gate] Push security review:', ''];
  if (result.vulns_found <= 0) {
    lines.push('No vulnerabilities found in the pushed commits.');
    return lines.join('\n');
  }
  lines.push(`Found ${result.vulns_found} issue(s) in: ${result.affected_files.join(', ')}`, '');
  for (const f of result.findings) {
    lines.push(`- [${f.severity}] ${f.issue}`);
    if (f.suggested_fix) lines.push(`  Fix: ${f.suggested_fix}`);
  }
  lines.push('', 'Address each finding, or briefly note why it does not apply.');
  return lines.join('\n');
}
