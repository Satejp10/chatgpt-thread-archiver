# Maintenance notes

## Client boundaries

`src/chatgpt-client.mjs` owns ChatGPT route parsing for `/c/`, `/s/`, and `/g/`, same-origin session access, token caching, token invalidation, candidate construction, endpoint allowlisting, account/workspace header discovery, and redacted diagnostics. `src/claude-client.mjs` separately owns Claude route parsing, `lastActiveOrg` organization discovery, the organization-scoped conversation request, branch selection, text normalization, and redacted errors. Keep provider request logic isolated from normalization and rendering because both providers’ internal web-app request paths and response shapes are undocumented and may change independently.

The access-token cache is intentionally short-lived: 60 seconds in memory only. A 401/403 causes one cache clear, one session refresh, and one retry. Do not add unbounded retry loops or persist the token. Visibility and observed route transitions clear the cache; the build does not monkeypatch history APIs. Session lookup failures remain distinct and user-visible.

Resource hints are evidence only. They must remain same-origin, match the allowlisted conversation path shape, and be capped before request construction. Claude organization and conversation values must be validated before URL construction. Diagnostics should remain path-only and redacted; never log headers, cookies, response bodies, or full conversation IDs.

## Renderer boundaries

`src/core.mjs` owns normalization, bounded recursive content parsing, escaping, privacy-gated metadata, offline HTML generation, and the prompt rail. The rail’s inline behavior is a static string constant. Conversation text must never be interpolated into the exported script. `src/export-stats.mjs` owns local word, character, text-block, role, and model counts and must remain independent of provider token or billing APIs. The optional per-message model indicator is enabled by default, can be disabled in export preferences, appears only on assistant messages, and shows `Model: unknown / not found` when no safe model identifier is available.

The generated HTML includes a restrictive CSP because Part B adds an inline script. If future features require external assets, they must be treated as a deliberate threat-model change rather than silently added to the document. Local statistics must carry an explicit disclaimer that they count exported text only and are not provider token/context-window measurements.

The API exporter’s absolute `create_time` timestamp handling is intentional. Do not port the previous DOM exporter’s relative-label timestamp logic into this project.

## Feature invariants

The prompt rail is user-only, uses stable file-local message IDs, and has a no-JavaScript ordered-list fallback. Keep the rail list single-sourced; avoid emitting a second copy solely for the fixed layout. The copy button reads rendered message DOM from the offline file and never reaches back to ChatGPT. ChatGPT image shapes are normalized before rendering, including normal asset pointers, nested image records, execution-output images, alternate URL/file-pointer fields, and already-embedded data URLs. Include-all, exclude-all, and choose-individually modes must produce explicit image counts and exclusion markers; excluded images must not trigger asset requests. Branch normalization may retain every valid leaf path, but current-branch export remains the default; all-branch export must use local-only branch navigation and must not expose edit/regenerate actions.

Privacy preferences store URL/title/conversation-ID booleans, the broad ChatGPT image mode, and the branch mode under `chatgpt-thread-archiver-prefs`. The old `chatgpt-chats-exporter-prefs` key is migrated once when it contains valid preferences; if migration cannot complete cleanly, the old key remains active. Disabled URL, title, and conversation-ID fields must be omitted entirely. The conversation ID is disabled by default. Individual image selections are per-export only and must never be persisted.

## Validation debt

The local fixtures can validate deterministic parsing and rendering but cannot prove that ChatGPT’s or Claude.ai’s current session endpoint, auth/organization context, asset permissions, or response schema remain valid. Live browser acceptance is the user’s responsibility. When either live site changes, request a sanitized failure report containing only status, redacted paths, auth/organization-context booleans, and schema-safe diagnostics.

The MVP intentionally isolates likely change points. If ChatGPT changes its URL structure, update `getConversationIdFromUrl()` in `src/chatgpt-client.mjs`; `/g/*` must continue to fail safely when the route segment is not itself a conversation ID. If its request path or required request behavior changes, update `endpointCandidates()` and `fetchConversation()` there. If Claude changes its URL structure, organization cookie, request path, or response shape, update only `src/claude-client.mjs`. If provider response fields or message-tree representation changes, add a synthetic fixture before changing the renderer.

The HTML renderer should remain independent of ChatGPT’s CSS classes and DOM structure. Avoid replacing the structured-data path with viewport scraping merely because a selector is convenient. If a fallback is ever introduced, it must report that it is a DOM fallback and must not claim complete export unless it can verify completeness.

For new content types, add a normalized text-block variant and a fixture first. The renderer must either render that variant safely or show an explicit omission marker. Never insert raw conversation text into page-side `innerHTML` or unescaped generated markup.

The bundled userscript is generated by `build.mjs`; update source modules and run `npm run build` rather than editing the generated file directly. Run `npm run check` after every adapter, image, statistics, or renderer change.
