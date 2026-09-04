---
title: Configuration reference
description: Configure local-context-manager thresholds, optional workflows, and local checkpoint storage.
---

# Configuration reference

[Documentation portal]({{ '/' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) · [Command reference]({{ '/reference/commands.html' | relative_url }})

No configuration is required. Start with the defaults, then change one setting at a time if your sessions or hardware need a different balance.

## Where configuration lives

The global configuration file is:

```text
~/.pi/agent/local-context-manager.json
```

If Pi uses a different agent directory, the extension follows `PI_CODING_AGENT_DIR`:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent pi
```

A trusted project can override global values with:

```text
<project>/.pi/local-context-manager.json
```

Project configuration is read only when Pi considers the project trusted. This prevents a checked-out project from silently changing your global behavior. See Pi's [project trust documentation](https://github.com/earendil-works/pi#project-trust) if you are new to that prompt.

Later project values override global values. You may either put settings at the top level or use an optional `localContextManager` wrapper:

```json
{
  "localContextManager": {
    "toolOutputReduction": true,
    "softWarningTokens": 24000,
    "compactThresholdTokens": 32000
  }
}
```

After editing a file, start a new Pi session or run `/reload`.

## All settings

| Setting | Default | What it controls |
| --- | ---: | --- |
| `enabled` | `true` | Master switch for extension behavior. |
| `softWarningTokens` | `24000` | Shows one warning when the active context reaches this level after a compaction cycle. |
| `compactThresholdTokens` | `32000` | Threshold for a guarded proactive compaction request at an idle boundary. |
| `hardCeilingTokens` | `48000` | Adds a `hard ceiling` status label at or above this level; Pi still owns emergency compaction. |
| `keepRecentTokens` | `10000` | Preferred recent-context target used by the extension's compaction hook when Pi's native helpers allow it. |
| `toolOutputReduction` | `true` | Allows reduction of eligible newly arriving oversized tool results. |
| `semanticCompaction` | `true` | Enables `request_context_compaction` and `/compact-phase`. |
| `handoff` | `true` | Enables `/handoff <objective>`. |
| `checkpointReset` | `true` | Enables `request_context_reset`, `/checkpoint-reset`, and `/context-checkpoints`. |
| `checkpointDirectory` | `null` | Alternate local root for checkpoint archives. `null` uses Pi's agent directory. |
| `debug` | `false` | Writes diagnostic messages to stderr. |

The three compaction thresholds must be positive integers in this order:

```text
keepRecentTokens < softWarningTokens < compactThresholdTokens < hardCeilingTokens
```

For example, the default `keepRecentTokens` is lower than the warning threshold, and the warning threshold is lower than the proactive compaction threshold. If you provide an invalid number or ordering, the extension keeps the prior valid value and shows a configuration warning.

## A sensible custom configuration

Put this in `~/.pi/agent/local-context-manager.json` if your local model becomes uncomfortable with longer prompts:

```json
{
  "enabled": true,
  "softWarningTokens": 16000,
  "compactThresholdTokens": 24000,
  "hardCeilingTokens": 36000,
  "keepRecentTokens": 8000,
  "toolOutputReduction": true,
  "semanticCompaction": true,
  "handoff": true,
  "checkpointReset": true,
  "checkpointDirectory": null,
  "debug": false
}
```

If you only need to turn off one behavior, use a small project override instead:

```json
{
  "localContextManager": {
    "toolOutputReduction": false
  }
}
```

Turning off reduction leaves original tool results intact; it does not turn off Pi's native compaction. Turning off `semanticCompaction`, `handoff`, or `checkpointReset` disables only that extension workflow and reports the disabled state when its command is used.

## Choosing thresholds

The values are token counts, not percentages of every model's window. A threshold that feels comfortable depends on your model's context window, response quality, and local hardware.

- Set `softWarningTokens` where you want a reminder to inspect the session.
- Set `compactThresholdTokens` high enough to avoid unnecessary summaries, but low enough to leave room for the next turn.
- Keep `hardCeilingTokens` as a status boundary rather than treating it as a setting that forces a reset.
- Keep `keepRecentTokens` below the other thresholds. More recent tokens preserve continuity but leave less history to summarize.

Start with defaults and use `/context-stats` before tuning. The extension uses a provider-reported value when available and a conservative active-context estimate otherwise.

## Checkpoint storage

With `checkpointDirectory: null`, archives are stored under:

```text
<agent-dir>/local-context-manager/checkpoints/<repository-hash>/<timestamp>-<reason>.md
```

The default agent directory is `~/.pi/agent`. A configured path can be absolute or relative; relative paths resolve from the current project. The extension still separates repositories with a non-reversible repository hash.

Checkpoint files are local agent state. They may contain project paths, decisions, test results, and model-generated text. The extension creates them atomically with restrictive permissions, but your filesystem and backup tools still determine who can read them. Do not commit them by accident.

## Failure behavior

Configuration is designed to fail soft:

- missing files use defaults;
- malformed JSON is ignored with a warning;
- invalid individual values fall back to the previous valid layer;
- an untrusted project file is not applied;
- a reduction, compaction, handoff, or checkpoint failure preserves the active session whenever possible.

Set `debug` to `true` temporarily when you need diagnostic messages. Turn it back off if you do not want routine details in stderr.
