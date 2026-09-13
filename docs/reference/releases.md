---
title: Releases & distribution
description: Release history and installation links for local-context-manager.
---

# Releases & distribution

[Documentation portal]({{ '/' | relative_url }}) · [Installation & first launch]({{ '/guides/installation.html' | relative_url }}) · [GitHub changelog](https://github.com/SaehwanPark/local-context-manager/blob/main/CHANGELOG.md)

The current source release is **`{{ site.version }}`**. GitHub and the Pages site document v0.5.0. While npm package deployment is pending trusted-publishing configuration, installing directly from GitHub via `git:...` is recommended by default.

## Install the current release

Install directly from GitHub:

```bash
pi install git:github.com/SaehwanPark/local-context-manager
```

To pin a specific release version (for example `v0.5.0`):

```bash
pi install git:github.com/SaehwanPark/local-context-manager#v0.5.0
```

- [GitHub repository](https://github.com/SaehwanPark/local-context-manager)
- [Beginner installation guide]({{ '/guides/installation.html' | relative_url }})
- [npm package](https://www.npmjs.com/package/local-context-manager) *(npm serves v0.3.1 until trusted publishing is active)*

## Version history

| Version | Milestone | Highlights |
| --- | --- | --- |
| **0.5.0** | Comprehensive resilience hardening (R1-R3 audit) | Over-threshold compaction hysteresis, session-addressable manifest recovery with lease refresh, lazy interop querying with AbortSignal cancellation, correlated semantic compaction, and safe tool-output recovery. |
| **0.4.3** | Joint audit hardening | Provider-owned quiescence, recovery-safe embedded deactivation, strict snapshot validation, and session-scoped safe-agent fabrics. |
| **0.4.2** | Cross-project V1 interoperability | Fail-closed fabric state handling, isolated embedded recovery, coordinated reset safety, and portable smoke coverage. |
| **0.4.1** | Cross-project reset protection | Safe-agent fabric coordination, forced reset archives, semantic compaction deferral, and bounded recovery storage. |
| **0.4.0** | Embedded companion integration | Embeddable context management, interop providers, fabric-aware semantic reset, and isolated Pi smoke tests. |
| **0.3.8** | Compaction event identity isolation (GitHub source release) | Retired/duplicate completion events cannot mutate a newer request; npm publication is pending trusted-publisher setup. |
| **0.3.7** | Settled compaction lifecycle isolation | Deferred settled compaction skips replaced sessions. |
| **0.3.6** | Stale callback containment | Invalidated compaction callbacks cannot surface unhandled UI/status errors. |
| **0.3.5** | Semantic retry preservation | Explicit phase-boundary requests survive transient native failures with bounded retry backoff. |
| **0.3.4** | Stale tool-result isolation | Session-generation guard for asynchronous recovery-copy writes. |
| **0.3.3** | Compaction event isolation | Per-event context-safe completion handling and stale-event suppression. |
| **0.3.2** | Nonfatal compaction recovery | Native cut-point preflight, async failure recovery/backoff, and lifecycle-safe callbacks. |
| **0.3.1** | Adaptive context profiles | Balanced/aggressive/relaxed profiles, constrained-window adaptation, and effective threshold reporting. |
| **0.3.0** | Public distribution and documentation | GitHub Pages portal, npm metadata and publication, CI/package checks, and beginner-first user guidance. |
| **0.2.0** | [PR #2](https://github.com/SaehwanPark/local-context-manager/pull/2) | Reviewed checkpoint reset, durable local archives, continuation capsules, reset recommendations, listing, and lineage telemetry. |
| **0.1.0** | [PR #1](https://github.com/SaehwanPark/local-context-manager/pull/1) | Initial extension: telemetry, guarded compaction, tool-output reduction, semantic phase compaction, and reviewed handoff. |

For the complete categorized history, read the [root `CHANGELOG.md`](https://github.com/SaehwanPark/local-context-manager/blob/main/CHANGELOG.md).

## Release boundaries

This project publishes the extension source, configuration example, README, and changelog in its npm package. Pi loads the TypeScript entry point directly; the package does not ship a model, a standalone daemon, or a separate database.

Every release should be checked with:

```bash
npm ci
npm run check
npm run build
npm pack --dry-run
```

Published GitHub releases now run `.github/workflows/release.yml`, which verifies that the tag matches `package.json` and publishes through npm trusted publishing. The npm package's one-time trusted-publisher setting must point to this repository and workflow; no long-lived npm token is stored in GitHub. The GitHub Pages workflow deploys documentation from `main`.

When upgrading, restart Pi or use `/reload`. If you need to preserve a reproducible setup, use the pinned `git:github.com/SaehwanPark/local-context-manager#<version>` form and keep the version in your project notes.
