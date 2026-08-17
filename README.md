# dsh-fact-gate

Fact-Forcing Gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a native cordis plugin porting Claude Code's **GateGuard** PreToolUse hook (DENY→FORCE→ALLOW).

> "LLM 自我评估没用——问'你违反政策了吗'答案永远是'没有'。但问'列出所有 import 此模块的文件'会逼它跑 Grep 和 Read。**调查行为本身创造了自我评估永远无法创造的上下文。**"

## Gates

| Gate | Trigger | Facts demanded |
|---|---|---|
| Edit | first edit of each file (`edit`, `str_replace_editor` str_replace/insert) | importers, affected API, data schemas, verbatim instruction |
| Write | first creation of each file (`write`, `str_replace_editor` create) | callers, no-duplicate-purpose, data schemas, verbatim instruction |
| Destructive pwsh | every destructive command (`pwsh`/`bash`) | targets, one-line rollback, verbatim instruction |
| Routine pwsh | first shell command per session | user request in one sentence, what the command produces |
| run_code advisory | danger-API patterns in `run_code` code | context attach (no deny) |

Five-layer destructive detection (ported verbatim from GateGuard): SQL/dd phrases → operator regexes → find -exec → rm/git → quote-aware bypass closure (GHSA-4v57-ph3x-gf55).

## Install

```bash
dsh plugin --profile <name> add github:HiNEM66/dsh-fact-gate
```

(Or a git dependency + `dsh.profile.bundles` entry, like dsh-plugin-orchestra.)

## Config (`~/.dsh/settings.yaml`, live-reload)

```yaml
fact-gate:
  enabled: true        # total switch (env FACT_GATE=off also works)
  deny: true           # false = warn-only (attach context, never deny)
  profile: full        # 'none' = off
  fullDenials: 3       # full-block budget; then condensed single-line denials
  exemptGlobs: []      # exempt paths (** across segments)
  bashExtraDestructive: []  # extra destructive regex sources
  routineBashEnabled: true  # false = skip routine gate (destructive still fires)
  enabledHooks: [edit, write, destructive-bash, routine-bash]
  runCodeAdvisory: true
```

## Design notes

- Port source: `gateguard-fact-force.js` (1278 lines, CJS) + `shell-substitution.js` (510 lines) from [everything-claude-code](https://github.com/affaan-m/everything-claude-code); logic preserved, env reads replaced by injected config for testability.
- State: `~/.dsh/fact-gate/state-<sessionKey>.json` (500 checked entries / 50 session keys / 30 min timeout / atomic write).
- Sub-agent calls are exempt (parent session already passed first-touch) via `delegationDepthOf(exec.agent)`.
- dsh API used: `tools/pre-execute` (PreToolDecision deny), `tools/post-execute` (advisory attach), `ctx.settings.register(..., {applies:'live'})`.
