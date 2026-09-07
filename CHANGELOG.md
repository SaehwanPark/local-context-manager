# Changelog

All notable changes to `local-context-manager` are documented here. Version numbers also mark the project milestones represented by the merged pull requests.

## [0.3.7] - 2026-09-07

This patch defers settled compaction across the host lifecycle boundary.

### Fixed

- Schedule `agent_settled`-triggered compaction after the event dispatch boundary and skip it when the session generation has already been replaced or shut down.
- Add regression coverage for session replacement during a settled-triggered compaction.

## [0.3.6] - 2026-09-07

This patch makes stale compaction callback cleanup fully best-effort across session replacement.

### Fixed

- Contain stale-context errors from compaction completion/failure callbacks so Pi's asynchronous compact wrapper cannot surface an unhandled rejection.
- Keep status cleanup and warning notifications safe when a session context has already been invalidated.

## [0.3.5] - 2026-09-07

This patch preserves explicit phase-boundary compaction requests across transient native failures.

### Fixed

- Requeue semantic compaction intent after asynchronous, event-based, or synchronous native failures, using the existing bounded retry backoff instead of silently consuming the request.

## [0.3.4] - 2026-09-07

This patch prevents asynchronous tool-result processing from crossing session boundaries.

### Fixed

- Ignore a reduced tool result after the session generation changes while its recovery copy is being written, preventing stale telemetry/UI access after shutdown or reload.

## [0.3.3] - 2026-09-07

This patch completes lifecycle isolation for Pi's per-event extension contexts.

### Fixed

- Correlate compaction completion with the active generation and persisted compaction entry instead of comparing per-event `ExtensionContext` object identity.
- Ignore stale native completion events from an older session so telemetry and the compaction gate cannot be reset by late callbacks.

## [0.3.2] - 2026-09-07

This patch keeps compaction and coordination failures best-effort so recoverable sessions can continue.

### Fixed

- Preflight Pi's native compaction cut point before proactive or semantic requests, skipping no-op requests when the session has no summarizable history.
- Reuse Pi-compatible cut-point preparation for the extension's custom compaction path.
- Preserve continued turns when an asynchronous compaction request fails; Pi remains responsible for emergency/overflow recovery.

## [0.3.1] - 2026-09-04

This release makes context tuning intent-based for normal users while keeping numeric controls available for advanced setups.

### Added

- `balanced`, `aggressive`, and `relaxed` context profiles, with `balanced` as the zero-configuration default.
- `/context-mode [aggressive|balanced|relaxed]` for symptom-based, session-local tuning.
- Automatic downward adaptation for constrained model context windows; large advertised windows never expand the configured policy.
- Effective profile and threshold reporting through `/context-stats`.

### Changed

- Numeric threshold settings remain supported as advanced overrides and are applied after profile selection.
- The compaction gate and custom compaction hook now use the active, context-window-aware thresholds.

### Boundaries

- This release does not infer thresholds from hardware, learn a performance knee from latency, or retune profiles autonomously.

## [0.3.0] - 2026-09-04

This release completes the public, npm-distributed extension workflow.

### Added

- Beginner-first documentation portal published through GitHub Pages, covering the context problem, its impact on local-LLM workflows, installation, commands, configuration, privacy, and recovery.
- Repeatable GitHub Pages deployment workflow for the `docs/` site.
- npm package metadata for `local-context-manager`, including repository, homepage, issue tracker, public publish configuration, and a publish-time validation hook.
- CI checks for typechecking, tests, builds, and npm package inspection.

### Changed

- Set the package and lockfile version to `0.3.0`.
- Reduced the root README to a short installation and orientation page, with the GitHub Pages portal as the canonical beginner guide.

## [0.2.0] - 2026-09-04

Milestone delivered by [PR #2](https://github.com/SaehwanPark/local-context-manager/pull/2).

### Added

- Reviewed `/checkpoint-reset [reason]` workflow for completed semantic episodes.
- Durable local checkpoint archives and minimal continuation capsules with parent-session linkage.
- `request_context_reset` recommendation tool and `/context-checkpoints` listing command.
- Lineage telemetry, checkpoint storage configuration, atomic persistence, and focused tests.

### Safety

- A model-facing reset request only recommends the reviewed command; it never writes a checkpoint or changes sessions by itself.
- Generation, editing, approval, storage, and fresh-session failures preserve the active session.

## [0.1.0] - 2026-09-04

Initial extension milestone delivered by [PR #1](https://github.com/SaehwanPark/local-context-manager/pull/1).

### Added

- Layered global/project JSON configuration with validation, trust gating, and safe defaults.
- Context telemetry and `/context-stats` reporting.
- Guarded proactive native compaction with hysteresis, in-flight protection, cooldown, and Pi emergency-compaction fallback.
- Conservative reduction of newly arriving oversized build, failure, search, diff, and generic tool results, with recoverable full-output paths.
- Optional semantic compaction through `request_context_compaction` and `/compact-phase`.
- Reviewed `/handoff <objective>` continuation prompts and fresh-session initialization.
- Package metadata, examples, tests, and build/typecheck configuration.

[0.3.7]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/SaehwanPark/local-context-manager/pull/5
[0.3.0]: https://github.com/SaehwanPark/local-context-manager/releases/tag/v0.3.0
[0.2.0]: https://github.com/SaehwanPark/local-context-manager/pull/2
[0.1.0]: https://github.com/SaehwanPark/local-context-manager/pull/1
