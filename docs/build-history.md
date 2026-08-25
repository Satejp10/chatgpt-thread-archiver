# Build and release history

This document is the maintainer-facing build record for **ChatGPT Thread Archiver**. It is intentionally a concise, reproducible record rather than a raw terminal transcript. Raw logs can contain local paths, environment details, or accidental sensitive data; do not commit them.

## Current stable state

| Item | Value |
|---|---|
| Stable branch | `main` |
| Current release | `v0.9.0` |
| Latest stable merge commit | `aefd2e2` |
| Canonical installable artifact | `dist/chatgpt-chats-exporter.user.js` |
| Root convenience artifact | `chatgpt-chats-exporter.user.js` |
| Artifact rule | Root and `dist/` userscripts must be byte-identical |
| Runtime dependencies | None |
| Required Node version | Node.js 20 or newer |

## Reproducible build

From the repository root:

```bash
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
cmp -s dist/chatgpt-chats-exporter.user.js chatgpt-chats-exporter.user.js
```

Expected results are:

```text
npm run build  -> Wrote dist/chatgpt-chats-exporter.user.js (... bytes)
npm run check  -> All fixture checks passed.
node --check   -> no output and exit code 0
cmp            -> no output and exit code 0
```

The build output is generated from `src/` by `build.mjs`. Do not edit `dist/chatgpt-chats-exporter.user.js` or the root convenience copy by hand. After source changes, run the build and then copy the generated file to the root:

```bash
cp -f dist/chatgpt-chats-exporter.user.js chatgpt-chats-exporter.user.js
```

The current bundling order is important. `build.mjs` concatenates `src/core.mjs`, `src/chatgpt-client.mjs`, `src/claude-client.mjs`, `src/chatgpt-assets.mjs`, `src/export-stats.mjs`, and `src/exporter-ui.js` into one userscript IIFE. The asset module relies on helper functions defined earlier in the concatenated client module, and the UI relies on the statistics helper.

## Release milestones

| Release | Main purpose | Validation status | Release state |
|---|---|---|---|
| `v0.9.1` | Fix the exported offline interaction script so Dark mode, Copy, and navigation controls initialize | Local build/check pending final validation; live offline-control testing remains | Candidate on feature branch |
| `v0.9.0` | ChatGPT Projects `/g/*` activation and optional all-branch export for edited prompts/regenerated responses | Local build/check completed; live Projects and branch testing remains | **Current stable release** |
| `v0.8.1` | Optional per-message model labels with explicit unknown/not-found wording, plus dark-theme export toggle | Local build/check completed; live model-label/theme testing remains | Historical |
| `v0.8.0` | Per-export ChatGPT image choices: include all, exclude all, or choose individual images | Local build/check completed; live image-choice testing remains | Historical |
| `v0.7.0` | Expanded ChatGPT image recovery and safe local export statistics | Local build/check completed; live image testing remains | Historical |
| `v0.6.0` | Basic Claude.ai text export, shared model display, provider-scoped activation | Local build/check completed; live Claude testing completed by product owner | Historical |
| `v0.1.0` | API-based conversation exporter MVP | Local build/check completed during initial implementation | Historical |
| `v0.2.0` | Legacy-style UI, prompt rail, copy controls, privacy preferences, security hardening | Local build/check completed | Historical |
| `v0.3.0` | Thread Archiver rename, preference migration, bounded JSON handling, rail fixes | Local build/check completed | Historical |
| `v0.3.1` | Bounded account/workspace context scan restored | Local build/check completed | Historical |
| `v0.3.2` | Alternate conversation endpoint retry after HTTP 400/404 | Local build/check completed | Historical |
| `v0.3.3` | Structured tool/resource message formatting | Local build/check completed | Historical |
| `v0.4.0` | Best-effort image support, data-URL embedding, explicit unavailable markers | Local build/check completed; live image testing continued afterward | Historical |
| `v0.4.1` | Query-bearing image metadata route and `post_id` fallback | Local build/check completed | Historical |
| `v0.4.2` | Bounded nested signed-URL discovery for image metadata | Local build/check completed | Historical |
| `v0.5.0` | Audit remediation: structured-field preservation, attachment markers, coverage reporting, hidden-message labels, ISO timestamps, branch fallback, filename hardening, SPA recovery, image budgets | Local build/check completed | Historical remediation release |
| `v0.5.1` | Restrict activation to `/c/*` and `/s/*`; lift mobile controls above the composer/send area | Local build/check completed; live testing owned by the user | Historical |

## Validation record for v0.9.1 candidate

The v0.9.1 candidate is being prepared on `fix-offline-controls` from merged `origin/main` after reproducing a shared offline-script syntax error that disabled Dark mode, Copy, branch navigation, and prompt-rail controls.

