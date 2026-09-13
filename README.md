# local-context-manager

`local-context-manager` is a [Pi](https://github.com/earendil-works/pi) extension for long-running sessions, especially workflows using local models where large prompts can make prefill slower and context overflow more disruptive.

## Start here

The **[beginner documentation portal](https://saehwanpark.github.io/local-context-manager/)** explains the problem, why it matters, installation, first use, commands, configuration, privacy, and recovery. The portal is the canonical user guide; this README stays short so the same instructions work on GitHub and npm.

## Install in Pi

Install the extension directly from GitHub by default:

```bash
pi install git:github.com/SaehwanPark/local-context-manager
```

To pin a specific release version (e.g., `v0.4.3`):

```bash
pi install git:github.com/SaehwanPark/local-context-manager#v0.4.3
```

Start (or reload) Pi in your project, then try:

```text
/context-stats
```

The extension works with Pi's existing models and configuration. It does not install a model or change Pi's emergency compaction authority. While npm deployment setup is in progress, installing directly from GitHub (`pi install git:...`) is the recommended default.

## What it adds

- telemetry for context size, compaction, and reduced tool output;
- balanced-by-default context profiles (`aggressive`, `balanced`, `relaxed`) with automatic downward adaptation for small model windows;
- guarded proactive compaction at safe idle boundaries;
- conservative reduction of only new oversized tool results, with a recovery path;
- intentional phase compaction with `/compact-phase` that defers while delegated child agents are active;
- reviewed `/handoff` and `/checkpoint-reset` workflows for starting a fresh session without silently discarding important work;
- cross-project reset safety refusing normal session replacement during active child delegation unless explicitly forced via `/checkpoint-reset --force`;
- bounded session recovery storage (`0700` dir / `0600` files on POSIX; inherits `%TEMP%` ACLs on Windows) with automatic prune and clean shutdown cleanup.

All session-changing workflows are reviewable. The extension does not automatically reset sessions or inject archived checkpoints into later prompts.

## Embedded context manager & extension interoperability

`local-context-manager` also exports an embeddable API for child agent sessions or host orchestrators (such as `pi-safe-agent-team`) that run with extension discovery disabled:

```ts
import { createEmbeddedContextManager } from "local-context-manager/embedded";

const manager = createEmbeddedContextManager({
  getContextUsage: () => session.getContextUsage(),
  getContextEntries: () => session.getContextEntries(),
  compact: async (req) => { await session.compact(req); },
  onStatus: (snap) => { /* update UI */ },
  onDiagnostic: (diag) => { /* log */ },
}, {
  mode: "managed-child",
  contextWindow: 128_000,
});
```

It automatically registers with the process-local interop registry (`Symbol.for("pi.extension-interop.v1")`) under `local-context-manager.embedded-context.v1`. When running alongside companion extensions like `pi-safe-agent-team`, it consumes `safe-agent-team.fabric-state.v1` to defer automatic semantic resets while child agents are active, preserving deterministic coordination metadata in durable checkpoints.

## Development

```bash
npm install
npm run check
npm run build
```

See the [source repository](https://github.com/SaehwanPark/local-context-manager) and the [full changelog](CHANGELOG.md) for project history.

## License

MIT
