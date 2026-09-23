# Project log — ChatGPT Thread Archiver

Append-only. Newest entry at the bottom. One entry per working session.

**Never edit or delete an existing entry.** If an entry turns out to be wrong,
append a new `### Correction` entry that names the date it corrects and states
what is actually true. The wrong entry stays, so the record shows what was
believed at the time.

Never put secrets, tokens, cookies, signed URLs, full conversation IDs, or
conversation text in this file. It is quoted into status reports that get
pasted into chat windows.

Entry format:

```
## YYYY-MM-DD — <short session title>
**Did:** what actually happened.
**Decided:** decision — reason. Rejected: alternative.
**Learned:** anything that changes future work, including dead ends.
**Open:** what was left unresolved.
```

---

## 2026-09-09 — v0.12.0, image-model finding, branch cleanup, first status report

**Did:** Ran a sanitized live diagnostic to settle whether ChatGPT exposes a
per-image model identifier. Shipped v0.12.0 (PR #21): removed the automatic
image budget, added a tri-state `Select all` toggle and a live size readout to
the image chooser, and added retry-once-on-429 honouring `Retry-After`. Audited
all 12 non-`main` remote branches, wrote `docs/branch-cleanup.md` (PR #22), and
pruned 10 of them. Generated report SR-chatgpt-thread-archiver-001 and created
this log.

**Decided:** Remove the 3 MiB / 12 MiB / 64-image caps outright — they were ours,
not ChatGPT's, and were silently discarding images the user had explicitly
selected. Rejected: raising the caps, which is the same failure later.

**Decided:** Retry once on 429 rather than adding a blanket delay every few
images. Image resolution is already sequential, so there is no burst to throttle;
a 5 s blanket delay would have added ~65 s to a 52-image export for nothing.
Rejected: the blanket delay the owner offered.

**Decided:** Leave the `Image model:` caption untouched despite it now being
provably dead, because the handoff forbids redesigning a feature without asking
first. Rejected: removing it unilaterally in v0.12.0.

**Learned:** ChatGPT exposes no per-image model identifier. Across 10 image
parts, `metadata.dalle` and `metadata.generation` appear on every generated image
and on no user upload, but neither carries a model field; `serialization_title`
is a fixed label, not an identifier. `model_slug` / `resolved_model_slug` hold
the *assistant* model for the turn and must not be substituted. Tested on a
free-tier account only.

**Learned:** The image-model investigation surfaced a worse bug than the one it
was chasing — a 15 MB export had silently dropped 3 of 9 generated images behind
a budget marker.

**Open:** What to do with the permanently-empty `Image model:` caption (hide the
line, or remove the feature), and the deletion of `diagnostics/` that depends on
it. Live acceptance testing of v0.12.0 by the product owner. Stale "candidate"
labels for v0.12.0 in `CHANGELOG.md` and its version record.

---

## 2026-09-18

**Did:** Shipped v0.13.0 (candidate): Claude exports now include every branch by
default, so an edited prompt or regenerated reply can no longer be lost. Added
`fixtures/claude-stale-leaf.json`, a one-time preference migration, and a
neutral "not exported" line replacing the yellow `dropped nodes` warning for
branches withheld by choice. Marked v0.12.0 released (`10c50a0`, PR #21) in its
version record and `CHANGELOG.md`, clearing two of the three stale labels noted
on 2026-09-09.

**Decided:** Export all branches by default rather than trying to detect the
on-screen branch. Rejected: reading Claude's DOM or browser storage (undocumented,
breaks on every redesign); ranking leaves by `created_at` (fixes the stale-pointer
case, breaks the deliberate branch-switch case). Owner chose "capture everything"
over "keep one branch, warn loudly".

**Learned:** The exporter picked the Claude branch solely from
`current_leaf_message_uuid`, the server's persisted current-branch pointer. That
pointer can lag the web UI just after an edit or regenerate, so an export taken
in that window walks to a leaf one step behind the screen; a page reload resyncs
it, which is why the failure was intermittent. Confirmed against a live export
whose header read `Branches: 1 of 3 exported` / `3 dropped nodes` — the data was
fetched and then discarded, not missing.

**Learned:** Claude's conversation-level `droppedNodeCount` counted every message
not on the exported path, so ordinary alternate branches surfaced as a data-loss
warning. On Claude every node is a real message; there is no structural drop.

**Learned:** `npm run build` writes only `dist/`. The byte-identical root copy is
maintained by hand (`cp`), so a release that forgets it leaves the two artifacts
out of sync.

**Did (later, same day):** v0.13.1 after the owner's live test of v0.13.0 —
`renderBranchTree` only built fork controls below a parent message, so an edited
*opening* prompt rendered as consecutive turns instead of one switcher. Factored
the fork markup into a `renderFork` helper used for both a message's children and
the root list.

**Learned:** ChatGPT's "Branch to a new chat" (Sept 2025) creates a separate
conversation with its own ID, not a branch inside the tree. The `mapping` /
`parent` / `current_node` shape this exporter reads is unchanged, so it needs no
support work. Established from third-party reporting, not a live response.

**Learned:** Brightdata MCP needed re-authentication and could not be used this
session; fell back to normal web search per the owner's stated preference.

**Did (v0.13.2):** Two reading-order corrections from the owner's live test. Each
version switcher now renders above the alternatives it governs instead of below,
because two nested forks put both switchers at the foot of the document with
nothing saying which was which. And an uploaded image now follows the prompt it
was sent with: ChatGPT emits the upload as a content part ahead of the text, and
the exporter was copying that order faithfully. User messages only — assistant
messages keep provider order, where the text introduces the image below it.

**Learned:** ChatGPT image embedding works for both uploaded and generated images
(owner-confirmed live). Claude embeds neither; it was never built. Claude has no
image generation, so uploads are the whole of what support would mean there.

**Learned:** Brightdata MCP recovered later the same day and worked normally.

**Open:** Claude uploaded images and attachments are still not embedded — they
render as `[non-text content omitted: Claude attachment or file content]`. Image
embedding is ChatGPT-only; supporting Claude needs a scope decision and one live
check of the attachment payload shape. Reported by the owner 2026-09-18, not yet
planned. Also still open: the `Image model:` caption decision and the
`diagnostics/` deletion that depends on it; live acceptance of v0.12.0 and
v0.13.0.

## 2026-09-18 — v0.14.0: Claude uploaded images

**Shipped:** Claude exports embed uploaded images. Every image attached to a
Claude prompt used to come out as an omission marker.

**How the field was found:** not guessed. The diagnostic probe ran against a
live conversation and reported structure only. An uploaded image sits on
`message.files[]` with `file_kind: "image"`, `preview_url` and `thumbnail_url`,
both same-origin `/api/<org-id>/files/<file-id>/(preview|thumbnail)` routes that
return `image/webp` bytes to the signed-in session. `preview_asset` carries the
dimensions. There is no original-size route: the preview is the largest variant
Claude stores, so it is what gets embedded. No identifier, file name, URL or
conversation content from that run was recorded here.

**Design:** the image pipeline was already provider-neutral apart from turning
one asset into bytes, so that step became an injected `resolveOne` and
`src/chatgpt-assets.mjs` was renamed `src/assets.mjs`. The Claude path mints no
bearer token (`requiresAuth: false` — the session cookie carries it) and accepts
only a `claude.ai` URL matching the confirmed file route. Anything else is
refused rather than fetched.

**Lesson — the probe cost four rounds before it produced one byte of data.** A
Tampermonkey button that installed once never appeared on an SPA; fixing the
install still did not make it appear; a long console paste was truncated by the
browser at line 101 and ran a fragment. What worked was a ~30-line paste. When a
diagnostic is the blocker, ship the shortest thing that can possibly run, not the
most readable one.

**Lesson — test the diagnostic against a mock before shipping it.** Doing so
caught the probe printing a real file name and a full `file_uuid`, both of which
it promised never to print.

**Open:** live acceptance of v0.13.x and v0.14.0. Claude PDFs and text
attachments are still omission markers (unplanned). The `Image model:` caption
decision still blocks deleting `diagnostics/`; both probes there have now done
their job.

## 2026-09-18 — v0.15.0: Claude reasoning and tool calls

**Shipped:** Claude exports can carry reasoning summaries and tool calls. They were
dropped entirely before. Off by default, one checkbox to include, collapsed
`<details>` in the file. Owner's decision on both defaults.

**The finding that shaped it:** Claude does not send the raw reasoning text.
Every thinking block in the live sample came back `thinking_hidden: true` with
`thinking` as a zero-length string. The `summaries[].summary` lines and the
start/stop timestamps are the whole of what any export can carry, and
"Thought for 56s" is computed from those timestamps. The exporter still reads
`thinking` so a payload that does carry it is not thrown away.

Tool calls are fully present: `name`, `integration_name`, `input`, `message`,
timestamps, and a `content[]` array of text parts up to ~20 KB each.
`display_content.json_block` duplicates that array formatted for Claude's UI and
is deliberately not read — carrying both would roughly double an export.

**Also fixed:** the image preferences were still gated to ChatGPT in the options
dialog, so a Claude user could not reach the chooser. v0.14.0's release note
claimed otherwise. Corrected here.

**Lesson — a look-alike example in chat cost a round.** The owner pasted the
probe's illustrative OUTPUT into the console instead of the probe, and the `---`
lines threw `Invalid left-hand side expression`. Show the paste-ready thing or
the example, not both next to each other.

**Open:** live acceptance of v0.13.x, v0.14.0 and v0.15.0. Claude PDFs and text
attachments are still omission markers. Both probes have done their job; deleting
`diagnostics/` still waits on the `Image model:` decision.

## 2026-09-23 — v0.16.0: temporary and incognito chats

Owner asked for `chatgpt.com/?temporary-chat=true` and `claude.ai/new?incognito`
and asked to confirm the same API serves them. It could not be confirmed: no
public source covers it, and a live check needs the owner. A privacy-safe console
probe (`diagnostics/temporary-chat-probe.js`) went out; the owner chose to ship
without running it ("if it doesn't work I'll update").

**How it works:** neither address carries a conversation id, so it is read from
the page's own requests (Resource Timing plus a PerformanceObserver, since the
timing buffer stops at its limit). Claude accepts only the `/completion` route,
because sidebar and prefetch requests can carry other chats' ids. Requests before
the user entered the temporary route are ignored, so in-app navigation from a
normal chat cannot export the wrong conversation. `@match` stays narrow: two
query-specific lines, not the whole host.

**Open:** live confirmation that both APIs return temporary chats.

## 2026-09-23 — v0.16.1: whole-host loading, Claude incognito fix

Owner's live test of v0.16.0: ChatGPT temporary chats work; Claude incognito shows
no button. Owner also found that a chat started from the home page gets no button
until a reload, and asked for the script to load on all of chatgpt.com except
codex, scheduled and library.

**Done:** `@match` is now the two whole hosts (claude.ai too — same fault there);
the route check decides the button, with ChatGPT's three sections blocked in code
rather than by `@exclude`, so navigating out of them inside the app still works.
Claude's request window is keyed on the route type rather than the full address,
the likeliest cause of the missing button. Not confirmed live.

**If Claude still fails:** `diagnostics/claude-incognito-route-probe.js` (paste
before sending) reports the redacted route shapes of every API request.

**Live result (2026-09-23):** owner confirmed v0.16.1 — new chats get the button
without a reload, and Claude incognito exports. The API question from v0.16.0 is
answered: both providers' conversation APIs serve temporary chats. Neither probe
from this round was needed in the end.
