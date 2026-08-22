# Build plan: ChatGPT Chats Exporter — Text-to-HTML MVP

## Goal

Turn the attached specification into a working local browser script for exporting **one currently open ChatGPT conversation** to a self-contained HTML file containing formatted text blocks. The first release will focus on complete text extraction and safe offline rendering. The user will perform all live browser testing; implementation, updates, diagnostics, and documentation are my responsibility.

## What I found in the attachment

The attachment is a written MVP specification rather than an existing source-code project. It recommends avoiding the rendered DOM as the primary source and instead using the authenticated ChatGPT page session to request the conversation’s structured data, normalize the message tree, and render the result locally. I will use that specification as the project baseline and create the initial source layout around it.

## Architecture decision

The first implementation will be a **single-page userscript/browser script** that runs on `chatgpt.com` while the user is already signed in and has a conversation open. It will not ask for credentials, copy session tokens, upload data, or use a remote backend.

The script will derive the conversation ID from the current route, call the current ChatGPT conversation-data request with same-origin credentials, normalize the returned message tree, and download a locally generated HTML document. The visible DOM will be used only for lightweight UI placement and route awareness, never as the authoritative message source.

The script will include a small in-page exporter control so the user does not need to paste a large script for every export. A direct-run mode will also remain available for recovery and debugging. The UI will be defensive because ChatGPT’s internal selectors and request paths are undocumented and can change.

## Planned project structure

```text
ChatGPTChatsExporter—Text-to-HTMLMVP/
├── README.md
├── src/
│   ├── exporter.user.js          # userscript entry point and in-page control
│   ├── chatgpt-client.js         # route detection and same-origin request
│   ├── conversation-adapter.js   # response validation and message-tree traversal
│   ├── text-extractor.js         # text-only block extraction
│   ├── html-renderer.js          # escaped, self-contained HTML generation
│   ├── download.js               # Blob download and safe filename handling
│   └── diagnostics.js            # visible errors, counts, and debug details
├── fixtures/
│   ├── simple-conversation.json
│   ├── long-conversation.json
│   └── branching-conversation.json
└── docs/
    └── user-test-checklist.md
```

If the attached location cannot be treated as a writable directory during implementation, I will preserve the original specification and create this source layout in a sibling project directory with an explicit README explaining the location.

## Step-by-step implementation

### Step 1 — Establish the runnable entry point

Create the userscript metadata and a small bootstrap that can run on ChatGPT conversation pages. It will detect whether it is on `chatgpt.com`, identify the current conversation route, and install a nonintrusive **Export HTML** control. The control will be idempotent so route changes or React re-renders do not create duplicates.

The bootstrap will expose a guarded debug entry point for the user, such as an export function on a namespaced global object, without exposing cookies, tokens, or raw payloads unnecessarily.

### Step 2 — Implement route and request handling

Implement a route detector for the current conversation URL format and an endpoint builder for the conversation payload. The request layer will use `fetch` with same-origin credentials and an explicit timeout. It will validate HTTP status, content type, and JSON parsing before handing data to the adapter.

Because the endpoint is an undocumented internal web-app interface, the code will isolate the path and request logic in one module. Error messages will distinguish missing conversation ID, unauthenticated session, not-found response, rate limiting, server failure, and unexpected response format.

The request layer will not use DOM message selectors and will not attempt to reconstruct a conversation by scrolling.

### Step 3 — Normalize the response safely

Create a neutral internal model:

```text
Conversation
├── title
├── conversationId
├── sourceShape
└── messages[]
    ├── id
    ├── role
    ├── authorLabel
    ├── createdAt
    ├── parentId
    └── textBlocks[]
```

The adapter will support the message mapping/tree shape described in the attachment and keep the parser versioned and isolated. It will identify the active root-to-leaf path, preserve message order, prevent duplicate nodes, and avoid exporting alternate regenerated branches unless they are part of the selected path.

The adapter will perform completeness checks before rendering. If it cannot find a valid message path or encounters a response shape it does not understand, it will stop with a visible diagnostic rather than produce a partial-looking export.

### Step 4 — Extract text blocks

