---
title: Configuration reference
description: Configure local-context-manager thresholds, optional workflows, and local checkpoint storage.
---

# Configuration reference

[Documentation portal]({{ '/' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) · [Command reference]({{ '/reference/commands.html' | relative_url }})

No configuration is required. The invisible default is the `balanced` context mode. If a long local-model session becomes slow, try `/context-mode aggressive`; if compaction feels unnecessarily frequent, try `/context-mode relaxed`. Change numeric settings only for benchmarking or a specialized setup.

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
    "contextProfile": "balanced",
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
| `contextProfile` | `balanced` | Semantic threshold bundle: `aggressive`, `balanced`, or `relaxed`. Numeric settings below can override individual values. |
| `softWarningTokens` | `24000` | Advanced override for the warning boundary after a compaction cycle. |
| `compactThresholdTokens` | `32000` | Advanced override for a guarded proactive compaction request at an idle boundary. |
| `hardCeilingTokens` | `48000` | Advanced override for the status boundary; Pi still owns emergency compaction. |
| `keepRecentTokens` | `10000` | Advanced override for the recent-context target used by the extension's compaction hook when Pi's native helpers allow it. |
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

## Profiles and automatic adaptation

Profiles keep the four thresholds coherent:

| Profile | Use it when | Nominal thresholds (keep / warn / compact / ceiling) |
| --- | --- | ---: |
| `aggressive` | Long sessions become noticeably slower | `8k / 16k / 24k / 36k` |
| `balanced` | Normal starting point; this is the default | `10k / 24k / 32k / 48k` |
| `relaxed` | Compaction happens too often and long prompts remain comfortable | `12k / 36k / 48k / 72k` |

The extension also reads the model's reported context-window size. For a constrained window, it lowers thresholds to conservative fractions of that window (approximately 12.5% / 25% / 50% / 75%). It never scales them up because a model advertises a large window. If the window is unavailable, the configured profile and numeric values are used as-is. Numeric overrides remain advanced values, but they are also lowered when necessary to fit a constrained window.

Use the guided command for the current session:

```text
/context-mode aggressive
```

This does not write a configuration file. To persist the choice, add the setting explicitly:

```json
{
  "contextProfile": "aggressive"
}
```

## A sensible custom configuration

Most users need only a profile:

```json
{
  "contextProfile": "aggressive"
}
```

For a specialized setup, numeric settings can override a profile bundle:

```json
{
  "contextProfile": "balanced",
  "softWarningTokens": 18000,
  "compactThresholdTokens": 26000,
  "hardCeilingTokens": 40000,
  "keepRecentTokens": 8000
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

## Choosing a mode

Start with `balanced` and let the extension work in the background. Choose by symptom rather than by hardware model:

- **Sessions become slow as they grow:** use `aggressive`.
- **Everything feels comfortable:** keep `balanced`.
- **Compaction happens too often even though long prompts remain fast:** use `relaxed`.

Run `/context-stats` to see the active mode and effective thresholds. The values are token counts, not percentages of every model's window. Hardware, runtime, model, quantization, and caching all affect performance, so this release does not assign thresholds from a machine lookup table.

Use the four numeric fields only when measuring a specialized setup. Keep `keepRecentTokens` below the other thresholds, and treat `hardCeilingTokens` as a status boundary rather than a setting that forces a reset. The extension does not yet learn a performance knee or retune itself from latency measurements.

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
