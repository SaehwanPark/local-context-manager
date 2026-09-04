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
| `checkpointReset` | `true` | Enable reviewed `/checkpoint-reset` and checkpoint listing |
| `checkpointDirectory` | `null` | Optional local archive root; `null` uses Pi's agent directory |
| `debug` | `false` | Emit diagnostic messages to stderr |

Token settings must be positive integers in the order `keepRecentTokens < softWarningTokens < compactThresholdTokens < hardCeilingTokens`. Invalid values fall back to the prior valid layer/default.

## What it does

- **Telemetry:** shows context tokens, threshold percentage, post-compaction growth, active reduced tool-output tokens, compaction count/time, and reduction count in the `local-context-manager` status item. `/context-stats` displays the same information.
- **Proactive compaction:** requests Pi's native `ctx.compact()` only at idle `turn_end`/`agent_settled` boundaries. A gate prevents concurrent requests, repeated attempts, and rapid compaction loops. It rearms only below the warning threshold and enforces a two-turn gap.
- **Compaction hook:** when possible, the installed Pi compaction helpers are used with the configured recent-token target. If authentication or a helper is unavailable, Pi's normal compaction proceeds unchanged.
- **Tool-output reduction:** only the newly arriving result is rewritten. Source-file reads and small results are preserved. Large build, failure, search, diff, and generic command output keeps diagnostics, paths, headers, and prioritized excerpts. A recovery copy is written outside the session context and its path is added to the replacement result when no full-output path was already supplied.
- **Semantic compaction:** the model can call `request_context_compaction` with an optional phase reason. The request is queued and runs after the current agent run, not during a tool call. `/compact-phase [reason]` is the explicit command equivalent.
- **Handoff:** `/handoff <objective>` drafts a continuation prompt (model-generated when authenticated, otherwise conservative fallback), lets the user edit it, then opens a fresh session only after the user finishes reviewing it. It never switches sessions automatically.
- **Checkpoint reset:** `/checkpoint-reset [reason]` archives a completed semantic episode as cold local memory, drafts a much smaller continuation capsule, asks for explicit approval, and then starts a parent-linked fresh session. `/context-checkpoints` lists archives for the current repository. The model-facing `request_context_reset` tool only recommends this reviewed command; it never resets a session itself.

All optional behavior is fail-safe: a reduction failure leaves the original result alone, compaction failure is reported without retry storms, handoff generation falls back rather than fabricating project facts, and an untrusted checkpoint or failed write prevents a reset.

## Checkpoint reset

Ordinary compaction keeps recent context for conversational continuity. A checkpoint reset is more aggressive and is intended for a completed semantic episode, such as a merged PR, resolved issue, completed release or deployment, finished investigation, or accepted independent milestone.

The flow is:

1. wait for Pi to become idle and read the active compaction-aware context;
2. generate two different artifacts: a durable semantic checkpoint and a minimal continuation capsule;
3. let the user edit both artifacts and explicitly approve the reset;
4. write the checkpoint atomically with restrictive local permissions;
5. create a fresh parent-linked Pi session and place only the capsule in its editor.

The original Pi session remains the complete forensic transcript. The new session does not automatically load the checkpoint; its capsule contains a pointer so the model can read the archive later only when historical details matter.

By default, files are stored outside the repository at:

```text
~/.pi/agent/local-context-manager/checkpoints/<repository-hash>/<timestamp>-<reason>.md
```

`PI_CODING_AGENT_DIR` changes the `~/.pi/agent` root. `checkpointDirectory` can supply another local root (relative values resolve from the current working directory); it is still separated by a non-reversible repository hash. Checkpoint files are local agent state, may contain private paths or implementation notes, and should not be committed or uploaded. The extension does not dump environment variables or add a secret-scanning service.

The archive uses readable Markdown with metadata followed by `Goals`, `Standing Constraints`, `Decisions and Rationale`, `Work Completed`, `Relevant Files`, `Verification`, `Problems Encountered`, `Rejected Approaches`, `Unresolved Issues`, `Follow-ups`, and `Historical Notes`. The capsule contains only `Active Goals`, `Standing Constraints`, `Current Repository State`, `Durable Decisions`, `Outstanding Work`, and `Archived Context`.

### Compaction, checkpoint reset, and handoff

| Operation | Purpose | Entry point |
| --- | --- | --- |
| Compaction | Shrink a growing context while retaining continuity | Pi `/compact`, proactive policy, `/compact-phase` |
| Checkpoint reset | Archive a completed episode and continue the same overarching work from a nearly clean epoch | `/checkpoint-reset [reason]`, or the reviewed recommendation from `request_context_reset` |
| Handoff | Start a focused new session for a substantially different objective or phase | `/handoff <objective>` |

For example, after `PR #123 merged`, use `/checkpoint-reset PR #123 merged` when the project continues, not `/handoff` unless the next objective is intentionally a new focus. Cancelling during generation, editing, or approval writes nothing and leaves the current session active. If a new-session transition fails after the checkpoint is saved, the archive path is reported and remains recoverable.

A rough illustration (exact sizes vary):

```text
Before:  system/tools ~4k + summaries ~4k + implementation history ~14k + review/CI ~8k = ~30k active

/checkpoint-reset PR #123 merged

Disk:    checkpoint.md ~2–5k semantic archive + original Pi session with complete history
New:     system/tools ~4k + capsule/goals/constraints ~1k = ~5k active
```

### Non-goals

This feature deliberately does not implement embeddings, vector search, RAG, persistent knowledge graphs, external databases, checkpoint daemons, GitHub watchers or webhooks, automatic PR detection, per-turn relevance scoring, automatic checkpoint loading, or cross-project memory inference.

## Cache and history behavior

The extension does not rewrite old session messages on every turn. It uses Pi's native compaction/session APIs and intercepts only the current `tool_result`. This keeps provider cache prefixes stable as far as the host API allows and avoids accumulating summaries or duplicated notices in session history. Checkpoint generation is an explicit two-call boundary operation with cache retention disabled; historical archives are never injected into later prompts automatically.

## License

MIT