Support the text representations most likely to appear in the current payload, including plain text parts, paragraph arrays, and common content-part arrays. Preserve paragraph boundaries, explicit line breaks, fenced code as code blocks, and empty-message behavior.

Non-text content will not be interpreted in the first milestone. Where the payload contains an unsupported block, the output will include an explicit, styled omission marker and the diagnostics area will report the count. This makes later attachment/image support additive instead of silently lossy.

### Step 5 — Render safe, formatted HTML

Generate a complete offline document with embedded CSS and no external dependencies. Each message will have a semantic article-like block with a visible speaker label, optional timestamp, and stable message order. User and assistant blocks will use neutral styling independent of ChatGPT’s proprietary CSS classes.

All message text will be HTML-escaped before insertion. Formatting will be conservative: paragraphs, line breaks, inline emphasis where safely recognized, links only when explicitly supported, and fenced code blocks. Any Markdown-to-HTML conversion will run through an allowlist sanitizer or be deferred until the plain-text path is verified.

The HTML will include export metadata, title, conversation ID when available, export time, message count, and omitted-block count. It will remain readable when opened from a local file with networking disabled.

### Step 6 — Implement local download and progress feedback

Create a Blob download with a sanitized filename based on the conversation title. Revoke temporary object URLs after download. The in-page control will provide clear states: idle, loading, normalizing, rendering, downloaded, and failed.

The control will show a concise result summary, including exported message count and omitted content count. Debug details will be available through a collapsible panel or console-safe diagnostic object, but raw conversation content will not be logged by default.

### Step 7 — Add fixture-driven checks and user-facing diagnostics

Add local JSON fixtures for a simple conversation, a long conversation with many messages, and a branching conversation. These fixtures will exercise the adapter and renderer without requiring real user data. I will implement deterministic self-check functions and document how the user can run them if desired, but I will not claim live browser testing or acceptance testing on the user’s behalf.

The script will include explicit checks for:

| Condition | Required behavior |
|---|---|
| No conversation route | Explain that a chat must be opened first |
| Expired or missing login | Explain that the user must sign in and retry |
| HTTP 404/403/429/5xx | Show a specific actionable error and no download |
| Unexpected JSON shape | Show a schema-change diagnostic and no partial export |
| Unsupported content blocks | Export text and visibly count omissions |
| Empty conversation | Produce a valid HTML document with an empty-state note |
| Duplicate route initialization | Keep one exporter control only |

## User testing handoff

After implementation, I will provide the exact installation or launch instructions, a short manual test checklist, expected results, and the diagnostic information to send back if a test fails. The user will test against their own authenticated ChatGPT account and representative conversations. Updates will be made from the user’s reported results, browser console errors, HTTP status, and sanitized response-shape diagnostics.

The user’s testing checklist will include a short chat, a long off-screen chat, multiline prompts, Markdown and code, special characters, regenerated assistant replies, a non-text block, refresh/route changes, expired-session behavior, and opening the downloaded file offline.

## Acceptance criteria for the first release

The MVP will be considered ready for user testing when it can be installed or run locally, exports the current conversation through the structured data path, preserves the complete selected text message path, creates a valid standalone HTML file, escapes untrusted text safely, reports omissions, and fails without producing a misleading file when the data source is unavailable or unrecognized.

Live acceptance remains with the user as requested. I will not mark the MVP as fully validated until the user reports results from the provided checklist.

## Deferred work

Bulk chat listing and export, official ZIP ingestion, alternate-branch archives, richer Markdown, attachments, images, citations, canvas/tool content, timestamps beyond what is already available, search/filtering, browser-extension packaging, and automatic update delivery will be handled only after the single-chat text path is confirmed by the user.

## Assumptions and risks

The user wants a local personal exporter for conversations they are already authorized to view. ChatGPT’s internal endpoints, route formats, and response schemas are undocumented and can change without notice, so the request layer and adapter will be versioned and isolated for maintenance. A same-origin browser script is the best initial balance between completeness, privacy, and setup effort, but it is not equivalent to a public stable API.

The official account-level export remains a fallback for stability and bulk archival, while the MVP optimizes for one-click export of the currently open conversation.[1]

## Reference

[1]: https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data "OpenAI Help: Exporting your ChatGPT history and data"
