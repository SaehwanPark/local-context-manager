---
title: How to use it
description: A practical beginner workflow for context telemetry, compaction, handoff, and checkpoint reset in Pi.
---

# How to use it

[Documentation portal]({{ '/' | relative_url }}) · [Install & launch]({{ '/guides/installation.html' | relative_url }}) · [Command reference]({{ '/reference/commands.html' | relative_url }})

Once installed, use Pi as you normally do. The extension works in the background with safe defaults; these commands are for moments when you want to inspect or choose a context boundary.

## A simple everyday workflow

### 1. Check the reading when a session feels heavy

Run:

```text
/context-stats
```

Look for the current reading, threshold progress, active reduced tool-output tokens, and compaction count. The value can be an estimate or temporarily unknown. It is a signal for deciding what to do, not a promise of exact provider accounting.

### 2. Choose a mode only if you notice a symptom

The default `balanced` mode needs no setup. If a long session becomes noticeably slower, choose the more conservative bundle:

```text
/context-mode aggressive
```

If compaction feels too frequent while long prompts remain comfortable, choose:

```text
/context-mode relaxed
```

Use `/context-mode balanced` to return to the default. The command applies only to the current session; set `contextProfile` in the configuration file when you want the choice to persist. Pi's reported model context window can lower thresholds automatically for small-window models, so you do not need to calculate fractions yourself.

### 3. Keep working until a meaningful phase ends

Do not compact after every small edit. A phase might be “implementation complete,” “tests now pass,” or “investigation narrowed to one fix.” At that boundary, either let the extension's proactive policy help or request a focused compaction:

```text
/compact-phase implementation and tests complete
```

This waits for Pi to be idle, then asks Pi to compact with the phase reason. If a compaction is already running, cooldown is active, or there is not enough history, the command reports that nothing started. Your session is not deleted.

Pi's normal command remains available:

```text
/compact
```

Use it when you want Pi's ordinary compaction behavior or a custom instruction.

### 4. Choose a fresh-session workflow only at a real boundary

Use `/handoff` when the next task is a substantially different focus:

```text
/handoff investigate the release workflow failure
```

Use `/checkpoint-reset` when a major episode is complete and you want to keep a durable local archive while continuing the larger project:

```text
/checkpoint-reset PR #123 merged
```

These commands are intentionally interactive. Read the generated text, edit it if needed, and cancel if the boundary is not right.

## Handoff: a focused fresh session

`/handoff <objective>`:

1. waits for the current agent work to settle;
2. drafts a continuation prompt from the active context (or uses a conservative fallback if a model is unavailable);
3. opens an editor so you can review and change the prompt;
4. starts a fresh session only after you finish reviewing it.

It does not switch sessions automatically in the background. If you cancel the editor or the new-session transition, the current session remains active.

Use handoff for a new focus, not merely because the context is large. For a completed phase in the same objective, `/compact-phase` is usually smaller and simpler.

## Checkpoint reset: archive, review, continue

A checkpoint reset is more deliberate than ordinary compaction. Good boundaries include a merged PR, resolved issue, completed release, finished investigation, or accepted milestone.

`/checkpoint-reset [reason]` performs this sequence:

1. waits for Pi to be idle;
2. reads the active compaction-aware context;
3. generates a durable semantic checkpoint and a minimal continuation capsule;
4. lets you edit both artifacts;
5. asks for explicit approval;
6. writes the checkpoint atomically with restrictive local permissions;
7. starts a parent-linked fresh session and places only the capsule in its editor.

The original session remains the full forensic transcript. The new session does not load the checkpoint automatically; the capsule contains its path for optional later inspection.

Check recent archives with:

```text
/context-checkpoints
```

The default storage location is outside the repository:

```text
~/.pi/agent/local-context-manager/checkpoints/<repository-hash>/<timestamp>-<reason>.md
```

`PI_CODING_AGENT_DIR` changes the `~/.pi/agent` root. `checkpointDirectory` can choose another local root; see [Configuration]({{ '/reference/configuration.html' | relative_url }}).

> **Important:** checkpoint text may include private paths, implementation notes, and provider-generated summaries. Review it before approval, keep it out of Git unless you intentionally want it there, and do not assume it is automatically available in a later session.

## What happens automatically

- **Tool-output reduction:** eligible oversized new results can be shortened. Source reads and small results are preserved. The replacement includes a recovery path when one is available; open that file when you need the full output.
- **Proactive compaction:** once the threshold is reached, a request may run at a safe idle boundary. Hysteresis, cooldown, and an in-flight gate prevent repeated compaction attempts.
- **Adaptive thresholds:** the active profile is automatically lowered for constrained reported context windows, but never raised for a large advertised window.
- **Telemetry:** status and `/context-stats` update as usage, compactions, and reductions change.

If an optional operation fails, the extension prefers the original context and reports the failure rather than silently dropping work.

## Model-facing requests

The model can call these tools when their descriptions and guidelines indicate a real boundary:

| Tool | Meaning |
| --- | --- |
| `request_context_compaction` | Queue semantic compaction for the end of the current agent run. It may be skipped if Pi is not idle or cooldown is active. |
| `request_context_reset` | Queue a recommendation for you to review. It never writes a checkpoint or changes sessions by itself. |

You normally do not type these tool names. If the model suggests a checkpoint reset during active coding, wait until the episode is actually complete and decide yourself whether to run the reviewed command.

## Cancellation and recovery

| Situation | Result | What you can do |
| --- | --- | --- |
| You cancel generation, editing, or approval | No checkpoint is written; the active session stays open | Continue working or retry at a better boundary. |
| A tool result cannot be safely shortened | The original result is preserved | Continue; the context may be larger than usual. |
| Compaction fails or is unavailable | Pi's normal path remains authoritative; the extension reports the failure | Try `/compact` later or keep working. |
| A handoff new-session transition fails | The current session stays active | Retry `/handoff` later. |
| A checkpoint saves but the new session cannot start | The archive remains recoverable and its path is reported | Start a fresh Pi session manually and inspect the archive if needed. |
| A status reading is unknown | No destructive action is taken | Check again after another provider response or compaction. |

## Suggested first week

- Day 1: install the package and run `/context-stats` once.
- During normal work: let automatic protection run; do not force a boundary for every turn.
- After a meaningful phase: try `/compact-phase <short reason>` and inspect the next response.
- After a merged milestone: try `/checkpoint-reset <reason>` once, review both artifacts, and keep the archive private.
- When a task changes direction: use `/handoff <new objective>` instead of copying a long transcript by hand.
