import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isDestructiveBash, isReadOnlyGitIntrospection, compileExemptGlobs, isExemptPath, compileExtraRegexes } from '../lib/detect-destructive.js'
import { FactGateStateStore, MAX_CHECKED_ENTRIES, MAX_SESSION_KEYS, SESSION_TIMEOUT_MS } from '../lib/state.js'
import { editGateMsg, writeGateMsg, destructiveBashMsg, routineBashMsg, condensedGateMsg } from '../lib/messages.js'
import { decideGate } from '../lib/gates.js'
import { scanDangerApis, dangerAdvisoryMessage } from '../lib/run-code-advisory.js'
import { ScopeWarningTracker } from '../lib/scope-warning.js'
import { DuplicateReadTracker } from '../lib/duplicate-read.js'
import { isGitPushCommand, isGitPushCommandLax, formatReviewMessage } from '../lib/push-review.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-test-'))
  return { dir, store: new FactGateStateStore(dir) }
}

const EMPTY_CONFIG = { bashExtraDestructive: [], exemptGlobs: [] }

// ── 1. Destructive detector: layer cases ──
describe('detect-destructive: layer 1 (SQL/dd phrases)', () => {
  it('catches drop table / delete from / truncate / dd if=', () => {
    assert.equal(isDestructiveBash('DROP TABLE users', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('DELETE FROM logs WHERE 1=1', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('truncate table t', EMPTY_CONFIG), true)
    // upstream \b(dd\s+if=)\b requires a \w boundary after `if=` — a path
    // starting with `/` does not match (upstream-identical behavior)
    assert.equal(isDestructiveBash('dd if=file.bin', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('dd if=/dev/zero of=/dev/sda', EMPTY_CONFIG), false)
  })
  it('does not false-positive on quoted commit messages', () => {
    assert.equal(isDestructiveBash('git commit -m "drop table is bad"', EMPTY_CONFIG), false)
    // quoted SQL phrase is inert by design (stripQuotedStrings — the same
    // mechanism that protects commit messages)
    assert.equal(isDestructiveBash('echo "DROP TABLE users"', EMPTY_CONFIG), false)
  })
  it('catches phrases inside $(...) and backticks', () => {
    assert.equal(isDestructiveBash('echo $(DROP TABLE x)', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('echo `truncate table x`', EMPTY_CONFIG), true)
  })
})

describe('detect-destructive: layer 2 (operator extra regexes)', () => {
  it('matches custom destructive patterns', () => {
    const cfg = { bashExtraDestructive: ['git\\s+push\\s+--force-with-lease'], exemptGlobs: [] }
    assert.equal(isDestructiveBash('git push --force-with-lease origin main', cfg), true)
    assert.equal(isDestructiveBash('git push origin main', cfg), false)
  })
  it('drops malformed regex without crashing', () => {
    const cfg = { bashExtraDestructive: ['[invalid'], exemptGlobs: [] }
    assert.equal(compileExtraRegexes(['[invalid']).length, 0)
    assert.equal(isDestructiveBash('ls', cfg), false)
  })
})

describe('detect-destructive: layer 3 (find -exec)', () => {
  it('catches find -exec rm', () => {
    assert.equal(isDestructiveBash('find . -exec rm {} \\;', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('find . -exec rm -rf {} +', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('find . -exec rmdir {} \\;', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('find . -exec unlink {} \\;', EMPTY_CONFIG), true)
  })
  it('catches find -exec inside $(...)', () => {
    assert.equal(isDestructiveBash('echo $(find . -exec rm {} \\;)', EMPTY_CONFIG), true)
  })
})

describe('detect-destructive: layer 4 (rm / git)', () => {
  it('catches rm -rf in combined and split flag forms', () => {
    assert.equal(isDestructiveBash('rm -rf /tmp/x', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('rm -fr /tmp/x', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('rm -Rf /tmp/x', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('rm -r -f /tmp/x', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('rm --recursive --force /tmp/x', EMPTY_CONFIG), true)
  })
  it('does not catch plain rm without force', () => {
    assert.equal(isDestructiveBash('rm /tmp/x', EMPTY_CONFIG), false)
    assert.equal(isDestructiveBash('rm -r /tmp/x', EMPTY_CONFIG), false)
  })
  it('catches destructive git subcommands', () => {
    assert.equal(isDestructiveBash('git reset --hard HEAD~1', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('git clean -fd', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('git push --force origin main', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('git push origin +main', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('git checkout -- src/', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('git commit --amend', EMPTY_CONFIG), true)
  })
  it('allows --force-with-lease and plain push', () => {
    assert.equal(isDestructiveBash('git push --force-with-lease origin main', EMPTY_CONFIG), false)
    assert.equal(isDestructiveBash('git push origin main', EMPTY_CONFIG), false)
  })
})

describe('detect-destructive: pwsh native cmdlets (dsh command surface)', () => {
  it('catches Remove-Item in all forms', () => {
    assert.equal(isDestructiveBash('Remove-Item -LiteralPath C:/tmp/x -Force', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('remove-item -Recurse -Force D:/x', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('Remove-ItemProperty HKLM:\\Software\\x -Name y', EMPTY_CONFIG), true)
  })
  it('catches Clear-Content / Clear-Item / Clear-RecycleBin', () => {
    assert.equal(isDestructiveBash('Clear-Content file.txt', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('Clear-Item D:/logs/*', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('Clear-RecycleBin -Force', EMPTY_CONFIG), true)
  })
  it('catches disk format / initialization cmdlets', () => {
    assert.equal(isDestructiveBash('Format-Volume -DriveLetter C -Force', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('Initialize-Disk -Number 1', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('Clear-Disk -Number 2 -RemoveData', EMPTY_CONFIG), true)
  })
  it('does not false-positive on harmless pwsh cmdlets', () => {
    assert.equal(isDestructiveBash('Get-Item C:/x', EMPTY_CONFIG), false)
    assert.equal(isDestructiveBash('Set-Content file.txt hello', EMPTY_CONFIG), false)
    assert.equal(isDestructiveBash('Write-Host "Remove-Item is mentioned in docs"', EMPTY_CONFIG), false)
    assert.equal(isDestructiveBash('Get-Process', EMPTY_CONFIG), false)
  })
  it('catches quoted pwsh cmdlet words (layer 5)', () => {
    assert.equal(isDestructiveBash("'Remove-Item' -Recurse -Force D:/x", EMPTY_CONFIG), true)
  })
})

describe('detect-destructive: layer 5 (quote-aware bypasses, GHSA-4v57-ph3x-gf55)', () => {
  it('catches quoted command words', () => {
    assert.equal(isDestructiveBash("'rm' -rf /tmp/x", EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('"rm" -rf /tmp/x', EMPTY_CONFIG), true)
  })
  it('catches newline-separated commands', () => {
    assert.equal(isDestructiveBash('echo hi\nrm -rf /tmp/x', EMPTY_CONFIG), true)
  })
  it('catches quoted find -exec binaries', () => {
    assert.equal(isDestructiveBash("find . -exec 'rm' {} \\;", EMPTY_CONFIG), true)
  })
  it('catches sh -c wrappers', () => {
    assert.equal(isDestructiveBash('sh -c "rm -rf /tmp/x"', EMPTY_CONFIG), true)
    assert.equal(isDestructiveBash('bash -c "git reset --hard"', EMPTY_CONFIG), true)
  })
  it('does not false-positive on quoted harmless text', () => {
    assert.equal(isDestructiveBash('echo "rm -rf is mentioned in docs"', EMPTY_CONFIG), false)
  })
})

describe('detect-destructive: read-only git introspection exemption', () => {
  it('allows git status/diff/log/show/branch/rev-parse', () => {
    assert.equal(isReadOnlyGitIntrospection('git status --porcelain'), true)
    assert.equal(isReadOnlyGitIntrospection('git diff --name-only'), true)
    assert.equal(isReadOnlyGitIntrospection('git log --oneline --max-count=10'), true)
    assert.equal(isReadOnlyGitIntrospection('git show HEAD --stat'), true)
    assert.equal(isReadOnlyGitIntrospection('git branch --show-current'), true)
    assert.equal(isReadOnlyGitIntrospection('git rev-parse --abbrev-ref HEAD'), true)
  })
  it('rejects non-git / compound commands', () => {
    assert.equal(isReadOnlyGitIntrospection('ls'), false)
    assert.equal(isReadOnlyGitIntrospection('git status; rm -rf /'), false)
    assert.equal(isReadOnlyGitIntrospection('git checkout main'), false)
  })
})

describe('detect-destructive: exempt globs', () => {
  it('compiles globs with ** and ?', () => {
    const matchers = compileExemptGlobs(['node_modules/**', 'dist/?est'])
    assert.equal(isExemptPath('node_modules/foo/bar.js', matchers), true)
    assert.equal(isExemptPath('dist/test.js', matchers), true)
    assert.equal(isExemptPath('src/foo.js', matchers), false)
  })
  it('handles malformed globs fail-open (never throws)', () => {
    // escapeRegexMeta escapes all metachars, so compile never throws — the
    // fail-open contract is "never crash tool execution".
    assert.doesNotThrow(() => compileExemptGlobs(['[bad', 'node_modules/**']))
    assert.equal(compileExemptGlobs(['[bad']).length, 1) // '[bad' compiles as literal
  })
})

// ── 2. State machine ──
describe('state: checked set + prune', () => {
  it('marks and checks keys', () => {
    const { store } = tempStore()
    assert.equal(store.isChecked('s1', 'file-a'), false)
    store.markChecked('s1', 'file-a')
    assert.equal(store.isChecked('s1', 'file-a'), true)
  })
  it('prunes beyond MAX_CHECKED_ENTRIES (keeps session keys + LRU tail)', () => {
    const { store } = tempStore()
    const keys = []
    for (let i = 0; i < MAX_CHECKED_ENTRIES + 100; i++) keys.push(`f${i}`)
    keys.forEach(k => store.markChecked('s1', k))
    const state = store.load('s1')
    assert.ok(state.checked.length <= MAX_CHECKED_ENTRIES, `checked=${state.checked.length}`)
    // newest keys survive (tail of the file list)
    assert.ok(state.checked.includes(`f${MAX_CHECKED_ENTRIES + 99}`))
  })
  it('caps session keys at MAX_SESSION_KEYS (when prune triggers)', () => {
    const { store } = tempStore()
    // Prune only triggers past MAX_CHECKED_ENTRIES total — fill with files first
    for (let i = 0; i < MAX_CHECKED_ENTRIES + 60; i++) store.markChecked('s1', `f${i}`)
    for (let i = 0; i < MAX_SESSION_KEYS + 10; i++) store.markChecked('s1', `__destructive__${i}`)
    const state = store.load('s1')
    const sessionKeys = state.checked.filter(k => k.startsWith('__'))
    assert.ok(sessionKeys.length <= MAX_SESSION_KEYS, `sessionKeys=${sessionKeys.length}`)
  })
  it('expires after SESSION_TIMEOUT_MS', async () => {
    const { dir, store } = tempStore()
    store.markChecked('s1', 'file-a')
    // Rewrite state with an old last_active
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'state-s1.json'), JSON.stringify({ checked: ['file-a'], last_active: Date.now() - SESSION_TIMEOUT_MS - 1000, fact_force_denials: 0 }))
    assert.equal(store.isChecked('s1', 'file-a'), false)
  })
  it('writes atomically and survives concurrent merge', () => {
    const { store } = tempStore()
    store.markChecked('s1', 'a')
    store.markChecked('s1', 'b') // second save merges with disk state
    const state = store.load('s1')
    assert.ok(state.checked.includes('a') && state.checked.includes('b'))
  })
})

// ── 3. Denial budget ──
describe('gates: denial budget condenses after fullDenials', () => {
  it('emits full block first, condensed after budget', () => {
    const { store } = tempStore()
    const ctx = (sessionKey, file) => ({
      store, sessionKey, exemptMatchers: [], detectorConfig: EMPTY_CONFIG,
      fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: false,
    })
    // first file → full edit message
    const d1 = decideGate({ toolName: 'edit', args: { file_path: '/x/a.ts' } }, ctx('s1', ''), 'c1')
    assert.equal(d1.kind, 'deny')
    assert.match(d1.reason, /Before editing/)
    // 2nd file → full
    const d2 = decideGate({ toolName: 'edit', args: { file_path: '/x/b.ts' } }, ctx('s1', ''), 'c2')
    assert.match(d2.reason, /Before editing/)
    // 3rd file → full (budget = 3)
    const d3 = decideGate({ toolName: 'edit', args: { file_path: '/x/c.ts' } }, ctx('s1', ''), 'c3')
    assert.match(d3.reason, /Before editing/)
    // 4th file → condensed single line
    const d4 = decideGate({ toolName: 'edit', args: { file_path: '/x/d.ts' } }, ctx('s1', ''), 'c4')
    assert.match(d4.reason, /\(denial #4 this session\)/)
    assert.ok(!d4.reason.includes('List ALL files'))
  })
  it('retry of same file passes (DENY→FORCE→ALLOW)', () => {
    const { store } = tempStore()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: false }
    const d1 = decideGate({ toolName: 'edit', args: { file_path: '/x/a.ts' } }, ctx, 'c1')
    assert.equal(d1.kind, 'deny')
    const d2 = decideGate({ toolName: 'edit', args: { file_path: '/x/a.ts' } }, ctx, 'c2')
    assert.equal(d2.kind, 'allow')
  })
})

// ── 4. Tool surface mapping ──
describe('gates: tool surface mapping', () => {
  it('str_replace_editor create → write gate; str_replace/insert → edit gate; view → allow', () => {
    const { store } = tempStore()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: false }
    const w = decideGate({ toolName: 'str_replace_editor', args: { command: 'create', path: '/x/new.ts' } }, ctx, 'c1')
    assert.match(w.reason, /Before creating/)
    const e = decideGate({ toolName: 'str_replace_editor', args: { command: 'str_replace', path: '/x/a.ts' } }, ctx, 'c2')
    assert.match(e.reason, /Before editing/)
    const v = decideGate({ toolName: 'str_replace_editor', args: { command: 'view', path: '/x/a.ts' } }, ctx, 'c3')
    assert.equal(v.kind, 'allow')
  })
  it('pwsh destructive gate denies per command, retry allows', () => {
    const { store } = tempStore()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: false }
    const d1 = decideGate({ toolName: 'pwsh', args: { command: 'rm -rf /tmp/x' } }, ctx, 'c1')
    assert.equal(d1.kind, 'deny')
    assert.match(d1.reason, /Destructive command detected/)
    const d2 = decideGate({ toolName: 'pwsh', args: { command: 'rm -rf /tmp/x' } }, ctx, 'c2')
    assert.equal(d2.kind, 'allow') // same command retry after facts
    // different destructive command still gated
    const d3 = decideGate({ toolName: 'pwsh', args: { command: 'git reset --hard' } }, ctx, 'c3')
    assert.equal(d3.kind, 'deny')
  })
  it('pwsh routine gate fires once per session', () => {
    const { store } = tempStore()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: false }
    const r1 = decideGate({ toolName: 'pwsh', args: { command: 'ls' } }, ctx, 'c1')
    assert.match(r1.reason, /Before the first Bash command/)
    const r2 = decideGate({ toolName: 'pwsh', args: { command: 'ls' } }, ctx, 'c2')
    assert.equal(r2.kind, 'allow')
  })
  it('subagent exemption skips edit gate', () => {
    const { store } = tempStore()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: false, pendingWarns: new Map(), isSubagent: true }
    const d = decideGate({ toolName: 'edit', args: { file_path: '/x/a.ts' } }, ctx, 'c1')
    assert.equal(d.kind, 'allow')
  })
  it('warn-only mode records pending warn instead of denying', () => {
    const { store } = tempStore()
    const pending = new Map()
    const ctx = { store, sessionKey: 's1', exemptMatchers: [], detectorConfig: EMPTY_CONFIG, fullDenials: 3, warnOnly: true, pendingWarns: pending, isSubagent: false }
    const d = decideGate({ toolName: 'edit', args: { file_path: '/x/a.ts' } }, ctx, 'call-1')
    assert.equal(d.kind, 'allow')
    assert.ok(pending.has('call-1'))
  })
})

// ── 5. run_code advisory ──
describe('run-code-advisory: danger API scan', () => {
  it('flags fs.unlink / child_process / process.kill', () => {
    assert.deepEqual(scanDangerApis('fs.unlinkSync("/tmp/x")'), ['file deletion'])
    assert.deepEqual(scanDangerApis('child_process.execSync("rm -rf /")'), ['child process spawn/exec'])
    assert.deepEqual(scanDangerApis('process.kill(123)'), ['process kill'])
  })
  it('passes safe code silently', () => {
    assert.deepEqual(scanDangerApis('console.log("hello")'), [])
  })
  it('builds advisory message', () => {
    assert.match(dangerAdvisoryMessage(['file deletion']), /run_code advisory/)
  })
})

// ── 6. Messages verbatim ──
describe('messages: templates match CC originals', () => {
  it('edit/write/destructive/routine/condensed present required facts', () => {
    assert.match(editGateMsg('/x/a.ts'), /List ALL files that import\/require/)
    assert.match(writeGateMsg('/x/n.ts'), /Name the file\(s\) and line\(s\)/)
    assert.match(destructiveBashMsg(), /one-line rollback procedure/)
    assert.match(routineBashMsg(), /current user request in one sentence/)
    assert.match(condensedGateMsg('edit', '/x/a.ts', 4), /denial #4 this session/)
  })
})

// ── 7. Phase-2: scope warning ──
describe('phase-2: scope warning', () => {
  it('fires once after threshold edits, per session', () => {
    const t = new ScopeWarningTracker(() => ({ enabled: true, threshold: 3 }))
    assert.equal(t.record('s1', 'read', false), null)
    assert.equal(t.record('s1', 'edit', false), null)
    assert.equal(t.record('s1', 'write', false), null)
    const warn = t.record('s1', 'edit', false)
    assert.match(warn, /SCOPE WARNING/)
    assert.equal(t.record('s1', 'edit', false), null) // fired once, reset
    // other session independent
    assert.equal(t.record('s2', 'edit', false), null)
  })
  it('ignores errored calls and non-edit tools', () => {
    const t = new ScopeWarningTracker(() => ({ enabled: true, threshold: 1 }))
    assert.equal(t.record('s1', 'edit', true), null) // isError
    assert.equal(t.record('s1', 'pwsh', false), null) // not edit tool
  })
})

// ── 8. Phase-2: duplicate read ──
describe('phase-2: duplicate read', () => {
  it('hints on unchanged re-read when enabled', async () => {
    const { writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const f = join(tmpdir(), `fg-dup-${Date.now()}.txt`)
    writeFileSync(f, 'same content')
    const t = new DuplicateReadTracker(() => ({ enabled: true }))
    assert.equal(t.recordRead('s1', f).duplicate, false) // first read
    assert.equal(t.recordRead('s1', f).duplicate, true)  // unchanged re-read
    writeFileSync(f, 'changed!')
    assert.equal(t.recordRead('s1', f).duplicate, false) // changed
    assert.match(DuplicateReadTracker.hintMessage(f), /File unchanged since your last Read/)
  })
  it('stays silent when disabled', async () => {
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const f = join(tmpdir(), `fg-dup-${Date.now()}.txt`)
    const t = new DuplicateReadTracker(() => ({ enabled: false }))
    assert.equal(t.recordRead('s1', f).duplicate, false)
    assert.equal(t.recordRead('s1', f).duplicate, false)
  })
})

// ── 9. Phase-2: push review ──
describe('phase-2: push review', () => {
  it('detects git push commands', async () => {
    assert.equal(isGitPushCommand('git push origin main'), true)
    assert.equal(isGitPushCommand('git -C /x push -u origin dev'), true)
    assert.equal(isGitPushCommand('git status'), false)
    assert.equal(isGitPushCommand('ls'), false)
  })
  it('detects git push inside run_code program text (lax carrier match)', async () => {    // Real-machine shape: CodeDispatchLog.exec is the outer run_code execution;
    // the command is a tools.pwsh({ command: ... }) call inside the code program.
    const codeTpl = 'const safe = "-c safe.directory=D:/x";\nconst push = await tools.pwsh({ command: `git ${safe} push`, description: "Push to origin" });'
    assert.equal(isGitPushCommandLax(codeTpl), true)
    assert.equal(isGitPushCommandLax('const r = await tools.pwsh({ command: `git ${safe} branch --show-current`, description: "Branch" });'), false)
    assert.equal(isGitPushCommandLax('const r = await tools.pwsh({ command: "git status --short", description: "Status" });'), false)
    // false positives are allowed at this stage (filtered by the `->` marker downstream)
    assert.equal(isGitPushCommandLax('const r = await tools.pwsh({ command: `git log --grep=push`, description: "Log" });'), true)
  })
  it('formats review findings', async () => {
    const msg = formatReviewMessage({ vulns_found: 1, affected_files: ['a.py'], findings: [{ severity: 'HIGH', issue: 'IDOR', suggested_fix: 'add ownership check' }] })
    assert.match(msg, /\[HIGH\] IDOR/)
    assert.match(msg, /add ownership check/)
    const clean = formatReviewMessage({ vulns_found: 0, affected_files: [], findings: [] })
    assert.match(clean, /No vulnerabilities/)
  })
  it('uses only provider-supported JSON-schema keywords', async () => {
    // The subagent provider rejects unsupported keywords (minimum) with
    // JsonSchemaError, silently killing the review (real-machine debug log).
    const { PUSH_REVIEW_SCHEMA } = await import('../lib/push-review.js')
    const text = JSON.stringify(PUSH_REVIEW_SCHEMA)
    assert.ok(!text.includes('minimum'), 'schema must not use minimum')
  })
})

// ── 10. Phase-3: cost warning ──
describe('phase-3: cost warning', () => {
  it('fires once above token threshold, per session', async () => {
    const { CostWarningTracker } = await import('../lib/cost-warning.js')
    const t = new CostWarningTracker(() => ({ enabled: true, threshold: 100 }))
    assert.equal(t.record('s1', { inputTokens: 40, outputTokens: 20 }), null)  // 60
    assert.equal(t.record('s1', { inputTokens: 10, outputTokens: 10 }), null)  // 80
    const warn = t.record('s1', { inputTokens: 10, outputTokens: 10 })         // 100 → fire
    assert.match(warn, /COST WARNING/)
    assert.equal(t.record('s1', { inputTokens: 10, outputTokens: 10 }), null)  // 20, below again
    assert.match(t.record('s1', { inputTokens: 90, outputTokens: 10 }), /COST WARNING/) // 120 → re-fire
    assert.equal(t.record('s2', { inputTokens: 10 }), null) // other session independent
  })
  it('ignores zero usage and disabled config', async () => {
    const { CostWarningTracker } = await import('../lib/cost-warning.js')
    const t = new CostWarningTracker(() => ({ enabled: false, threshold: 1 }))
    assert.equal(t.record('s1', { inputTokens: 10 }), null)
    const t2 = new CostWarningTracker(() => ({ enabled: true, threshold: 1 }))
    assert.equal(t2.record('s1', {}), null) // zero usage
  })
})

// ── 11. Phase-3: project config ──
describe('phase-3: project config', () => {
  it('merges known keys over settings, ignores unknown', async () => {
    const { mergeProjectConfig } = await import('../lib/project-config.js')
    const base = { enabled: true, deny: true, threshold: 10, unknownBase: 1 }
    const merged = mergeProjectConfig(base, { deny: false, bogusKey: 42 })
    assert.equal(merged.deny, false)
    assert.equal(merged.enabled, true)
    assert.equal(merged.bogusKey, undefined)
    assert.equal(mergeProjectConfig(base, null), base)
  })
  it('loads .fact-gate.yml from a project dir', async () => {
    const { loadProjectConfig } = await import('../lib/project-config.js')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'fg-proj-'))
    writeFileSync(join(dir, '.fact-gate.yml'), 'fact-gate:\n  deny: false\n')
    const cfg = loadProjectConfig(dir)
    // loadProjectConfig returns the whole file; the plugin reads the top-level object
    assert.ok(cfg !== null)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── 12. Phase-3: compaction notice scanning ──
describe('phase-3: compaction notice', () => {
  it('scans session events for new compaction/start records', async () => {
    const { scanCompactionStarts } = await import('../lib/compaction.js')
    const events = [
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'compaction/start' },
      { seq: 4, type: 'user/message' },
      { seq: 5, type: 'compaction/start' },
    ]
    assert.deepEqual(scanCompactionStarts(events, 0), [3, 5])
    assert.deepEqual(scanCompactionStarts(events, 3), [5])
    assert.deepEqual(scanCompactionStarts(events, 5), [])
    assert.deepEqual(scanCompactionStarts([], 0), [])
  })
})
