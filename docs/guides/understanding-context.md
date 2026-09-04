---
title: Why context matters
description: A plain-language explanation of context windows, local-model prefill, compaction, and the design boundaries of local-context-manager.
---

# Why context matters

[Documentation portal]({{ '/' | relative_url }}) · [Install & launch]({{ '/guides/installation.html' | relative_url }}) · [How to use it]({{ '/guides/how-to-use.html' | relative_url }})

You can use Pi without knowing any of the terms on this page. This is the mental model that explains why `local-context-manager` exists.

## What is “context”?

A Pi session is a conversation made of user prompts, model replies, tool calls, and tool results. Before the model answers, Pi assembles the relevant conversation into the model's **context**. The context is the model's working window for that reply.

A context window has a limit. Even before the limit is reached, a larger input can be harder and slower to process:

```text
short prompt  ──► model reads a little ──► quick response
long session  ──► model reads much more ──► more prefill work and more noise
```

**Prefill** is the work a model does to read the input before generating its answer. It is especially noticeable with local models running on your own hardware, where a long prompt can make the next response take longer.

## Why ordinary coding sessions grow

A useful coding task naturally produces context:

- a source file read;
- a test run or build log;
- a plan and a set of edits;
- a debugging detour;
- a review of what changed.

The problem is not that any one item is bad. It is that a verbose command can repeat hundreds of lines of low-priority output, while the conversation still needs the final error, changed path, or test status.

When the session becomes crowded, you have three imperfect choices:

1. **Keep everything:** preserve detail, but make every later turn pay for it.
2. **Compact:** shrink older history into a summary, but accept that summaries can omit details.
3. **Start a new session:** get a clean window, but manually rebuild continuity.

This extension helps you choose deliberately instead of discovering the tradeoff after an overflow.

## What the extension adds

### 1. A reading of the pressure

`/context-stats` reports the context reading or estimate, threshold progress, post-compaction growth, reduced tool-output volume, and compaction history. A footer status item gives a compact view while you work.

The reading may be **unknown** immediately after compaction or before Pi receives provider usage. When possible, the extension estimates the active context from the current session; it does not pretend the estimate is exact.

### 2. Less repeated tool noise

The extension inspects each new tool result. If a result is eligible and oversized, it retains diagnostics, paths, headers, and prioritized excerpts rather than copying the entire output into the next prompt.

It does not rewrite old session messages on every turn. Source-file reads and small results are preserved. When output is shortened, the extension keeps an existing structured full-output path or writes a restricted local recovery copy and shows its path in the replacement result. If it cannot preserve a recovery path, it leaves the original result alone.

This is what **cache-friendly** means here: the extension avoids continually rewriting history, so it changes only the current result when necessary. It cannot control every cache decision made by a provider.

### 3. Safer compaction timing

Pi remains the authority for emergency/overflow compaction. The extension can request proactive compaction when the context crosses your configured threshold, but it waits for Pi to be idle and uses guards against concurrent requests and rapid loops.

You can also request an intentional phase compaction with:

```text
/compact-phase completed implementation and tests
```

The reason helps the compaction focus on the boundary you chose. It is still a summary, not a lossless archive.

### 4. Deliberate continuity choices

At a meaningful boundary, you can choose:

- **Handoff:** a fresh session with a reviewed prompt for a new objective.
- **Checkpoint reset:** a durable local archive plus a much smaller continuation capsule, followed by a reviewed parent-linked fresh session.

A checkpoint is not a second hidden conversation. The new session does not automatically load the archive. The capsule points to it so the model can inspect historical details only when you choose to do so.

## What it does not do

This extension is intentionally not:

- an unlimited context window;
- a vector database, RAG system, or knowledge graph;
- an automatic memory loader;
- a GitHub PR watcher or project-state database;
- a replacement for Pi's native emergency compaction;
- a guarantee that local inference will be fast;
- a way to infer facts that were never in the session.

It manages boundaries around Pi's existing session APIs. The original Pi session remains the most complete record.

## Privacy and recovery boundaries

The extension can create local files:

- reduced tool results may point to a temporary recovery copy;
- checkpoint resets write a Markdown archive under the configured checkpoint directory;
- generated handoff, compaction, and checkpoint text may contain the same project paths and decisions present in your session.

By default, checkpoint files live outside the repository under Pi's agent directory, separated by a repository hash, and are written with restrictive local permissions. Treat them as private agent state: do not commit or upload them casually.

Model-generated operations use the currently selected Pi provider, just like a normal Pi model request. If content must stay on your machine, configure a local provider before invoking those operations and review the generated text before approving it.

## The practical rule

Use ordinary Pi first. Watch `/context-stats`. Compact at a meaningful phase boundary when the active conversation is becoming unwieldy. Use checkpoint reset only after a completed semantic episode when you want both a durable local record and a clean continuation.

The [How to use it guide]({{ '/guides/how-to-use.html' | relative_url }}) shows the exact commands and what to do if you cancel or a step fails.
