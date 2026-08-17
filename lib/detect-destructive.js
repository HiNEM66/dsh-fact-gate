/**
 * Destructive-command detector — 5 layers, ported verbatim from
 * GateGuard `gateguard-fact-force.js` (isDestructiveBash family).
 *
 * Layer order (same as upstream):
 *   1. SQL/dd phrase regex (after stripQuotedStrings + explodeSubshells)
 *   2. operator-supplied extra regexes (lazy compile, invalid → warning, never crash)
 *   3. find -exec detection over executable bodies (cross-syntax BFS)
 *   4. per-segment rm / git destructive detection (tokenized)
 *   5. quote-aware second pass (quoted command words, newline separators,
 *      quoted find-exec, sh -c wrappers — GHSA-4v57-ph3x-gf55)
 *
 * The upstream code reads operator config from env vars
 * (`GATEGUARD_BASH_EXTRA_DESTRUCTIVE`, `GATEGUARD_EXEMPT_GLOBS`). In dsh we
 * inject a `ConfigSource` instead so the same logic runs against the plugin's
 * live settings (with env fallback). Detection logic itself is unchanged.
 */
import { extractCommandSubstitutions, extractSubshellGroups, extractBraceGroups, } from "./shell-substitution.js";
const ECC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);
const ECC_ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled', 'enable', 'yes']);
// SQL-keyword + dd patterns stay as a single regex — stable phrases without
// shell-flag ordering concerns. Quoted strings are stripped before this regex
// runs so a commit message mentioning "drop table" no longer false-positives.
const DESTRUCTIVE_SQL_DD = /\b(drop\s+table|delete\s+from|truncate|dd\s+if=)\b/i;
/** Escape regex metachars but keep `*` and `?` — for glob→regex compilation. */
function escapeRegexMeta(source) {
    return source.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
/** Normalize a path for matching: forward slashes + lowercase. */
export function normalizeForMatch(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .toLowerCase();
}
/** Strip contents of single/double-quoted strings (destructive phrases in commit messages must not trigger). */
export function stripQuotedStrings(input) {
    return input.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}
/**
 * Promote subshell delimiters to top-level segment separators so the
 * destructive check applies inside `$(...)` and backtick subshells.
 * Run iteratively to handle a layer of nesting.
 */
export function explodeSubshells(input) {
    let out = input;
    for (let i = 0; i < 4; i += 1) {
        const before = out;
        out = out.replace(/\$\(([^()`]*)\)/g, ';$1;');
        out = out.replace(/`([^`]*)`/g, ';$1;');
        if (out === before)
            break;
    }
    return out;
}
/** Split a command line into top-level segments at unquoted separators (`;|&` etc). */
function splitCommandSegments(input) {
    const stripped = explodeSubshells(stripQuotedStrings(input));
    return stripped
        .split(/[;|&]+/)
        .map(segment => segment.replace(/(^|\s)#.*/, '$1').trim())
        .filter(Boolean);
}
/** Tokenize a single command segment by whitespace (quotes already collapsed). */
function tokenize(segment) {
    return segment.split(/\s+/).filter(Boolean);
}
/**
 * Tokenize a short allowlisted shell command while preserving quoted
 * arguments (for read-only git introspection). Returns null on unbalanced
 * quotes (caller then treats the command as non-introspection).
 */
function tokenizeAllowlistedShellWords(input) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (const char of String(input || '')) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (escaped)
        current += '\\';
    if (quote)
        return null;
    if (current)
        tokens.push(current);
    return tokens;
}
const SHELL_SEGMENT_SEPARATORS = new Set([';', '|', '&', '\n', '\r']);
/**
 * Quote-aware split into dequoted token arrays per segment. Splits only on
 * UNQUOTED `;`, `|`, `&`, newlines; quotes are removed from words (a quoted
 * command word `'rm'` normalizes to `rm`).
 */
function quoteAwareSegments(input) {
    const segments = [];
    let words = [];
    let current = '';
    let hasWord = false;
    let quote = null;
    let escaped = false;
    const flushWord = () => {
        if (hasWord)
            words.push(current);
        current = '';
        hasWord = false;
    };
    const flushSegment = () => {
        flushWord();
        if (words.length)
            segments.push(words);
        words = [];
    };
    for (const ch of String(input || '')) {
        if (escaped) {
            current += ch;
            hasWord = true;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            hasWord = true;
            continue;
        }
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                current += ch;
            hasWord = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasWord = true;
            continue;
        }
        if (SHELL_SEGMENT_SEPARATORS.has(ch)) {
            flushSegment();
            continue;
        }
        if (/\s/.test(ch)) {
            flushWord();
            continue;
        }
        current += ch;
        hasWord = true;
    }
    flushSegment();
    return segments;
}
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** Strip a leading path and trailing `.exe` from a command token. */
function commandBasename(token) {
    if (!token)
        return '';
    return token
        .replace(/^.*[\\/]/, '')
        .replace(/\.exe$/i, '')
        .toLowerCase();
}
/** Detect `rm -r -f` (combined `-rf`/`-fr`/`-Rf` and split forms). */
function isDestructiveRm(tokens) {
    if (tokens.length === 0 || commandBasename(tokens[0]) !== 'rm')
        return false;
    let hasR = false;
    let hasF = false;
    for (const t of tokens.slice(1)) {
        if (t === '--recursive') {
            hasR = true;
            continue;
        }
        if (t === '--force') {
            hasF = true;
            continue;
        }
        if (!t.startsWith('-') || t.startsWith('--'))
            continue;
        const body = t.slice(1);
        if (/[rR]/.test(body))
            hasR = true;
        if (/f/.test(body))
            hasF = true;
    }
    return hasR && hasF;
}
/** Locate the git subcommand, skipping git global options. */
function findGitSubcommand(tokens) {
    if (tokens.length === 0 || commandBasename(tokens[0]) !== 'git')
        return null;
    const valueConsumingShort = new Set(['-c', '-C']);
    const valueConsumingLong = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix']);
    let i = 1;
    while (i < tokens.length) {
        const t = tokens[i];
        if (valueConsumingShort.has(t) || valueConsumingLong.has(t)) {
            i += 2;
            continue;
        }
        if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t.startsWith('--namespace=') || t.startsWith('--super-prefix=')) {
            i += 1;
            continue;
        }
        if (t.startsWith('-')) {
            i += 1;
            continue;
        }
        return { command: t.toLowerCase(), rest: tokens.slice(i + 1) };
    }
    return null;
}
/**
 * Detect destructive git invocations: reset --hard, checkout --/. /--force,
 * clean -f, push --force (not --force-with-lease; `+refspec` counts),
 * commit --amend, rm -r, switch --discard-changes/--force/-C.
 */
function isDestructiveGit(tokens) {
    const sub = findGitSubcommand(tokens);
    if (!sub)
        return false;
    const { command, rest } = sub;
    if (command === 'reset') {
        return rest.includes('--hard');
    }
    if (command === 'checkout') {
        return rest.some(t => {
            if (t === '--' || t === '.' || t === '--force')
                return true;
            if (!t.startsWith('-') || t.startsWith('--'))
                return false;
            return t.slice(1).includes('f');
        });
    }
    if (command === 'clean') {
        return rest.some(t => {
            if (t === '--force')
                return true;
            if (!t.startsWith('-') || t.startsWith('--'))
                return false;
            return t.slice(1).includes('f');
        });
    }
    if (command === 'push') {
        let withLease = false;
        let bareForce = false;
        let plusRefspecForce = false;
        for (const t of rest) {
            if (t === '--force-with-lease' || t.startsWith('--force-with-lease=')) {
                withLease = true;
                continue;
            }
            if (t === '--force' || t.startsWith('--force=')) {
                bareForce = true;
                continue;
            }
            if (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes('f')) {
                bareForce = true;
                continue;
            }
            // Refspec prefix: `+<src>[:<dst>]`. Exclude bare `+` and numeric-only `+123`.
            if (t.startsWith('+') && t.length > 1 && /^\+(?:[a-zA-Z_/.:]|HEAD)/.test(t)) {
                plusRefspecForce = true;
            }
        }
        return bareForce || (plusRefspecForce && !withLease);
    }
    if (command === 'commit') {
        return rest.includes('--amend');
    }
    if (command === 'rm') {
        let hasR = false;
        for (const t of rest) {
            if (!t.startsWith('-') || t.startsWith('--'))
                continue;
            if (/[rR]/.test(t.slice(1)))
                hasR = true;
        }
        return hasR;
    }
    if (command === 'switch') {
        return rest.some(t => {
            if (t === '--discard-changes' || t === '--force')
                return true;
            if (!t.startsWith('-') || t.startsWith('--'))
                return false;
            return /[fC]/.test(t.slice(1));
        });
    }
    return false;
}
/**
 * Walk every executable body reachable from a raw command line (cross-syntax
 * BFS over $(...)/backticks/subshells/brace-groups). A `seen` set bounds cost.
 */
function collectExecutableBodies(raw) {
    const bodies = [raw];
    const queue = [raw];
    const seen = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (seen.has(current))
            continue;
        seen.add(current);
        for (const body of extractCommandSubstitutions(current)) {
            if (seen.has(body))
                continue;
            bodies.push(body);
            queue.push(body);
        }
        for (const body of extractSubshellGroups(current)) {
            if (seen.has(body))
                continue;
            bodies.push(body);
            queue.push(body);
        }
        for (const body of extractBraceGroups(current)) {
            if (seen.has(body))
                continue;
            bodies.push(body);
            queue.push(body);
        }
    }
    return bodies;
}
/** Detect destructive commands inside `find ... -exec` (rm/rmdir/unlink/git reset --hard). */
function isDestructiveFindExec(command) {
    const raw = String(command || '');
    const trimmed = raw.trim();
    if (!trimmed)
        return false;
    const tokens = tokenize(trimmed);
    if (!tokens || tokens.length === 0)
        return false;
    if (commandBasename(tokens[0]) !== 'find')
        return false;
    const execIndex = tokens.indexOf('-exec');
    if (execIndex === -1)
        return false;
    const execTokens = [];
    for (let i = execIndex + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === ';' || token === '\\;' || token === '+')
            break;
        execTokens.push(token);
    }
    if (execTokens.length === 0)
        return false;
    const baseCmd = commandBasename(execTokens[0]);
    if (baseCmd === 'rmdir' || baseCmd === 'unlink')
        return true;
    if (baseCmd === 'rm')
        return true;
    if (baseCmd === 'git') {
        const sub = findGitSubcommand(execTokens);
        if (sub && sub.command === 'reset' && sub.rest.includes('--hard'))
            return true;
    }
    return false;
}
/**
 * PowerShell 原生破坏性 cmdlet（dsh 命令面是 pwsh，需与 bash 检测并列）。
 * 覆盖 Remove-Item 等非 rm 别名形态 — bash token 检测漏掉的真实盲区
 * (Remove-Item -LiteralPath X -Force 实测逃过门禁)。
 * 保守选取: 仅明确破坏性(删除/清空/格式化/磁盘初始化), 不含无害 cmdlet
 * (如 clear-variable / remove-variable)。
 */
const PW_DESTRUCTIVE_CMDLETS = new Set([
    'remove-item', 'remove-childitem', 'remove-itemproperty', 'remove-pssnapin',
    'clear-content', 'clear-item', 'clear-recyclebin', 'clear-disk',
    'format-volume', 'format-disk', 'initialize-disk',
]);
function isDestructivePwsh(tokens) {
    if (tokens.length === 0)
        return false;
    return PW_DESTRUCTIVE_CMDLETS.has(commandBasename(tokens[0]));
}
/**
 * Quote-aware destructive pass (layer 5): catches quoted command words,
 * newline separators, quoted find-exec, and sh -c / bash -c wrappers
 * (GHSA-4v57-ph3x-gf55). Recursion guard for shell -c wrappers.
 */
function isDestructiveQuoteAware(raw, depth = 0, config) {
    if (depth > 4)
        return false;
    for (const tokens of quoteAwareSegments(raw)) {
        if (tokens.length === 0)
            continue;
        if (isDestructiveRm(tokens))
            return true;
        if (isDestructiveGit(tokens))
            return true;
        if (isDestructivePwsh(tokens))
            return true;
        if (isDestructiveFindExec(tokens.join(' ')))
            return true;
        const base = commandBasename(tokens[0]);
        if (SHELL_WRAPPERS.has(base)) {
            const ci = tokens.indexOf('-c');
            if (ci !== -1 && tokens[ci + 1] && isDestructiveQuoteAware(tokens[ci + 1], depth + 1, config)) {
                return true;
            }
        }
    }
    return false;
}
/** Is the command read-only git introspection (git status/diff/log/show/branch/rev-parse)? */
export function isReadOnlyGitIntrospection(command) {
    const trimmed = String(command || '').trim();
    if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) {
        return false;
    }
    const segments = splitCommandSegments(trimmed);
    if (segments.length !== 1) {
        return false;
    }
    const tokens = tokenizeAllowlistedShellWords(trimmed);
    if (!tokens) {
        return false;
    }
    if (commandBasename(tokens[0]) !== 'git' || tokens.length < 2) {
        return false;
    }
    const subcommand = tokens[1].toLowerCase();
    const args = tokens.slice(2);
    if (subcommand === 'status') {
        return args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg));
    }
    if (subcommand === 'diff') {
        const allowedDiffArgs = new Set(['--name-only', '--name-status', '--cached', '--staged', '--stat']);
        if (args.length === 0)
            return true;
        return args.length <= 2 && args.every(arg => allowedDiffArgs.has(arg));
    }
    if (subcommand === 'log') {
        return args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg));
    }
    if (subcommand === 'show') {
        if (args.length === 0)
            return false;
        if (args.length === 1) {
            const arg = args[0];
            if (arg === '--stat' || arg === '--name-only')
                return true;
            return !arg.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(arg);
        }
        if (args.length === 2) {
            const [first, second] = args;
            if (!first.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(first) && (second === '--stat' || second === '--name-only')) {
                return true;
            }
            return false;
        }
        return false;
    }
    if (subcommand === 'branch') {
        return args.length === 1 && args[0] === '--show-current';
    }
    if (subcommand === 'rev-parse') {
        return args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]);
    }
    return false;
}
/** Exempt glob → regex (supports `**` across segments, `*` within, `?` single char). */
export function compileExemptGlobs(globs) {
    const out = [];
    for (const raw of globs) {
        const glob = String(raw || '').trim();
        if (!glob)
            continue;
        const source = escapeRegexMeta(glob)
            .split('**')
            .map(part => part.replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
            .join('.*');
        try {
            out.push(new RegExp(source));
        }
        catch (_) {
            // Malformed pattern is dropped — fail-open, never throws.
        }
    }
    return out;
}
/** Is the normalized path exempt per the configured globs? */
export function isExemptPath(filePath, matchers) {
    const norm = normalizeForMatch(filePath);
    return matchers.some(re => re.test(norm));
}
/** Does the command contain a destructive action (5-layer detection)? */
export function isDestructiveBash(command, config) {
    const raw = String(command || '');
    // Layer 1: SQL/dd phrases — on quote-stripped, subshell-exploded input so
    // phrases inside `$(...)` or backticks are also caught.
    const flattened = explodeSubshells(stripQuotedStrings(raw));
    if (DESTRUCTIVE_SQL_DD.test(flattened))
        return true;
    // Layer 2: operator-supplied extra patterns, same scope.
    const extra = compileExtraRegexes(config.bashExtraDestructive);
    if (extra.some(re => re.test(flattened)))
        return true;
    // Layer 3: find -exec on raw executable bodies (before quote-stripping so
    // quoted exec binaries like `'rm'` are still caught).
    const bodies = collectExecutableBodies(raw);
    for (const body of bodies) {
        for (const rawSeg of body
            .split(/[;|&]+/)
            .map(s => s.trim())
            .filter(Boolean)) {
            if (isDestructiveFindExec(rawSeg))
                return true;
        }
    }
    // Layer 4: per-segment rm / git detection.
    const segments = bodies.flatMap(splitCommandSegments);
    for (const segment of segments) {
        const stripped = stripQuotedStrings(segment);
        if (DESTRUCTIVE_SQL_DD.test(stripped))
            return true;
        if (extra.some(re => re.test(stripped)))
            return true;
        const tokens = tokenize(segment);
        if (isDestructiveRm(tokens))
            return true;
        if (isDestructiveGit(tokens))
            return true;
        if (isDestructivePwsh(tokens))
            return true;
    }
    // Layer 5: quote-aware pass.
    if (isDestructiveQuoteAware(raw, 0, config))
        return true;
    return false;
}
/** Compile operator extra destructive regexes (case-insensitive, fail-open). */
export function compileExtraRegexes(sources) {
    const out = [];
    for (const raw of sources) {
        const src = String(raw || '').trim();
        if (!src)
            continue;
        try {
            out.push(new RegExp(src, 'i'));
        }
        catch (_) {
            // Invalid regex treated as "not configured" — never crash tool execution.
        }
    }
    return out;
}
export function isRoutineBashGateDisabled(value) {
    return ECC_ENABLE_VALUES.has(String(value || '').trim().toLowerCase());
}
export function isGateGuardDisabled(value, disableValues = ECC_DISABLE_VALUES) {
    return disableValues.has(String(value || '').trim().toLowerCase());
}
//# sourceMappingURL=detect-destructive.js.map