| Check | Result |
|---|---|
| `npm run build` | Pending final validation |
| `npm run check` | Pending final validation |
| `node --check dist/chatgpt-chats-exporter.user.js` | Pending final validation |
| Root/dist byte comparison | Pending final artifact sync |
| Offline Dark mode and Copy browser check | Passed after source correction |
| Live acceptance of downloaded v0.9.1 artifact | Pending product-owner testing |

The candidate is not the stable release until local validation, live offline-control testing, and the normal pull-request review/merge process are complete.

## Validation record for v0.9.0 release

The v0.9.0 candidate was built and checked on 2026-08-25 on `pending-projects-theme-branches` after adding ChatGPT Projects-route activation, branch retention for ChatGPT and Claude.ai, optional all-branch rendering, offline branch navigation, and branch-aware image-selection offsets.

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; route, nested-branch, Claude, renderer, statistics, and image-offset checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Passed |
| `git diff --check` | Passed |
| Live ChatGPT Projects route acceptance | Pending product-owner testing; route semantics must be confirmed |
| Live edited/regenerated branch acceptance | Pending product-owner testing on ChatGPT and Claude.ai |

The candidate is not the stable release until local validation, live route/branch testing, and the normal pull-request review/merge process are complete.

## Validation record for v0.8.1 candidate

The v0.8.1 candidate was built and checked on 2026-08-22 on the `chatgpt-image-options-v0.8` feature branch after adding optional per-message model labels:

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; known-model, unknown-model, disabled-label, and existing fixture checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Passed |
| Live ChatGPT/Claude model-label acceptance | Pending product-owner testing |

The candidate is not the stable release until live model-label testing and the normal pull-request review/merge process are complete.

## Validation record for v0.8.0 candidate

The v0.8.0 candidate was built and checked on 2026-08-22 on the `chatgpt-image-options-v0.8` feature branch after adding per-export ChatGPT image controls:

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; ChatGPT and Claude fixture/regression checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Pending final artifact sync |
| Live ChatGPT image-choice acceptance | Pending product-owner testing |

The candidate is not the stable release until live image-choice testing and the normal pull-request review/merge process are complete.

## Validation record for v0.7.0 candidate

The v0.7.0 candidate was built and checked on 2026-08-22 on the `chatgpt-images-stats-v0.7` feature branch after expanding ChatGPT image handling and adding safe local export statistics:

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; all ChatGPT and Claude fixture/regression checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Passed |
| Live ChatGPT image acceptance | Pending product-owner testing |

The candidate is not the stable release until live image testing and the normal pull-request review/merge process are complete.

## Validation record for v0.6.0

The v0.6.0 release was built and checked on 2026-08-22 on the `claude-basic-v0.6` feature branch after adding the Claude text adapter and synchronizing the root and `dist/` artifacts:

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; all ChatGPT and Claude fixture/regression checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Passed |
| Live Claude browser acceptance | Pending product-owner testing |

The release was merged into `main` through PR #8 after initial product-owner testing.

## Validation record for v0.5.1

The v0.5.1 patch release was built and checked on 2026-08-22 after synchronizing the root and `dist/` artifacts:

| Check | Result |
|---|---|
| `npm run build` | Passed; generated userscript written to `dist/` |
| `npm run check` | Passed; all fixture and regression checks passed |
| `node --check dist/chatgpt-chats-exporter.user.js` | Passed |
| Root/dist byte comparison | Passed |
| GitHub pull request | PR #6 merged into `main` |
| Remote branch cleanup | Feature branch removed; stable remote branch is `main` |

Local checks prove deterministic parsing, rendering, bundling, and syntax. They cannot prove that ChatGPT’s or Claude.ai’s live internal endpoints, session responses, image assets, organization context, or mobile layout remain unchanged. Live browser and offline-file acceptance remains the product owner’s responsibility.

## GitHub release workflow

Never push feature work directly to `main`. Start from the latest remote main, create a descriptive non-main branch, make the smallest scoped change, run the required checks, commit, push, and open a pull request against `main`. Merge only after the change is reviewed or the product owner explicitly requests the merge.

After a merge, fetch with pruning and verify the stable branch:

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
git status --branch --short
git ls-remote --heads origin
```

For a release-version change, update the package manifest, build banner, generated HTML provenance, tests, README, changelog, live checklist, generated `dist/` artifact, and root convenience artifact together.

## Safe logging rule

Do not commit raw browser console output, HAR files, response bodies, cookies, authorization headers, bearer tokens, signed image URLs, full conversation IDs, or user conversation content. Checked-in records should contain only sanitized paths, status categories, schema/property names, commit IDs, release notes, and reproducible commands.
