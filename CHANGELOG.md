# Changelog

All notable changes to **ChatGPT Thread Archiver** are documented here. Exported conversation content is not redacted by these changes; privacy-related entries describe diagnostics, metadata controls, and request handling only.

## [0.10.0] — candidate

### Added

Added experimental message-level branch controls for optional all-branch exports. Each fork point now receives its own local previous/next arrows and a position counter, so edited prompts and regenerated responses can be navigated independently, including nested combinations.

The renderer preserves the current-branch default, keeps the export self-contained and offline, and retains a readable no-JavaScript fallback. The branch tree is built from the provider response already retrieved for the open conversation; no additional history scan or third-party request is introduced.

Live testing remains required for ChatGPT edited prompts, regenerated responses, nested forks, and Claude.ai branch shapes because provider tree formats are undocumented.

## [0.9.1] — 2026-08-26

### Fixed

Fixed a syntax error in the exported offline interaction script that prevented Dark mode, Copy, branch navigation, and prompt-rail controls from initializing. Added regression coverage that compiles the generated inline script before release.

## [0.9.0] — candidate

### Added

Added ChatGPT Projects-route activation for `https://chatgpt.com/g/*` and retained the existing `/c/*` and `/s/*` routes. The runtime route guard and userscript metadata now agree on the expanded scope.

Added optional branch-aware export for ChatGPT and Claude.ai conversation trees. Current-branch export remains the default; users can choose to include edited prompts and regenerated responses when the provider response exposes those alternate paths. The offline HTML provides local branch navigation, branch counts, and a JavaScript-disabled readable fallback.

### Privacy and reliability

Branch alternatives are exported only from the provider response already requested for the open conversation. No additional provider history scan, telemetry, or third-party request is introduced. Malformed alternate paths are skipped without preventing the valid active branch from exporting, and all-branch exports may be larger because shared prompts are repeated for each path.

Live testing remains required for ChatGPT Project conversations and both providers’ edited/regenerated branch shapes because their internal response formats are undocumented and may change.

## [0.8.1] — 2026-08-22

### Added

Added an optional per-message model indicator to exported assistant messages. The option is enabled by default and can be turned off in the export dialog. When a message has a safe model identifier, the export shows it beside the assistant label; when no usable identifier is present, it shows `Model: unknown / not found` instead of guessing.

The preference applies to the current and future exports, while the export remains local-only and continues to avoid provider token, billing, telemetry, or credential data.

## [0.8.0] — 2026-08-22

### Added

Added ChatGPT image controls in the export dialog. Users can include all images, exclude all images, or choose individual images after the conversation is loaded. Excluded images are never downloaded and appear in the offline HTML as explicit `[image excluded by export settings]` markers. The header reports embedded, excluded, and unavailable image counts.

The individual-image chooser uses message number, speaker, image type, and known size rather than thumbnails. This avoids downloading images merely to display a selection preview and keeps the first version small and privacy-conscious. The choice is made per export; only the broad image mode is remembered for convenience.

### Privacy and reliability

The no-images path skips image authentication and asset requests entirely after the conversation data is loaded. The selected-images path requests only the chosen assets and keeps the existing same-origin allowlist, MIME checks, per-image limit, total embedded-image budget, and maximum embedded-image count.

Local regression coverage includes exclude-all, choose-individually, explicit exclusion markers, no-download behavior for excluded images, and image-count reporting. Live mobile and desktop acceptance remains required because the browser dialog and provider response shapes can vary.

## [0.7.0] — 2026-08-22

### Added

Expanded ChatGPT image recognition to cover nested image records, execution-output image messages, alternate pointer fields, file-download responses, and already-embedded same-origin `data:` images. The resolver now tries the canonical file-download route before older metadata forms, while final image bytes still require an approved same-origin Estuary content URL. Existing MIME, size, total-budget, and offline-embedding safeguards remain in place.

Added safe local export statistics for both ChatGPT and Claude.ai. The HTML header and completion status now report message and role counts, text-block count, word count, character count, and model identifiers when available. These values are derived only from the text included in the local export.

### Privacy and reliability

