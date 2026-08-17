/**
 * Shell command-substitution / subshell / brace-group extractors.
 *
 * Direct port of the GateGuard `scripts/lib/shell-substitution.js` (510 lines,
 * CommonJS) to ESM TypeScript, logic preserved verbatim — used by the
 * destructive-command detector to peer inside `$(...)`, backticks, `(...)`
 * and `{ ...; }` groups so a destructive command cannot hide inside them.
 *
 * Quote semantics (bash):
 * - Single quotes are literal: `'( ... )'` is a string, not a subshell.
 * - Double quotes are literal for bare parens/braces but still permit `$(...)`.
 */
/** Extract executable command-substitution bodies (`$(...)` and backticks), recursing for nesting. */
export declare function extractCommandSubstitutions(input: string): string[];
/** Extract bodies of plain `(...)` subshell groups, recursing for nesting. */
export declare function extractSubshellGroups(input: string): string[];
/**
 * Extract bodies of `{ ...; }` brace groups (bash reserved-word semantics:
 * `{` needs a following whitespace and a preceding boundary; `}` needs a
 * preceding `;` or whitespace). Recurses for nesting.
 */
export declare function extractBraceGroups(input: string): string[];
