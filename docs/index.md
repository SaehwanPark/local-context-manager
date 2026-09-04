---
title: Documentation portal
description: Beginner-friendly documentation for local-context-manager, a Pi extension that keeps long sessions usable.
---

<div class="hero">
<p class="eyebrow">Pi extension · release {{ site.version }}</p>
<h1>Keep long Pi sessions usable.</h1>
<p class="lede">Local Context Manager helps you notice context growth, keep oversized tool output from taking over the conversation, and cross a meaningful work boundary without silently losing the work you just finished.</p>
<div class="hero-actions">
<a class="button" href="{{ '/guides/installation.html' | relative_url }}">Install in 60 seconds</a>
<a class="button secondary" href="{{ '/guides/understanding-context.html' | relative_url }}">Understand the problem</a>
</div>
</div>

> **New to Pi?** You do not need to understand tokens, compaction internals, or TypeScript to use this extension. Start with [Installation & first launch]({{ '/guides/installation.html' | relative_url }}), then use `/context-stats` when you want to see what is happening.

## The short version

Pi keeps your conversation in a context window: the text the model can see for the next reply. In a long coding session, that text grows with prompts, assistant plans, and tool results. Large local-model prompts can take longer to prefill; once the window gets crowded, important details compete with logs and old exploration.

Pi already has native compaction. This extension adds a conservative layer around it:

<div class="card-grid">
<div class="card">
<h3>👀 See the pressure</h3>
<p><code>/context-stats</code> and the footer status show context estimates, threshold progress, compactions, and reduced tool output.</p>
</div>
<div class="card">
<h3>🧹 Keep useful signal</h3>
<p>Only newly arriving oversized tool results are reduced. Small results and source-file reads are left alone, and a recovery path is kept when output is shortened.</p>
</div>
<div class="card">
<h3>🧭 Cross boundaries safely</h3>
<p>Use intentional phase compaction, a reviewed handoff, or a reviewed checkpoint reset instead of starting over blindly.</p>
</div>
</div>

## Why this problem matters

A growing context is not just a number:

1. **Attention gets diluted.** A model has to work through old logs and exploratory text before it reaches the current task.
2. **Local inference feels the cost.** More input generally means more prefill work, which can make an already slower local workflow feel sluggish.
3. **Compaction is lossy.** Summarizing too early can remove a path, decision, test result, or caveat you still need.
4. **A fresh session can lose continuity.** Starting over gives you a clean window, but recreating the important state by hand is easy to get wrong.

The extension is designed for the middle ground: keep the active conversation small enough to work with, while making deliberate preservation and reset steps visible to you.

## Quickstart: first use

1. Install Pi and authenticate with a provider using the [official Pi quickstart](https://github.com/earendil-works/pi#quick-start).
2. Install this package from a terminal:
   ```bash
   pi install npm:local-context-manager
   ```
3. Start Pi in a project (`pi`) or reload an already-running session with `/reload`.
4. Run:
   ```text
   /context-stats
   ```
5. Continue working normally. At a meaningful phase boundary, use `/compact-phase tests pass; implementation complete` or read [How to use it]({{ '/guides/how-to-use.html' | relative_url }}).

No configuration is required. The default `balanced` mode is intentionally conservative. If a long session becomes slow, use `/context-mode aggressive`; if compaction feels too frequent, use `/context-mode relaxed`.

## Choose the right operation

| Operation | Use it when | What happens |
| --- | --- | --- |
| Native `/compact` | The context is getting large and you want Pi's ordinary summary | Pi compacts the session while keeping recent context. |
| `/context-mode [profile]` | A growing session feels slow or compaction feels too frequent | Chooses `aggressive`, `balanced`, or `relaxed` for the current session. |
| `/compact-phase [reason]` | A meaningful phase is complete but you are continuing the same task | The extension asks for a phase-focused compaction at an idle boundary. |
| `/handoff <objective>` | You want a fresh session focused on a substantially different objective | A continuation prompt is drafted, shown for editing, then a new session starts only after review. |
| `/checkpoint-reset [reason]` | A major episode is complete and you want a small continuation capsule plus a durable local archive | You review the archive and capsule, explicitly approve, then a parent-linked fresh session starts. |

`request_context_compaction` and `request_context_reset` are model-facing tools. The model may use them at an appropriate boundary; the reset tool only recommends `/checkpoint-reset` and never resets your session by itself.

## Guides and reference

| Guide | What it answers | Best for |
| --- | --- | --- |
| [🚀 Installation & first launch]({{ '/guides/installation.html' | relative_url }}) | How to install Pi, install the npm package, verify it, update it, and recover common setup problems | First-time Pi users |
| [💡 Why context matters]({{ '/guides/understanding-context.html' | relative_url }}) | What context, prefill, compaction, cache-friendly behavior, and continuity mean | Anyone new to context management |
| [🧭 How to use it]({{ '/guides/how-to-use.html' | relative_url }}) | A practical workflow for stats, phases, handoffs, checkpoint resets, and recovery | Daily users |
| [⚙️ Configuration]({{ '/reference/configuration.html' | relative_url }}) | Every setting, default, precedence rule, and trust boundary | Users who need tuning |
| [⌨️ Command reference]({{ '/reference/commands.html' | relative_url }}) | Slash commands and model-facing tools at a glance | Quick lookup |
| [📦 Releases]({{ '/reference/releases.html' | relative_url }}) | Version history and distribution links | Upgrading or auditing a release |

## Safety and boundaries

- Pi remains responsible for emergency/overflow compaction.
- The extension does not automatically reset a session, detect GitHub PRs, or load old checkpoints into a new prompt.
- A checkpoint reset requires idle time, generated-artifact review, explicit approval, and a successful local write before the session changes.
- Checkpoints can contain private paths and implementation notes. They are stored as local agent state, outside the repository by default, and should not be committed or uploaded.
- Model-generated compaction, handoff, and checkpoint text uses the currently selected Pi model/provider. Choose a local provider if that is your required data boundary.

Read [Why context matters]({{ '/guides/understanding-context.html' | relative_url }}) for the full mental model and [How to use it]({{ '/guides/how-to-use.html' | relative_url }}) for cancellation and recovery paths.

## Project links

- [Source code and issues](https://github.com/SaehwanPark/local-context-manager)
- [npm package](https://www.npmjs.com/package/local-context-manager)
- [Changelog](https://github.com/SaehwanPark/local-context-manager/blob/main/CHANGELOG.md)
