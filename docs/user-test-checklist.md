# User test checklist

Local fixture checks and bundle syntax validation have been run, but live acceptance must be performed by the user in an authenticated browser. Test the cases below one at a time and compare the result with the expected behavior.

## Part A — client, privacy, and diagnostics

| Test | Steps | Expected result |
|---|---|---|
| Installation | Install `dist/chatgpt-chats-exporter.user.js` in Tampermonkey or Violentmonkey and open a ChatGPT conversation | One floating **Export HTML** button appears; no duplicate buttons appear after refresh |
| Short chat | Export a short text-only conversation | An HTML file downloads with correct title, speaker labels, message order, and readable spacing |
| Token refresh | Keep the page open for more than 60 seconds, then export | The exporter succeeds or shows a clear authentication error; it does not require a page reload solely because the token aged |
| Route change | Navigate from one conversation to another without a full reload, then export | The exporter uses the current conversation and refreshes its session context |
| Logged out | Sign out or use a session that cannot access the conversation | A clear authentication error appears and no HTML file downloads |
| 401/403 retry | If a test environment can reproduce one rejected conversation request, retry through the exporter | Exactly one token refresh/retry occurs, followed by success or a clean failure; no retry loop |
| Redacted status | Trigger a controlled failure and inspect the panel | The panel shows a redacted ID such as `<id:36>`, never the full ID |
| Multiline diagnostic | Trigger a controlled failure that includes multiple diagnostic lines | Page path, parsed ID, auth context, and request details appear on separate readable lines |
| Privacy defaults | Export with default options | URL and title are included; conversation-ID metadata is omitted by default |
| Privacy omissions | Untick URL, title, and conversation-ID metadata, then export | Disabled fields are absent entirely from the file; the title is not present in the filename when disabled |

## Part B — exported HTML features

| Test | Steps | Expected result |
|---|---|---|
| Legacy visual layout | Open the export beside the attached older HTML reference | The new file uses the compact light archive appearance: centered narrow column, compact metadata, white cards, lavender user cards, and teal controls |
| Light appearance | Open the file on a device using a dark OS theme | The archive remains light and its controls/scrollbars do not switch to a mismatched dark scheme |
| Line spacing | Export content with several paragraphs and explicit line breaks | Each line/paragraph has normal spacing; no doubled blank gaps appear |
| Code blocks | Export fenced code with multiple lines | Code preserves its whitespace, remains dark/styled, and scrolls horizontally when needed |
| Provenance | Inspect the HTML head and footer | Generator metadata and footer identify `chatgpt-thread-archiver 0.5.0` |
| Activation scope | Visit a normal chat at `/c/...`, a shared chat at `/s/...`, and an unrelated ChatGPT page such as settings | The control appears only on the `/c/` and `/s/` prefixes and does not inject on unrelated pages |
| Prompt rail | Export a conversation with multiple user prompts | A right-edge rail contains one tick/link per user prompt and links to the correct message |
| Prompt labels | Include a long prompt and a prompt consisting only of a fenced code block | The long label is collapsed with an ellipsis; code-only prompt becomes `Untitled prompt` |
| Tooltip | Hover or focus a rail tick | A readable label appears to the left of the rail and is not clipped |
| Scrollspy | Scroll through the exported file | The visible user prompt is highlighted when `IntersectionObserver` is available |
| Keyboard navigation | Press `j`/`n` and `k`/`p`, then Alt+ArrowUp/Down | Navigation moves between user prompts; typing those keys in an input or editable area is not intercepted |
| Rail toggle | Click **Hide**, reload the exported file, and inspect the rail | Hide state persists in the exported file’s session storage |
| JavaScript disabled | Disable JavaScript before opening the exported file | One plain ordered list of prompt links appears above the transcript; no duplicate navigation list is present |
| Copy button | Click **Copy** on several messages before and after comparing the legacy class structure | The correct message body is copied, and the button briefly reports `Copied` or a clear failure |
| Rail jump alignment | Click a rail tick near the top of a message | The message heading is visible and is not tucked under the viewport edge |
| Role counts | Export a conversation with known user and assistant counts | The header reports total messages and per-role counts accurately |
| Formatting | Include paragraphs, explicit line breaks, bold/italic text, inline code, and fenced code | Formatting is rendered conservatively; code remains intact and horizontally scrollable if needed |
| Special characters | Include `<`, `>`, `&`, quotes, Unicode, right-to-left text, and `<script>alert(1)</script>` | Characters display literally; no markup or script executes in the body, rail, or tooltip |
| Regeneration | Export a chat with a regenerated assistant response | Only the active current branch is exported; alternate branches are not duplicated |
| Image embedding | Export a conversation containing an uploaded or generated image that is still available | The HTML contains a visible image, the header reports it as embedded, and the image remains visible after opening the file offline |
| Image fallback | Export a conversation containing an expired, inaccessible, oversized, or unsupported image asset | The export completes with an explicit `[image unavailable: ...]` marker and the header reports the unavailable count; the asset is not silently omitted |
| Image privacy boundary | Inspect the exported HTML and Network panel during image export | No third-party requests occur; signed URLs, asset pointers, tokens, and cookies are absent from the exported HTML and diagnostics |
| Unsupported content | Export a conversation containing a file, citation, canvas, or other non-image tool artifact | Text exports, an omission marker is visible, and the omission count is reported |
| Structured JSON preservation | Include a tool-like or pasted JSON object with a readable field plus additional fields | The readable field is formatted as text and the additional fields remain visible in a JSON block |
| Literal escape preservation | Include ordinary user text containing literal `\\n`, `\\t`, `\\uXXXX`, Windows paths, or regexes | The literal backslash sequences remain unchanged; only explicitly encoded tool payloads are decoded |
| Content precedence | Use a response containing both `content.parts` and `content.content` | Non-empty `content.parts` wins and repeated part values are not emitted twice |
| Image/export budget | Export more than 12 MiB of available images or more than 64 image blocks | The export completes, budget-limited images show explicit unavailable diagnostics, and the header/status reports the budget-limited count |
| Coverage warning | Export a conversation with a malformed/dropped mapping node or duplicate message ID | The header reports the dropped or duplicate count instead of silently presenting an apparently complete archive |
| Hidden-message label | Export a conversation containing a message marked hidden by ChatGPT | The content remains present, the message is visibly labeled as hidden by ChatGPT, and the header reports the count |
| Mobile width | Open the exported file below 700 px viewport width | The rail is hidden and the transcript uses the full available width |
| Mobile export control | Open a live `/c/...` chat on Edge Android or another mobile browser extension runner | The Export HTML button and status panel sit above the composer/send area and do not block the send control |
| Offline output | Open the downloaded HTML with network access disabled or DevTools Network visible | The file remains readable, embedded images remain visible, and it issues zero network requests |

## Failure report template

When reporting a failure, provide the following information without sharing private chat contents, cookies, authorization headers, access tokens, or full IDs:

```text
Browser and version:
Operating system:
ChatGPT host: chatgpt.com or chat.openai.com
Conversation URL shape: /c/<redacted-id> or other
Test case:
Visible exporter message:
HTTP status, if shown:
Auth context line, if shown: token=yes/no, device=yes/no, account=yes/no
Tried paths, redacted:
Page request hints, redacted:
Did a file download? yes/no
If yes, was it complete, partial, or malformed?
```

The browser console may contain diagnostic information, but do not copy request headers, cookies, bearer tokens, full conversation IDs, or the conversation response body. A redacted error code and message are sufficient for implementation updates.
