# ChatGPT Thread Archiver

This project is **ChatGPT Thread Archiver**, a local browser exporter for the **currently open ChatGPT or Claude.ai conversation**. It uses the signed-in page session to request conversation data, normalizes the recognized active message path, and downloads a standalone HTML file. The provider DOM is used only for the exporter control and route awareness; it is not used as the source of message text.

## Scope

| Supported now | Deferred until the text path is confirmed |
|---|---|
| One currently open conversation on ChatGPT or Claude.ai | Bulk/all-chat export |
| User and assistant text messages on both providers | Full Claude attachment/file, artifact, and tool rendering |
| ChatGPT image asset pointers on a best-effort basis | Complete ChatGPT image coverage and exact usage statistics |
| Active root-to-leaf conversation branch where the provider exposes it | Exporting every regenerated branch |
| Paragraphs, line breaks, inline emphasis, inline code, fenced code | Full Markdown compatibility |
| Self-contained offline HTML | Browser-extension store packaging |
| Prompt navigation rail, copy buttons, role counts, and model labels | Official ZIP/conversations.json import |
| Explicit omission counts and failure diagnostics | Claude image embedding and rich-content fidelity |

Unsupported non-text blocks are represented with visible omission markers and counted in the exported HTML. Recognized image asset pointers are resolved through same-origin ChatGPT file metadata and signed content URLs, then embedded as `data:` URLs so the result remains self-contained offline. Only image MIME types are accepted, each embedded image is capped at 3 MiB, and expired, inaccessible, oversized, or unsupported assets receive an explicit `[image unavailable: ...]` marker rather than being silently omitted. The exporter deliberately fails instead of generating a successful-looking partial file when the conversation response cannot be recognized. Claude exports are intentionally text-first in v0.6: unsupported thinking, tool, file, and attachment content receives a visible omission marker rather than being silently dropped.

## Privacy and security

The exporter runs locally in the browser. It does not ask for a password, upload conversation data, call a third-party service, or persist conversation content. ChatGPT and Claude requests are made only to the provider’s own same-origin web application endpoints using the existing signed-in session. On ChatGPT, the access token remains in memory for at most 60 seconds and has the existing single refresh retry after a 401/403 response. On Claude.ai, the exporter uses the existing session cookie and the organization identifier exposed through the `lastActiveOrg` cookie. Session failures remain user-visible and bounded.

Resource-derived request paths are restricted to the current page origin, an allowlisted conversation path shape, and a maximum of four candidates. Conversation IDs are redacted in diagnostics. The optional conversation-ID metadata field is disabled by default. The status panel is built with DOM nodes and `textContent`; page-side `innerHTML` is not used.

Image resolution is best-effort and occurs only while exporting the currently open conversation. It does not upload data or call third-party hosts: metadata and signed image bytes are requested only from the current ChatGPT page origin. The original asset pointer is not written to the exported HTML; the file contains only the embedded image data or an explanatory fallback marker.

The exported file includes a restrictive Content Security Policy:

> `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'`

The small inline script exists only for offline navigation and copy interactions. It is static, contains no conversation-derived JavaScript, makes no network requests, and reads the already-rendered file DOM only.

## Export controls

Click the floating **Export HTML** button and choose whether to include the conversation URL, title, and conversation-ID metadata. Disabled fields are omitted entirely, not written blank. The title is also used in the filename when enabled; otherwise the filename falls back to a timestamped `chatgpt-export-...` name.

The generated HTML follows the older thread-export archive style: a compact light 820 px layout, GitHub-like metadata, white message cards, lavender user cards, dark code blocks, and teal Copy controls. The renderer uses real paragraphs and line breaks, so it intentionally does not apply `white-space: pre-wrap` to the message content. Each export identifies itself with `chatgpt-thread-archiver 0.6.0` in metadata and the footer. When a provider exposes a model name, the header reports it; when ChatGPT images are present, the header also reports embedded and unavailable image counts.

The generated HTML includes a right-edge prompt rail with one entry per user prompt. The rail supports hover/focus previews, scrollspy, `j`/`k`/`n`/`p` keyboard navigation, Alt-arrow alternatives, a hide toggle persisted in `sessionStorage`, and a plain ordered-link fallback when JavaScript is disabled. Each message also has a local **Copy** button, and the header reports counts by role.

## Run it in a browser

Install the canonical bundled artifact `dist/chatgpt-chats-exporter.user.js` in Tampermonkey or Violentmonkey. The root `chatgpt-chats-exporter.user.js` is kept byte-identical to that generated artifact for repository browsing and direct download convenience. The userscript activates only on ChatGPT `/c/...` and `/s/...` routes or Claude.ai `/chat/...` routes, which avoids injecting controls into unrelated pages. Because the 0.3.0 name and namespace changed to `ChatGPT Thread Archiver` and `local.chatgpt-thread-archiver`, delete the old userscript entry manually before reinstalling this build. ChatGPT image resolution and basic Claude text export are included in the generated bundle. Save the script, open or refresh a supported chat while signed in, and use the floating **Export HTML** button.

