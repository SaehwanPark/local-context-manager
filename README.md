# local-context-manager

`local-context-manager` is a [Pi](https://github.com/earendil-works/pi) extension for long-running sessions, especially workflows using local models where large prompts can make prefill slower and context overflow more disruptive.

## Start here

The **[beginner documentation portal](https://saehwanpark.github.io/local-context-manager/)** explains the problem, why it matters, installation, first use, commands, configuration, privacy, and recovery. The portal is the canonical user guide; this README stays short so the same instructions work on GitHub and npm.

## Install in Pi

```bash
pi install npm:local-context-manager
```

Start (or reload) Pi in your project, then try:

```text
/context-stats
```

The extension works with Pi's existing models and configuration. It does not install a model or change Pi's emergency compaction authority. The latest published release can be pinned with `npm:local-context-manager@0.3.0`.

## What it adds

- telemetry for context size, compaction, and reduced tool output;
- balanced-by-default context profiles (`aggressive`, `balanced`, `relaxed`) with automatic downward adaptation for small model windows;
- guarded proactive compaction at safe idle boundaries;
- conservative reduction of only new oversized tool results, with a recovery path;
- intentional phase compaction with `/compact-phase`;
- reviewed `/handoff` and `/checkpoint-reset` workflows for starting a fresh session without silently discarding important work.

All session-changing workflows are reviewable. The extension does not automatically reset sessions or inject archived checkpoints into later prompts.

## Development

```bash
npm install
npm run check
npm run build
```

See the [source repository](https://github.com/SaehwanPark/local-context-manager) and the [full changelog](CHANGELOG.md) for project history.

## License

MIT
