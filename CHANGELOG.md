# Changelog

All notable changes to `local-context-manager` are documented here. Version numbers also mark the project milestones represented by the merged pull requests.

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

[0.3.0]: https://github.com/SaehwanPark/local-context-manager/releases/tag/v0.3.0
[0.2.0]: https://github.com/SaehwanPark/local-context-manager/pull/2
[0.1.0]: https://github.com/SaehwanPark/local-context-manager/pull/1
