# Changelog

All notable changes to `local-context-manager` are documented here. Version numbers also mark the project milestones represented by the merged pull requests.

## [0.5.0] - 2026-09-13

This major resilience and hardening release addresses all findings from the three failure-mode audits (PR #18, PR #19, and Round 3), ensuring the extension "does not make local-model context or compaction problems worse, and preferably makes them better."

### Fixed

- **CompactionGate Over-Threshold Hysteresis**: Fixed periodic compaction churn when a successful compaction lands at or above `compactThresholdTokens` (e.g. 33k tokens on a 32k threshold). The gate now checks `crossedThreshold` rather than `reachedThreshold`, requiring meaningful token growth (`growthRatio >= 1.05` and `>= 1,000` tokens) before rearming (`33k -> 33k` and `33k -> 33.5k` remain disarmed; `33k -> 35.5k` rearms).
- **Session-Addressable Recovery Storage**: Replaced process-global storage with deterministic per-session storage directories (`pi-lcm-recovery/<session-hash>/`). Each session maintains an on-disk `manifest.json` recording managed files, sequence numbers, and pruned paths, enabling full recovery reattachment after process restart or session resume.
- **Independent Session Quotas**: Isolated LRU quotas (50 files / 50 MB) per session, preventing unrelated active sessions from evicting each other's recovery copies.
- **Heartbeat & Lease Refresh on Reference**: Touching or rereading an existing recovery copy updates the session's `heartbeat` lease and manifest timestamp, ensuring active long-running sessions are never swept by background cleanup.
- **Lease-Aware Stale Directory Sweeping**: Sweeper checks heartbeat and manifest timestamps rather than directory filesystem mtimes, removing orphaned directories older than 3 days while protecting active sessions.
- **Lazy Interop Fabric Querying**: `agent_settled` now queries fabric status lazily only when an explicit semantic compaction or checkpoint reset requires coordination, eliminating unnecessary 2-second stalls during routine threshold compaction.
- **AbortSignal Interop Cancellation**: Integrated `signal?: AbortSignal` across LCM interop queries and companion `pi-safe-agent-team` broker requests (`FabricSnapshotRequest`, `getFabricStateSnapshot`, `status`, `BrokerClient.request`), immediately removing cancelled requests from pending state and preventing resource leaks.
- **Strict Semantic Compaction Correlation**: In `session_before_compact`, deep semantic preparation is strictly correlated to manual LCM requests (`event.reason === "manual"`). Unrelated automatic compactions (overflow recovery or native Pi threshold compactions) preserve pending semantic intent.
- **Conservative Evidence Timing**: In `tool_result`, evidence reduction counters are recorded only after full recovery output is successfully persisted to disk, preventing phantom reduction notices when storage fails.
- **Native Compaction Invariant**: Routine proactive compaction delegates directly to Pi's native summarizer, and emergency overflow compactions are never intercepted or overridden.
- **Documentation Drift**: Corrected relative `checkpointDirectory` resolution documentation to reflect that relative paths resolve from the Pi agent directory (never the repository working tree), updated `keepRecentTokens` documentation to clarify its semantic-only deep compaction role, updated recovery storage lifecycle descriptions, and updated pinned installation instructions to `#v0.5.0`.

## [0.4.3] - 2026-09-08

This patch completes the joint hardening pass with `pi-safe-agent-team`, closing the remaining quiescence, recovery-lifetime, and concurrent-session isolation gaps.

- **Provider-Owned Fabric Quiescence**: Semantic compaction and reset recommendations now trust the safe-agent provider's complete `quiescent` projection, while retaining only the narrowly justified root-only settled-event lag exception.
- **Strict Fabric Snapshot Validation**: Require safe integer counters and reject contradictory known active snapshots that claim session replacement is safe while non-quiescent.
- **Recovery-Safe Embedded Deactivation**: Embedded managers expose a non-destructive `deactivate()` lifecycle so companion hosts can fall back to native context handling without deleting recovery files still referenced by the transcript; `dispose()` remains final cleanup.

## [0.4.2] - 2026-09-08

This release addresses the second round cross-project audit feedback to harden interoperability with `pi-safe-agent-team` V1 schema, robust session identity resolution, fail-closed fabric coordination, and embedded context isolation.

### Fixed

- **Decouple Pi Session ID from Session File**: Refactored `resolveSessionId` and `resolveSessionFile` to ensure interop fabric queries are strictly scoped by Pi session ID (`getSessionId()`), reserving file paths (`getSessionFile()`) for durable parent session lineage and diagnostics.
- **Fail-Closed V1 Fabric State Sanitization**: Aligned `FabricStateSnapshotV1` with safe-agent V1 schema (`state: "known" | "uncertain"`, `sessionReplacementSafe: boolean`, `capturedAt: number`, non-negative integer counters). Sanitization strictly validates all fields, failing closed to an explicit `{ kind: "uncertain" }` observation on missing or malformed data.
- **Fail-Safe Embedded Tool Output Recovery**: If `SessionRecoveryStorage` fails to save or is unavailable during embedded tool output reduction, the original tool output is preserved byte-for-byte, evidence reduction counters are not incremented, and a warning diagnostic is emitted.
- **Transient Root Settled Race Handling**: In `agent_settled`, recognized broker `root_agent_active_or_running` transient quiescence lag so non-destructive semantic compaction is not deferred when child counters are 0, while destructive `/checkpoint-reset` continues to enforce `sessionReplacementSafe: true`.
- **Per-Instance Embedded Recovery Storage Isolation**: Embedded context manager instances now manage dedicated `SessionRecoveryStorage` instances, cleanly disposing of temporary storage on `dispose()` without cross-instance contention.
- **Durably Archived Uncertain Coordination on Forced Reset**: Forced checkpoint reset (`/checkpoint-reset --force`) during fabric query failure or uncertain state now archives explicit `Coordination: uncertain (FORCED reset)` metadata with full failure details in checkpoints and continuation capsules.
- **Portable Smoke Test Suite**: Replaced hardcoded developer directory paths in smoke tests with dynamic environment variable detection and fallback discovery, skipping cleanly when peer repositories are not present.
- **Granular Context Stats**: `/context-stats` reports detailed fabric coordination status (`unavailable`, `inactive`, `active (quiescent)`, `active (busy: ...)`, or `uncertain (...)`).
- **Clean Interop Provider Registration**: Fixed duplicate provider registrations across extension factory calls by establishing a singleton provider object registered at module load.
- **Robust Token Usage Nullish Check**: Fixed token source comparison for `usage?.tokens != null`.

## [0.4.1] - 2026-09-08

This release addresses cross-project audit feedback to ensure safe coordination with `pi-safe-agent-team` and upstream Pi SDK contracts.

### Added

- **Cross-Project Reset Protection**: `/checkpoint-reset` now verifies `safe-agent-team.fabric-state.v1` and refuses normal reset if delegated child work is active or fabric state is uncertain. To override, users must pass `/checkpoint-reset --force` (or `-f`) and confirm via an explicit UI dialog warning that replacing the root session cancels active descendants.
- **Forced Coordination Snapshot**: When forced, durable checkpoints and continuation capsules record explicit coordination state with partial-completion notices, point-in-time timestamps, and active child tasks.
- **Fabric-Aware Semantic Compaction**: Semantic compaction requests (`semanticRequested` via `/compact-phase` or `request_context_compaction`) defer while child work is active or uncertain. Threshold compaction remains independent to protect root context safety.
- **Precise Token-Source Telemetry**: Replaced generic labels with `"pi-estimate"` (from Pi's `getContextUsage()`) and `"local-fallback"` (from character-based estimation). Formatted status uses `~` prefix for local fallback.
- **Bounded Session Recovery Storage**: Replaced unbounded temporary directories with a session-scoped `SessionRecoveryStorage` enforcing `0700` directory and `0600` file permissions, bounded file and byte quotas (50 files / 50 MB), and automated cleanup on clean session shutdown.
- **Pi SDK Alignment**: Aligned `EmbeddedCompactionRequest` and `EmbeddedContextSnapshot` with upstream Pi SDK signatures, adding `tokens` and `thresholdRatio` interop aliases.
- **Multi-OS CI**: Added `macos-latest` to GitHub Actions workflow matrix alongside `ubuntu-latest`.

## [0.4.0] - 2026-09-08

This release hardens `local-context-manager` for multi-agent workflows, long-running sessions, and companion extension interoperability without introducing hard dependencies.

### Added

- **Embeddable Context Manager**: Exported `createEmbeddedContextManager` from `local-context-manager/embedded` so host runtimes (such as `pi-safe-agent-team`) can manage child agent sessions safely without loading extensions.
- **Process-Local Interop Registry**: Implemented `Symbol.for("pi.extension-interop.v1")` provider registration for `local-context-manager.embedded-context.v1` and optional consumption of `safe-agent-team.fabric-state.v1`.
- **Fabric-Aware Semantic Reset**: Automatic semantic checkpoint/reset recommendations defer while delegated child work is active/non-quiescent unless the hard context ceiling is reached.
- **Evidence-Completeness Provenance**: Tool output reductions append an explicit non-exhaustive excerpt notice; compactions retain a bounded evidence-completeness caveat note when prior reductions occurred; recovery copies are stored with `0600` permissions.
- **Token-Source Telemetry**: Explicitly report whether active context tokens are host-reported or character-estimated (`~` prefix in compact status).
- **Diagnostics**: `/context-stats` and `/context-status` expose context token source, embedded provider status, fabric provider state, and reduction counts.
- **Isolated Smoke Test Suite**: Added deterministic real-Pi matrix smoke tests running with `--no-extensions` and disposable `PI_CODING_AGENT_DIR`.

## [0.3.8] - 2026-09-07

This patch rejects duplicate and retired compaction completion events.

### Fixed

- Track bounded compaction-entry identities across session generations so late completion events cannot complete a newer request or mutate current telemetry.
- Add regression coverage for a completion event arriving after session replacement.

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

[0.5.0]: https://github.com/SaehwanPark/local-context-manager/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/SaehwanPark/local-context-manager/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/SaehwanPark/local-context-manager/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/SaehwanPark/local-context-manager/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/SaehwanPark/local-context-manager/compare/v0.3.7...v0.3.8
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
