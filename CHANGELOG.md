# Changelog

All notable changes to **ChatGPT Thread Archiver** are documented here. Exported conversation content is not redacted by these changes; privacy-related entries describe diagnostics, metadata controls, and request handling only.

## [0.4.1] — 2026-08-22

### Fixed

The image resolver now tries the current query-bearing `/backend-api/files/<file>/<conversation>` metadata request, including `download_intent=download`, `include_library_file_state=true`, and `inline=false`, before older fallback forms. The previous 0.4.0 build could report `asset metadata did not contain a same-origin estuary download URL` for valid image assets when the legacy metadata path returned an incomplete response.

The existing same-origin restriction, image-only MIME allowlist, 3 MiB limit, explicit unavailable markers, deduplication, and offline `data:` embedding behavior are unchanged.

## [0.4.0] — 2026-08-22

### Added

Image asset pointers in conversation message parts are now recognized and rendered as image blocks. The exporter resolves supported images through the authenticated same-origin ChatGPT file metadata and signed content endpoints, embeds successful responses as `data:` URLs, and keeps the offline HTML self-contained.

Image resolution is deduplicated by asset pointer and limited to image MIME types with a 3 MiB per-image byte cap. Expired, inaccessible, oversized, malformed, or unsupported assets are represented by explicit `[image unavailable: ...]` markers and summarized in the HTML header; they are not silently omitted. Asset pointers and signed URLs are not written to the export.

### Privacy and reliability

The image path makes no third-party requests and does not add telemetry, persistence, or credential output. The resolver uses the existing in-memory authentication context and the existing request timeout/allowlisting model. The live browser acceptance pass remains user-owned because image availability depends on the signed-in ChatGPT session and asset lifetime.

## [0.3.3] — 2026-08-22

### Fixed

Tool and resource turns now decode escaped JSON strings and literal newline sequences before rendering. Line markers such as `[L1]` are removed from display text. Structured payloads with a readable `content`, `text`, `output`, `result`, or `message` field render as text; other structured payloads render as indented JSON code blocks.

This repair targets tool/resource output only and preserves ordinary Markdown, fenced-code formatting, exported conversation text, citation data, and the existing offline HTML/CSP pipeline.

## [0.3.2] — 2026-08-22

### Fixed

HTTP 400 responses from the first conversation candidate no longer terminate the export immediately. The client now tries the bounded alternate conversation path before reporting failure. This is intended to handle current ChatGPT deployments where the direct path and its query variant are not interchangeable.

The repair preserves the authenticated same-origin request model, account/workspace discovery, response-hint redaction, endpoint allowlisting, and HTML export behavior.

## [0.3.1] — 2026-08-22

### Fixed

Restored a bounded direct `__NEXT_DATA__` text scan for account/workspace context. The previous 0.3.0 change removed that source entirely; the resulting `account=no` context could cause authenticated conversation requests to return HTTP 400 for accounts or conversations requiring workspace context. The scan is limited to the first 256 KB of text and does not serialize the page object.

Added a sanitized response hint for HTTP 400-level JSON errors so the next diagnostic identifies a safe error code/message without exposing response bodies, tokens, or conversation text.

The request fix preserves the existing same-origin endpoint allowlist, token/device headers, privacy controls, diagnostic ID redaction, exported chat content, and offline HTML behavior.

## [0.3.0] — 2026-08-17

### Changed

The userscript identity is now **ChatGPT Thread Archiver** with namespace `local.chatgpt-thread-archiver`. Generated HTML identifies itself as `chatgpt-thread-archiver 0.3.0`.

The in-page preference key was renamed with a one-time migration from `chatgpt-chats-exporter-prefs`. Migration validates the stored boolean preferences, verifies the new write, and removes the old key only after successful verification. If migration cannot complete cleanly, the old key remains active so privacy choices are not silently reset.

The exported prompt-rail session key was renamed to `chatgpt-thread-archiver-rail-hidden`.

Session-token failures now distinguish signed-out sessions, HTTP/rate-limit failures, network failures, timeouts, malformed responses, and missing tokens. The existing 60-second token lifetime and single 401/403 refresh retry are unchanged.

The client no longer monkeypatches `history.pushState` or `history.replaceState`. It retains `popstate` and visibility invalidation and uses exporter-controlled location comparison.

The unnecessary `__NEXT_DATA__` account scan was removed. Remaining page-state scans use a bounded JSON replacer, while existing string bounds and conflicting-account suppression remain in place.

The dead cached-token `!== 'dummy'` read condition was removed; the setter’s dummy-token guard remains.

The non-JavaScript rail width was corrected from 900 px to 820 px. JavaScript rail behavior and its fixed-layout rules were left unchanged.

### Privacy and diagnostics

Conversation content, including names and email addresses present in the chat, is exported unchanged. A separate diagnostic fix now redacts conversation IDs in the on-page error panel and browser console. Diagnostic output uses values such as `<id:36>` and does not alter the exported HTML transcript.

## [0.2.0] — 2026-08-16

### Added

Added the legacy-style light archive presentation for exported HTML, including compact message cards, lavender user cards, dark code blocks, teal Copy buttons, compact metadata, generator provenance, stable message anchors, and the prompt navigation rail.

Added prompt-rail scrollspy, hover/focus labels, keyboard navigation, hide-state persistence, no-JavaScript ordered-link fallback, per-role counts, local Copy controls, and privacy options for source URL, title, and conversation-ID metadata.

### Security and reliability

Added short-lived in-memory access-token handling, one-time authentication refresh after 401/403 responses, same-origin endpoint allowlisting, redacted request diagnostics, bounded nested-content parsing, filename control stripping, and DOM-node-based status rendering without page-side `innerHTML`.

## [0.1.0] — Initial MVP

### Added

Added a local browser userscript that retrieves the currently open ChatGPT conversation through the authenticated same-origin request, normalizes the active conversation branch, and exports a self-contained text-oriented HTML file.

Added local fixtures and deterministic checks for message normalization, branch selection, text/code formatting, HTML escaping, route detection, endpoint construction, filename sanitization, and explicit omission handling for unsupported non-text blocks.
