# Developer handoff

## Product summary

ChatGPT Thread Archiver is an independent browser userscript that exports the currently open ChatGPT or Claude.ai conversation to a self-contained offline HTML file. It uses the signed-in browser session and each provider’s same-origin internal web-app requests to retrieve structured conversation data. It does not use DOM scraping for message content and does not send exported conversations to a project server.

The current stable release is **v0.12.0** on `main`. Every new version must receive a record in `docs/version-history/` before its pull request is opened. The canonical installable file is `dist/chatgpt-chats-exporter.user.js`; the root `chatgpt-chats-exporter.user.js` is a byte-identical convenience copy.

## First steps for a new maintainer

Run these commands before changing anything:

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
cmp -s dist/chatgpt-chats-exporter.user.js chatgpt-chats-exporter.user.js
git status --branch --short
```

Read these documents in this order:

1. `README.md` for user-facing behavior and limitations.
2. `docs/build-history.md` for reproducible build and release history.
3. `docs/maintenance-notes.md` for boundaries that should not be casually changed.
4. `docs/version-history/README.md` for the required per-version release-record workflow, then the matching version record in that folder.
5. `docs/user-test-checklist.md` for live acceptance scenarios.
6. `CHANGELOG.md` for the user-facing version summary.

## Source ownership

| File | Owns | Safe change pattern |
|---|---|---|
| `src/chatgpt-client.mjs` | ChatGPT URL parsing, `/c/`, `/s/`, and `/g/` activation, session context, token cache, endpoint candidates, account/workspace headers, diagnostics | Keep requests same-origin and bounded. Never log credentials or full IDs. |
| `src/claude-client.mjs` | Claude `/chat/` route parsing, organization cookie, conversation request, branch selection, text normalization, diagnostics | Keep Claude requests same-origin and bounded. v0.6 marks unsupported content instead of attempting rich rendering. |
| `src/core.mjs` | Response normalization, active/all-branch traversal, message-level fork-tree rendering, content parsing, escaping, HTML generation, prompt rail, optional per-message model labels, offline branch navigation | Add a fixture before changing response handling. Preserve parent/child relationships for edited prompts and regenerated replies; keep nested fork controls scoped to their own direct options. Keep conversation text out of generated script source; show `unknown / not found` rather than guessing a missing model. |
| `src/chatgpt-assets.mjs` | Image pointer resolution, metadata fallbacks, same-origin URL allowlist, image limits, data-URL conversion | Preserve per-image and total limits, explicit fallbacks, deduplication, and no third-party fetches. Keep image-shape discovery in the normalizer and retrieval logic here. |
| `src/export-stats.mjs` | Safe local word, character, text-block, role, and model statistics | Count only normalized text included in the export. Never call the provider for token, billing, or context-window data. |
| `src/exporter-ui.js` | In-page controls, privacy options, image-choice and branch dialog, status messages, download, SPA reinsertion, mobile offsets | Keep image mode choices per-export except for the broad mode preference; branch mode may be remembered, but branch content must never be persisted. |
| `build.mjs` | Userscript metadata and dependency-free concatenation | Preserve module order and update the version here for releases. |
| `test.mjs` | Deterministic regression checks | Add tests for every parser, renderer, route, privacy, and release invariant that changes. |

## Important behavior invariants

The exporter must remain active only on `chatgpt.com/c/*`, `chatgpt.com/s/*`, `chatgpt.com/g/*`, and `claude.ai/chat/*`. The runtime guard and userscript metadata must agree. The exporter should not inject on settings, home, image, project, new-chat, or unrelated pages.

Conversation text must come from the structured response path. Do not replace it with DOM scraping simply because the webpage DOM is convenient. The active mapping branch is selected through the current node when available; fallback leaves are childless message nodes ranked chronologically when timestamps allow it. The normalizer may retain every valid leaf path for optional all-branch export, but current-branch export remains the default.

When both `content.parts` and `content.content` are available, a non-empty `content.parts` collection wins and repeated values are deduplicated. Ordinary user and assistant text must preserve literal escape sequences. Decoding is reserved for structured tool payloads and explicit tool line markers.

Unsupported content and non-image attachments must leave visible omission markers. Mapping drops, duplicate messages, hidden-by-ChatGPT messages, and image budget omissions must be represented in export diagnostics rather than silently disappearing.

ChatGPT images are best-effort. The resolver accepts only approved same-origin Estuary content URLs as final image bytes and uses same-origin file-download routes for metadata lookup. v0.12 removes the automatic size and count budgets: the image chooser is the control, so it must always show each image's size, a select-all toggle, and a running total for the current selection. A caller may still pass a finite `limits` object to `resolveConversationImages`, and the budget markers must keep working when one is supplied. v0.8 supports include-all, exclude-all, and individual image selection; excluded images must never trigger image authentication or asset requests. Failed, expired, oversized, unsupported, or budget-limited images must produce explicit fallback markers. A 429 on either the metadata probe or the byte fetch is retried once, honouring `Retry-After` within a 1-15 second clamp; a second 429 is a real failure and must not retry again. v0.7 expands detection for nested image records, execution-output images, alternate pointers, file-download metadata, and already-embedded data URLs. v0.11 adds bounded discovery of image-specific model identifiers; it must preserve only an exact safe field and use `unknown / not found` when absent. It must never infer the image model from the assistant model or image appearance. Claude v0.6 is text-only: thinking, tool, file, and attachment blocks receive explicit omission markers and are not embedded.

The exported file must work offline. Keep its restrictive CSP, inline-only rendering resources, `img-src data:`, and no third-party network dependency. Never embed tokens, cookies, signed URLs, or conversation identifiers unless the user explicitly enables the existing privacy option for supported metadata. Provider and model labels and local counts are safe metadata; raw provider responses are not. Local counts must be labelled as local and must not be presented as provider token/context-window usage. The per-message model indicator is optional, enabled by default, and must show `unknown / not found` when a safe model identifier is unavailable. All-branch export must use local branch controls only; it must not expose provider mutation actions such as edit or regenerate.

## Privacy and security boundaries

The userscript has no analytics, telemetry, project server, remote logging, or third-party API calls. Do not add any of these without an explicit product decision and a new privacy review.

Diagnostics may contain only sanitized route shapes, allowed endpoint paths, status categories, auth-context booleans, organization-context booleans, schema-safe property names, and explicitly safe image-model identifiers when a live discovery test is being performed. Never commit raw HAR files, response bodies, request headers, cookies, bearer tokens, signed URLs, full conversation IDs, image bytes, or user chat content.

The current userscript has no extension ID or web-accessible extension resources. If a future browser extension is created, request only the required ChatGPT/Claude host access, expose no web-accessible resources unless essential, and avoid broad permissions such as `tabs`, `history`, `cookies`, and `webRequest` unless the product explicitly requires them.

## Testing boundaries

Local checks do not log into ChatGPT or Claude.ai and cannot prove that live undocumented endpoints, account permissions, organization cookies, image assets, or mobile layouts still work. They can prove only deterministic handling of the synthetic shapes represented by fixtures. The product owner performs live browser and offline-file testing. Do not claim user acceptance based only on `npm run check`.

For live failures, request only sanitized evidence: browser and version, supported host, redacted route shape, visible error, HTTP status, auth/organization-context booleans, and safe schema/property names. Do not request credentials, headers, cookies, raw response bodies, or full IDs.

## Release and branch process

Create feature branches from the current `main`. Do not push feature work directly to `main`. Run all checks, commit the smallest scoped change, push the branch, open a pull request against `main`, and merge only after review or explicit product-owner approval.

For any version change, synchronize the package manifest, build banner, generated HTML provenance, README, changelog, checklist, tests, `dist/` artifact, and root convenience artifact. Confirm the root and `dist/` files are byte-identical.

## Current next work areas

Remaining ChatGPT image misses should be investigated with sanitized evidence and should not be described as fully solved without live confirmation. v0.8 image choices are now implemented; live acceptance must confirm that include-all, exclude-all, and individual selection behave correctly on desktop and mobile. Safe local statistics are implemented; exact provider token/context-window statistics remain intentionally out of scope. v0.9.0 adds ChatGPT Projects `/g/*` activation and optional all-branch export for edited prompts and regenerated responses; live testing must confirm the route actually exposes a conversation ID in the user’s account. Claude rich-content, attachment, artifact, and image support remain separate follow-up projects.

Do not begin one of these projects automatically. Confirm the product owner’s priority first.
