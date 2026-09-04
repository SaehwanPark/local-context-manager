---
title: Installation & first launch
description: Install Pi and local-context-manager as a beginner, then verify the extension in one session.
---

# Installation & first launch

[Documentation portal]({{ '/' | relative_url }}) · [Why context matters]({{ '/guides/understanding-context.html' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }})

This guide assumes you have never installed a Pi package before. You need a terminal, Node.js/npm, and a working Pi installation. You do **not** need to install a model or create a database for this extension.

## 1. Install Pi

Follow the [official Pi quickstart](https://github.com/earendil-works/pi#quick-start). The npm route is:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify that the command is available:

```bash
pi --version
```

Start Pi once and authenticate with `/login`, or configure the provider you already use. The extension uses Pi's selected model for model-generated compaction, handoff, and checkpoint text; it does not choose a provider for you.

> **Local-model note:** “Local-LLM workflow” describes the main use case, not a requirement. This extension can run in any Pi session. If data must stay local, select and configure a local provider before using model-generated features.

## 2. Install the extension from npm

Run this in a terminal, from any directory:

```bash
pi install npm:local-context-manager
```

Pi installs the package and its runtime dependency, then records it in your user package settings. The package declares its Pi compatibility as `>=0.84.4 <1`.

To pin exactly this release instead of following the latest version:

```bash
pi install npm:local-context-manager@0.3.0
```

> **Security note:** Pi packages run with the permissions of Pi and can execute code. Read the [source](https://github.com/SaehwanPark/local-context-manager) before installing, just as you would for any third-party Pi extension.

## 3. Start or reload Pi

For a new session, open a project directory and run:

```bash
cd /path/to/your/project
pi
```

For an already-running Pi session, type this slash command in Pi:

```text
/reload
```

The package is now available to the session. Type `/` and look for the extension commands, or continue to the verification step.

## 4. Verify the extension

Inside Pi, run:

```text
/context-stats
```

A notification should show context telemetry and the configured thresholds. You can also check the installed package from your terminal:

```bash
pi list
```

The extension needs no configuration to begin. Its defaults are enabled and conservative:

- it only reduces newly arriving oversized tool results;
- it waits for safe idle boundaries before proactive compaction;
- it never resets a session without your review and approval.

## Updating or removing it

Update the unpinned package from a terminal:

```bash
pi update npm:local-context-manager
```

If you installed a pinned version, move it explicitly to a newer version:

```bash
pi install npm:local-context-manager@0.3.0
```

Remove it with:

```bash
pi remove npm:local-context-manager
```

Restart Pi (or use `/reload`) after changing installed packages.

## Troubleshooting

### `pi: command not found`

Close and reopen the terminal after installing Pi. If the command is still missing, check the [official Pi installation instructions](https://github.com/earendil-works/pi#quick-start) and your npm global-bin path.

### `pi install` says the package cannot be found

Check the spelling and registry connectivity:

```bash
npm view local-context-manager version
```

If you are offline, npm cannot download a new package. You can test a local checkout instead:

```bash
pi install /absolute/path/to/local-context-manager
```

### The commands do not appear

1. Confirm `pi list` shows `local-context-manager`.
2. Start a new Pi session or run `/reload`.
3. Use `pi config` to check whether the extension was disabled.
4. If the project has local Pi settings, remember that Pi may ask you to trust the project before loading project-local resources.

### `/context-stats` says the reading is unknown

Pi may not have provider usage yet, or it may be immediately after compaction. The extension uses a conservative estimate from the active session when possible. Continue for a turn and check again; an unknown reading does not disable Pi's normal compaction behavior.

### I want to try it without installing permanently

From a terminal, start a temporary session with:

```bash
pi --extension npm:local-context-manager
```

This lets you review the package in a session without adding it to your regular package settings.

## Next steps

- [Why context matters]({{ '/guides/understanding-context.html' | relative_url }}) explains the problem in plain language.
- [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) gives a routine workflow and recovery steps.
- [Configuration reference]({{ '/reference/configuration.html' | relative_url }}) lists every optional setting.
