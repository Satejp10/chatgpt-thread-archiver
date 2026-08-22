# ChatGPT Thread Archiver

This project is **ChatGPT Thread Archiver**, a local browser exporter for the **currently open ChatGPT conversation**. It uses the signed-in ChatGPT page session to request conversation data, normalizes the recognized active message path, and downloads a standalone HTML file. The live ChatGPT DOM is used only for the exporter control and route awareness; it is not used as the source of message text.

## Scope

| Supported now | Deferred until the text path is confirmed |
|---|---|
| One currently open conversation | Bulk/all-chat export |
| User and assistant text messages | Attachments, images, files, citations, canvas, and tool artifacts |
| Active root-to-leaf conversation branch | Exporting every regenerated branch |
| Paragraphs, line breaks, inline emphasis, inline code, fenced code | Full Markdown compatibility |
| Self-contained offline HTML | Browser-extension store packaging |
| Prompt navigation rail, copy buttons, and role counts | Claude support and DOM auto-scroll |
| Explicit omission counts and failure diagnostics | Official ZIP/conversations.json import |

Unsupported non-text blocks are represented with visible omission markers and counted in the exported HTML. The exporter deliberately fails instead of generating a successful-looking partial file when the conversation response cannot be recognized.

## Privacy and security

The exporter runs locally in the browser. It does not ask for a password, upload conversation data, call a third-party service, or persist conversation content. It obtains the current session access token only through the same-origin ChatGPT session endpoint, keeps it in memory for at most 60 seconds, clears it on hidden-tab and observed route-change events, and performs at most one refresh retry after a 401/403 response. Session lookup failures distinguish signed-out, rate-limited, network, timeout, malformed-response, and missing-token cases.

Resource-derived request paths are restricted to the current page origin, an allowlisted conversation path shape, and a maximum of four candidates. Conversation IDs are redacted in diagnostics. The optional conversation-ID metadata field is disabled by default. The status panel is built with DOM nodes and `textContent`; page-side `innerHTML` is not used.

The exported file includes a restrictive Content Security Policy:

> `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'`

The small inline script exists only for offline navigation and copy interactions. It is static, contains no conversation-derived JavaScript, makes no network requests, and reads the already-rendered file DOM only.

## Export controls

Click the floating **Export HTML** button and choose whether to include the conversation URL, title, and conversation-ID metadata. Disabled fields are omitted entirely, not written blank. The title is also used in the filename when enabled; otherwise the filename falls back to a timestamped `chatgpt-export-...` name.

The generated HTML follows the older thread-export archive style: a compact light 820 px layout, GitHub-like metadata, white message cards, lavender user cards, dark code blocks, and teal Copy controls. The renderer uses real paragraphs and line breaks, so it intentionally does not apply `white-space: pre-wrap` to the message content. Each export identifies itself with `chatgpt-thread-archiver 0.3.3` in metadata and the footer.

The generated HTML includes a right-edge prompt rail with one entry per user prompt. The rail supports hover/focus previews, scrollspy, `j`/`k`/`n`/`p` keyboard navigation, Alt-arrow alternatives, a hide toggle persisted in `sessionStorage`, and a plain ordered-link fallback when JavaScript is disabled. Each message also has a local **Copy** button, and the header reports counts by role.

## Run it in a browser

Install the bundled `dist/chatgpt-chats-exporter.user.js` in Tampermonkey or Violentmonkey. Because the 0.3.0 name and namespace changed to `ChatGPT Thread Archiver` and `local.chatgpt-thread-archiver`, delete the old userscript entry manually before reinstalling this build. Save the script, open or refresh a ChatGPT conversation while signed in, and use the floating **Export HTML** button.

The generated file can be opened offline. To verify the offline boundary, open the file with network access disabled or with the browser’s network panel visible and confirm that it remains readable without external assets. The CSP and static script remain unchanged by the visual port.

## Build and local checks

This repository requires Node.js 20 or newer and has no third-party dependencies. From the project directory, run:

```bash
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
```

`npm run build` creates `dist/chatgpt-chats-exporter.user.js`. `npm run check` validates the response adapter, active-branch traversal, escaping, formatting, prompt rail, metadata privacy, recursion limits, route parsing, endpoint construction, filename sanitization, 0.3.0 hardening invariants, and expected failure behavior using local fixtures. These checks do not log into ChatGPT and do not replace the user’s live browser testing.

## User testing

Open `docs/user-test-checklist.md` for the live acceptance pass. Part A should be tested before relying on the new exported-file interactions. The user should test token/session expiry, route changes, short and long conversations, regenerated responses, special characters, unsupported content, prompt navigation, copy buttons, JavaScript-disabled fallback, mobile width, and offline loading.

When reporting a failure, include only sanitized diagnostics: browser/version, ChatGPT host, redacted route shape, test case, visible message, HTTP status, and console error with chat text and credentials removed. Never send cookies, authorization headers, bearer tokens, full conversation IDs, or raw response bodies.

## Project structure

```text
src/core.mjs              Normalization, bounded content parsing, escaping, and HTML rendering
src/chatgpt-client.mjs    Route detection, token lifecycle, same-origin request, and diagnostics
src/exporter-ui.js        In-page controls, privacy options, status panel, and local download
build.mjs                 Dependency-free userscript bundler
fixtures/                 Synthetic conversation response fixtures
test.mjs                  Deterministic local checks
docs/                     Plans, maintenance notes, and user testing checklist
dist/                     Generated userscript
```

## Known limitations

The internal ChatGPT endpoint and session response are undocumented web-app interfaces and may change. Version 0.3.1 restores a bounded `__NEXT_DATA__` text scan because some authenticated/workspace conversation requests require account context. Version 0.3.2 tries the alternate conversation request after an HTTP 400 instead of stopping at the first candidate. Version 0.3.3 decodes escaped tool/resource payloads and renders structured output as readable text or JSON code. GitHub branch/commit/PR delivery is intentionally deferred while GitHub is unavailable; the attached local build is ready for testing. Authentication, rate limiting, workspace permissions, archived chats, project-specific access, or endpoint changes can produce different results. The adapter exports the active branch only. The prompt rail is user-only by design. Rich non-text content is marked rather than interpreted.

For stable account-wide backup, use OpenAI’s supported Data Controls export workflow separately. This project is optimized for a quick, private export of the conversation currently open in the browser.
