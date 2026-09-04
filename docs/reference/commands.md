---
title: Command reference
description: Slash commands and model-facing tools provided by local-context-manager.
---

# Command reference

[Documentation portal]({{ '/' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) · [Configuration]({{ '/reference/configuration.html' | relative_url }})

Type these commands into Pi's editor. The extension registers them when the package is loaded. If a workflow is disabled in configuration, its command explains that it is disabled instead of changing the session.

## Slash commands

| Command | Use it for | Does it change the session? |
| --- | --- | --- |
| `/context-stats` | View context reading/estimate, threshold details, reductions, and compaction history | No. It only reports telemetry. |
| `/compact-phase [reason]` | Compact after a meaningful phase, such as `tests pass` or `implementation complete` | It may add Pi's normal compaction entry after Pi is idle. |
| `/handoff <objective>` | Begin a fresh session focused on a new objective | Only after you review the generated prompt and the new-session transition succeeds. |
| `/checkpoint-reset [reason]` | Archive a completed semantic episode and continue with a small capsule | Only after you review both artifacts and explicitly approve. |
| `/context-checkpoints` | List recent checkpoint archives for the current repository | No. It only reads local checkpoint metadata. |

Pi's built-in `/compact` remains available for ordinary or custom-instruction compaction. The extension does not replace it.

## Examples

Inspect the session:

```text
/context-stats
```

Mark the end of a phase:

```text
/compact-phase implementation complete; tests pass
```

Start a new focus without carrying every detail forward:

```text
/handoff investigate the remaining release issue
```

Archive a completed episode before continuing the project:

```text
/checkpoint-reset v0.3.0 release completed
```

Find local archives:

```text
/context-checkpoints
```

Reasons are short labels for the generated summary and filename. Do not put secrets in a reason; checkpoint content can already contain sensitive project details.

## Model-facing tools

These are available to the model during an agent run. You usually do not type them yourself.

### `request_context_compaction`

The model can call this after a meaningful task phase. It accepts an optional short `reason`:

```json
{
  "reason": "implementation and tests complete"
}
```

The tool queues a request for the end of the current agent run. It does not compact in the middle of a tool call. Pi may skip the request if the session is not idle, another compaction is running, or cooldown is active.

### `request_context_reset`

The model can call this after a major completed episode. It accepts an optional short `reason`:

```json
{
  "reason": "PR merged"
}
```

This tool records only a recommendation. It never writes a checkpoint, starts a new session, or bypasses the user's review. After the agent settles, the user can decide whether to run `/checkpoint-reset`.

## What counts as a boundary?

Good reasons to use a boundary command include:

- implementation and its tests are complete;
- an investigation or debugging episode is resolved;
- a PR has been merged;
- a release or deployment is complete;
- the next task is meaningfully different.

Avoid forcing a boundary during active debugging or after every small edit. If you still need the details in the next few turns, keep the current context or use ordinary `/compact` with a focused instruction.

## If a command is unavailable

1. Confirm the package is installed with `pi list`.
2. Start a new Pi session or run `/reload`.
3. Check `pi config` for a disabled extension.
4. Review [Configuration]({{ '/reference/configuration.html' | relative_url }}) for a disabled feature or untrusted project override.
