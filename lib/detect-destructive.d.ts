/** Config knobs the detector needs (live settings or env fallback). */
export interface DetectorConfig {
    /** Operator-supplied extra destructive regex sources (layer 2). */
    bashExtraDestructive: string[];
    /** Comma-separated exempt globs (also used by path exemption). */
    exemptGlobs: string[];
}
/** Config provider indirection so unit tests can inject without settings. */
export type ConfigSource = () => DetectorConfig;
/** Normalize a path for matching: forward slashes + lowercase. */
export declare function normalizeForMatch(value: string): string;
/** Strip contents of single/double-quoted strings (destructive phrases in commit messages must not trigger). */
export declare function stripQuotedStrings(input: string): string;
/**
 * Promote subshell delimiters to top-level segment separators so the
 * destructive check applies inside `$(...)` and backtick subshells.
 * Run iteratively to handle a layer of nesting.
 */
export declare function explodeSubshells(input: string): string;
/** Is the command read-only git introspection (git status/diff/log/show/branch/rev-parse)? */
export declare function isReadOnlyGitIntrospection(command: string): boolean;
/** Exempt glob → regex (supports `**` across segments, `*` within, `?` single char). */
export declare function compileExemptGlobs(globs: string[]): RegExp[];
/** Is the normalized path exempt per the configured globs? */
export declare function isExemptPath(filePath: string, matchers: RegExp[]): boolean;
/** Does the command contain a destructive action (5-layer detection)? */
export declare function isDestructiveBash(command: string, config: DetectorConfig): boolean;
/** Compile operator extra destructive regexes (case-insensitive, fail-open). */
export declare function compileExtraRegexes(sources: string[]): RegExp[];
export declare function isRoutineBashGateDisabled(value: string | undefined): boolean;
export declare function isGateGuardDisabled(value: string | undefined, disableValues?: Set<string>): boolean;