The statistics feature does not request token counts, context-window state, billing information, or provider telemetry. It does not claim that local word or character counts are equivalent to provider token usage. Image pointers and signed URLs remain excluded from exported HTML and diagnostics; only embedded image data or explicit fallback markers are written.

Local regression coverage now includes multiple ChatGPT image shapes, execution-output images, canonical file-download metadata resolution, data-URL embedding, model summaries, and the statistics disclaimer. Live image acceptance remains required because ChatGPT’s internal response formats and asset permissions can vary by account and conversation.

## [0.6.0] — 2026-08-22

### Added

Added first-pass Claude.ai support for the currently open `/chat/<conversation-id>` route. The exporter reads Claude’s organization-scoped same-origin conversation response, follows the current message branch when the API provides a valid leaf, exports text and timestamps into the existing offline HTML format, and shows the detected conversation-level model when available.

Claude’s v0.6 text path intentionally marks thinking, tool, file, and attachment content with visible omission markers rather than attempting rich-content or image handling. This keeps the first provider integration small, honest, and privacy-preserving while leaving room for a later Claude-specific richness pass.

### Privacy and reliability

Claude requests use the existing signed-in session cookie and the `lastActiveOrg` organization cookie. No credentials, cookies, signed URLs, raw conversation responses, or full IDs are written to diagnostics or exported HTML by default. The userscript remains local-only and makes no project-server or third-party conversation requests.

Local fixtures and regression checks cover Claude route parsing, organization-scoped endpoint construction, authenticated request behavior, current-branch selection, model display, text formatting, unsupported-content markers, and conversation-ID privacy. Live Claude browser acceptance remains required because the endpoint is undocumented and session-dependent.

## [0.5.1] — 2026-08-22

### Fixed

The userscript now activates only on `chatgpt.com/c/*` normal-chat and `chatgpt.com/s/*` shared-chat paths, both in the userscript metadata and runtime injection guard. The root userscript remains synchronized with the canonical `dist/` artifact.

On narrow screens, the floating export control and status panel are lifted above the ChatGPT composer/send area and account for the device safe-area inset. Route-scope and mobile-position regression checks were added.

## [0.5.0] — 2026-08-22

### Fixed

Structured JSON payloads with a readable `content`, `text`, `output`, `result`, or `message` field now retain all additional fields in a JSON code block instead of silently discarding them. Tool line markers are now parsed with the intended whitespace expression. Ordinary user and assistant text is no longer JSON-decoded; decoding is restricted to structured tool payloads and explicit tool line markers, preserving literal backslash sequences in normal text.

When both `content.parts` and `content.content` are present, the non-empty `content.parts` collection takes precedence and repeated values are deduplicated. Non-image attachments now produce explicit omission markers and are included in omission counts. Mapping normalization now surfaces dropped and duplicate nodes in the exported header, chooses fallback leaves by actual childlessness and chronology, and labels messages marked `is_visually_hidden_from_conversation` while retaining their content unchanged.

Generated `<time>` elements now use valid ISO 8601 `datetime` values. Filename sanitization protects Windows device names. The exporter control is reinstalled after SPA DOM rerenders, and image data-URL conversion uses smaller chunks. Image embedding retains the 3 MiB per-image limit and adds 12 MiB total and 64-image export budgets, with explicit budget diagnostics. Image byte usage is shown in the export header. The root userscript is synchronized with the canonical `dist/` artifact.

### Privacy

This release does not redact exported conversation text. Hidden-by-ChatGPT messages remain included but are visibly labeled and counted so users can decide whether to share the file. The bearer-token lifecycle remains unchanged pending a separate compatibility/security review because workspace/account headers may still be required by the current ChatGPT request path.

## [0.4.2] — 2026-08-22

### Fixed

The image metadata parser now scans bounded nested response values for approved `/backend-api/estuary/content` URLs, instead of depending only on a small set of top-level property names. This addresses valid image metadata whose download URL is nested differently across image types or ChatGPT response variants.

The parser remains restricted to the current page origin and the estuary content path. It does not follow arbitrary URLs, expand the 3 MiB limit, or expose signed URLs in exports or diagnostics.

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
