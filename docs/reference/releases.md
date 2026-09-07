---
title: Releases & distribution
description: Release history and installation links for local-context-manager.
---

# Releases & distribution

[Documentation portal]({{ '/' | relative_url }}) · [Installation & first launch]({{ '/guides/installation.html' | relative_url }}) · [GitHub changelog](https://github.com/SaehwanPark/local-context-manager/blob/main/CHANGELOG.md)

The current source release is **`{{ site.version }}`**. GitHub and the Pages site document v0.3.4; the npm registry currently serves v0.3.1 until the repository's one-time trusted-publisher configuration is completed and the release workflow is rerun.

## Install the current release

```bash
pi install npm:local-context-manager
```

To pin the latest published npm package:

```bash
pi install npm:local-context-manager@0.3.1
```

- [npm package](https://www.npmjs.com/package/local-context-manager)
- [GitHub repository](https://github.com/SaehwanPark/local-context-manager)
- [Beginner installation guide]({{ '/guides/installation.html' | relative_url }})

## Version history

| Version | Milestone | Highlights |
| --- | --- | --- |
| **0.3.4** | Stale tool-result isolation (GitHub source release) | Session-generation guard for asynchronous recovery-copy writes; npm publication is pending trusted-publisher setup. |
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

When upgrading, restart Pi or use `/reload`. If you need to preserve a reproducible setup, use the pinned `npm:local-context-manager@<version>` form and keep the version in your project notes.