The generated file can be opened offline. To verify the offline boundary, open the file with network access disabled or with the browser’s network panel visible and confirm that it remains readable without external assets. On narrow mobile screens, the export button and status panel are lifted above the composer/send area and account for the device safe-area inset. The CSP and static script remain unchanged by the visual port.

## Build and local checks

This repository requires Node.js 20 or newer and has no third-party dependencies. From the project directory, run:

```bash
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
```

`npm run build` creates `dist/chatgpt-chats-exporter.user.js`. `npm run check` validates the response adapters, active-branch traversal, explicit `content.parts` precedence with value deduplication, literal escape preservation for ordinary text, formatting, image normalization and rendering, image per-file and total export budgets, Claude route/request/branch/text handling, prompt rail, metadata privacy, recursion limits, route parsing, endpoint construction, filename sanitization, route-scope, mobile-position, and audit-remediation invariants, and expected failure behavior using local fixtures. These checks do not log into ChatGPT or Claude.ai and do not replace the user’s live browser testing.

For a new maintainer, start with [`docs/developer-handoff.md`](docs/developer-handoff.md), then use [`docs/build-history.md`](docs/build-history.md) for the reproducible build commands, release history, validation record, artifact rules, and branch workflow. [`docs/maintenance-notes.md`](docs/maintenance-notes.md) records the boundaries that should not be changed casually.

## User testing

Open `docs/user-test-checklist.md` for the live acceptance pass. Part A should be tested before relying on the new exported-file interactions. The user should test token/session expiry, route changes, short and long conversations, regenerated responses, special characters, unsupported content, prompt navigation, copy buttons, JavaScript-disabled fallback, mobile width, and offline loading.

When reporting a failure, include only sanitized diagnostics: browser/version, supported host, redacted route shape, test case, visible message, HTTP status, safe auth/organization context, and console error with chat text and credentials removed. Never send cookies, authorization headers, bearer tokens, full conversation IDs, or raw response bodies.

## Project structure

```text
src/core.mjs              Normalization, bounded content parsing, escaping, and HTML rendering
src/chatgpt-client.mjs    ChatGPT route detection, token lifecycle, same-origin request, and diagnostics
src/claude-client.mjs     Claude route detection, same-origin request, text normalization, and diagnostics
src/chatgpt-assets.mjs    ChatGPT same-origin image metadata/content resolution and data-URL embedding
src/exporter-ui.js        In-page controls, privacy options, status panel, and local download
build.mjs                 Dependency-free userscript bundler
fixtures/                 Synthetic conversation response fixtures
test.mjs                  Deterministic local checks
docs/                     Plans, maintenance notes, and user testing checklist
dist/                     Generated userscript
```

## Known limitations

The internal ChatGPT and Claude.ai endpoints and session responses are undocumented web-app interfaces and may change. Version 0.6.0 adds a deliberately small Claude adapter that reads the current `/chat/<id>` conversation through Claude’s organization-scoped endpoint and exports text while marking unsupported content explicitly. Version 0.3.1 restores a bounded `__NEXT_DATA__` text scan because some authenticated/workspace conversation requests require account context. Version 0.3.2 tries the alternate conversation request after an HTTP 400 instead of stopping at the first candidate. Version 0.3.3 decodes escaped tool/resource payloads and renders structured output as readable text or JSON code. Version 0.4.0 resolves supported image asset pointers on a best-effort basis, embeds images up to 3 MiB as data URLs, and marks unavailable assets explicitly. Version 0.4.1 matches the current query-bearing `/backend-api/files/<file>/<conversation>` metadata request before trying older fallback forms, improving recovery for images whose metadata is not returned by the legacy path. Version 0.4.2 scans bounded nested metadata values for approved estuary URLs, so valid URLs are not missed merely because ChatGPT changes the response property nesting. Version 0.5.0 preserves additional structured JSON fields, surfaces non-image attachments and dropped-node coverage, labels hidden-by-ChatGPT messages without redacting them, selects fallback branches chronologically, emits valid ISO timestamps, hardens Windows filename handling, and restores the exporter control after SPA DOM rerenders. Ordinary user and assistant text is not JSON-decoded; decoding is restricted to structured tool payloads and explicit tool line markers. When both `content.parts` and `content.content` collections are present, `content.parts` takes precedence and repeated values are deduplicated. Images remain subject to the 3 MiB per-image limit, a 12 MiB total embedded-image budget, and a 64-image embedded-count limit; budget-limited images receive explicit unavailable markers. Authentication, rate limiting, workspace permissions, archived chats, project-specific access, expired assets, or endpoint changes can produce different results. The adapter exports the active branch only. The prompt rail is user-only by design. Arbitrary files and other rich non-text content remain marked rather than interpreted.

For stable account-wide backup, use each provider’s supported data-export workflow separately. This project is optimized for a quick, private export of the conversation currently open in the browser.
