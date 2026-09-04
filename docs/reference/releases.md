---
title: Releases & distribution
description: Release history and installation links for local-context-manager.
---

# Releases & distribution

[Documentation portal]({{ '/' | relative_url }}) · [Installation & first launch]({{ '/guides/installation.html' | relative_url }}) · [GitHub changelog](https://github.com/SaehwanPark/local-context-manager/blob/main/CHANGELOG.md)

The current release is **`{{ site.version }}`**. It is distributed as a Pi package through npm and documented through this GitHub Pages site.

## Install the current release

```bash
pi install npm:local-context-manager
```

To pin the current release:

```bash
pi install npm:local-context-manager@0.3.0
```

- [npm package](https://www.npmjs.com/package/local-context-manager)
- [GitHub repository](https://github.com/SaehwanPark/local-context-manager)
- [Beginner installation guide]({{ '/guides/installation.html' | relative_url }})

## Version history

| Version | Milestone | Highlights |
| --- | --- | --- |
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

When upgrading, restart Pi or use `/reload`. If you need to preserve a reproducible setup, use the pinned `npm:local-context-manager@<version>` form and keep the version in your project notes.
