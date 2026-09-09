# Claude Code Context Port — ChatGPT Thread Archiver

> Paste the section **“Prompt to paste into Claude Code”** into a new Claude Code Web chat connected to this repository. The rest of this document is the durable handoff record.

## Prompt to paste into Claude Code

You are taking over the **ChatGPT Thread Archiver** repository. Work directly against the connected GitHub repository, but do not merge or push to `main` unless I explicitly ask.

The product is a privacy-first browser userscript that exports the currently open **ChatGPT** or **Claude.ai** conversation into a standalone offline HTML file. It uses each provider’s same-origin internal web-app requests to retrieve structured conversation data. It has no telemetry, no project server, and no third-party API calls.

### Current product and branch state

| Item | Current state |
|---|---|
| Repository | `Satejp10/chatgpt-thread-archiver` |
| Working branch | `image-model-metadata` |
| Target branch | `main` |
| Current feature commit | `59a6ebd` — `docs: link v0.11.0 candidate record` |
| Previous implementation commit | `01fa882` — `feat: add optional image model labels` |
| Pull request | [#18](https://github.com/Satejp10/chatgpt-thread-archiver/pull/18) |
| PR state | Open; review and live testing are still pending |
| Candidate version | v0.11.0 |
| Version record | `docs/version-history/v0.11.0.md` |
| Base commit for this candidate | `60058a41be2b63348d70039abeddd38324c2aac3` |

The current branch has already been pushed to origin. The working tree was clean after the push.

### What v0.11.0 adds

The feature adds an optional per-image label for generated ChatGPT images. When a reliable image-specific model identifier is present in bounded metadata, the export can show that exact identifier near the image. When no trustworthy identifier is available, the export must show:

> `Image model: unknown / not found`

The implementation must never infer the image model from the surrounding assistant model, the prompt, filename, URL, image appearance, or a general conversation-level model label.

The same preference used for optional per-message model indicators controls whether the image-model label is shown. The individual-image selection UI also exposes the safe label where appropriate.

### Files changed for this feature

| File | Role |
|---|---|
| `src/core.mjs` | Bounded image-model extraction, safe fallback, image caption rendering, and normalized metadata handling |
| `src/exporter-ui.js` | Image-selection UI label support |
| `test.mjs` | Model extraction, unsafe-value, rendering, preference, and generated-script compilation regression coverage |
| `README.md` | User-facing image-model behavior and latest-version links |
| `docs/version-history/v0.11.0.md` | Permanent candidate release record |
| `CHANGELOG.md` and supporting docs | Release and maintenance documentation |
| `build.mjs`, `dist/chatgpt-chats-exporter.user.js`, `chatgpt-chats-exporter.user.js` | Versioned generated userscript artifacts |

### Validation already completed

The following checks passed before PR creation:

```bash
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
cmp -s dist/chatgpt-chats-exporter.user.js chatgpt-chats-exporter.user.js
git diff --check
```

The regression suite also compiles the generated offline script. This was added because a previous release accidentally disabled offline controls through a script syntax error. The branch-control, dark-mode, copy-button, image-selection, privacy, unsafe-value, and generated-artifact checks are intended to remain protected.

### Required privacy boundaries

Treat all provider responses, browser data, and user conversations as sensitive. Never commit or export raw response bodies, HAR files, headers, cookies, authorization tokens, signed URLs, image bytes, full conversation IDs, or conversation text from a live diagnostic.

A live diagnostic may retain only sanitized information such as a redacted route shape, status category, boolean auth/organization context, safe property names, and an explicitly safe image-model identifier. Do not add telemetry, remote logging, analytics, or third-party requests.

The offline HTML must remain self-contained with its restrictive CSP and inline assets. It must work without network access after export.

### What Claude Code should do first

1. Read `README.md`, `docs/developer-handoff.md`, `docs/maintenance-notes.md`, `docs/build-history.md`, `docs/version-history/README.md`, and `docs/version-history/v0.11.0.md`.
2. Inspect PR #18 and confirm that the branch contains the expected commits and no unrelated changes.
3. Run the local checks again before modifying code.
4. Review the image-model extraction and tests for accidental broad metadata matching or unsafe value retention.
5. Do not redesign the feature or expand scope without asking first.

### Immediate product-owner acceptance test

The remaining decision is a real browser test, not another speculative code change:

1. Open ChatGPT while signed in.
2. Create one fresh generated image.
3. Export that conversation with images included and the optional model indicators enabled.
4. Open the downloaded HTML offline.
5. Confirm the image caption shows either an exact exposed image model or `unknown / not found`.
6. Confirm dark mode, copy, image selection, and branch controls still work in the offline file.

If the live export shows `unknown / not found`, that is an acceptable and privacy-safe result. Report that ChatGPT did not expose a reliable image-specific identifier in the tested response. Do not weaken the fallback or guess a model.

If a reliable exact identifier appears, report the sanitized field name and value only. Do not send raw responses or private identifiers into the repository.

### Pull-request handling

Keep PR #18 focused. Before recommending merge, confirm:

- The local checks pass.
- The generated root and `dist` userscripts are byte-identical.
- The release record remains present under `docs/version-history/`.
- No sensitive live data entered the repository.
- The product owner has completed the fresh generated-image test.

If code changes become necessary, make them on the existing feature branch, update the version record if the candidate changes materially, rerun all checks, and push to PR #18. Do not merge automatically.

### Product history that matters

The project previously added basic Claude.ai text export in v0.6. Claude rich artifacts, attachments, research content, and other complex blocks remain separate future work. ChatGPT image support has evolved through bounded same-origin asset resolution, image selection modes, explicit omission markers, and size/count limits.

ChatGPT Projects use `/g/*` routes. Branch navigation supports edited prompts and regenerated responses through local message-level controls in offline HTML. The exporter preserves a message-tree model and must not expose provider mutation actions such as edit or regenerate.

The product owner prefers simple, CEO/CPO-friendly reporting: state the decision, user impact, risks, and requested action first; explain technical details only when needed.

### Final instruction

Start by inspecting the repository and PR #18. Do not assume the feature is ready to merge until the fresh generated-image live test is complete. Preserve the privacy and fallback rules above.

## Durable handoff notes

This document was created after PR #18 was opened. It is intentionally more current than older handoff text that may still describe v0.9.1 as the latest state. The authoritative current work is the `image-model-metadata` branch and PR #18.

The candidate is not a final release until review and live acceptance are complete. If the PR is merged, update the v0.11.0 version record with the merge commit and release state, then confirm that the main branch artifacts and README links remain correct.

## References

- [Repository](https://github.com/Satejp10/chatgpt-thread-archiver)
- [Pull request #18](https://github.com/Satejp10/chatgpt-thread-archiver/pull/18)
