# local-context-manager

A small Pi extension for long-running local-LLM workflows. It keeps context management conservative: Pi remains responsible for emergency compaction, while this extension adds telemetry, a hysteretic proactive policy, reduction of only new oversized tool results, optional phase compaction, and an explicitly reviewed session handoff.

## Install

From a checkout, install the dependencies and load the package with Pi:

```sh
npm install
pi install .
```

The package entry point is `src/index.ts`, so Pi can load the source extension directly. For local development:

```sh
npm run typecheck
npm test
npm run build
```

## Configuration

Configuration is JSON, with later project values overriding global values. The global file is:

```text
~/.pi/agent/local-context-manager.json
```

A trusted project may add:

```text
<project>/.pi/local-context-manager.json
```

`PI_CODING_AGENT_DIR` is honored for installations that relocate Pi's agent directory. The project file is ignored for untrusted projects. An optional `localContextManager` wrapper object is accepted; malformed files or individual values are ignored with a warning rather than disabling Pi.

See [`examples/local-context-manager.json`](examples/local-context-manager.json). Defaults:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Master switch |
| `softWarningTokens` | `24000` | One warning per post-compaction cycle |
| `compactThresholdTokens` | `32000` | Proactive native-compaction threshold |
| `hardCeilingTokens` | `48000` | Status indicator for an emergency-range context; Pi remains authoritative for emergency compaction |
| `keepRecentTokens` | `10000` | Preferred recent context for the compaction hook |
| `toolOutputReduction` | `true` | Reduce eligible new tool results |
| `semanticCompaction` | `true` | Enable phase requests and `/compact-phase` |
| `handoff` | `true` | Enable `/handoff` |
| `debug` | `false` | Emit diagnostic messages to stderr |

Token settings must be positive integers in the order `keepRecentTokens < softWarningTokens < compactThresholdTokens < hardCeilingTokens`. Invalid values fall back to the prior valid layer/default.

## What it does

- **Telemetry:** shows context tokens, threshold percentage, post-compaction growth, active reduced tool-output tokens, compaction count/time, and reduction count in the `local-context-manager` status item. `/context-stats` displays the same information.
- **Proactive compaction:** requests Pi's native `ctx.compact()` only at idle `turn_end`/`agent_settled` boundaries. A gate prevents concurrent requests, repeated attempts, and rapid compaction loops. It rearms only below the warning threshold and enforces a two-turn gap.
- **Compaction hook:** when possible, the installed Pi compaction helpers are used with the configured recent-token target. If authentication or a helper is unavailable, Pi's normal compaction proceeds unchanged.
- **Tool-output reduction:** only the newly arriving result is rewritten. Source-file reads and small results are preserved. Large build, failure, search, diff, and generic command output keeps diagnostics, paths, headers, and prioritized excerpts. A recovery copy is written outside the session context and its path is added to the replacement result when no full-output path was already supplied.
- **Semantic compaction:** the model can call `request_context_compaction` with an optional phase reason. The request is queued and runs after the current agent run, not during a tool call. `/compact-phase [reason]` is the explicit command equivalent.
- **Handoff:** `/handoff <objective>` drafts a continuation prompt (model-generated when authenticated, otherwise conservative fallback), lets the user edit it, then opens a fresh session only after the user finishes reviewing it. It never switches sessions automatically.

All optional behavior is fail-safe: a reduction failure leaves the original result alone, compaction failure is reported without retry storms, and handoff generation falls back rather than fabricating project facts.

## Cache and history behavior

The extension does not rewrite old session messages on every turn. It uses Pi's native compaction/session APIs and intercepts only the current `tool_result`. This keeps provider cache prefixes stable as far as the host API allows and avoids accumulating summaries or duplicated notices in session history.

## License

MIT
