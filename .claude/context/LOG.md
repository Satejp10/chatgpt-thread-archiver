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

**Open:** Claude uploaded images and attachments are still not embedded — they
render as `[non-text content omitted: Claude attachment or file content]`. Image
embedding is ChatGPT-only; supporting Claude needs a scope decision and one live
check of the attachment payload shape. Reported by the owner 2026-09-18, not yet
planned. Also still open: the `Image model:` caption decision and the
`diagnostics/` deletion that depends on it; live acceptance of v0.12.0 and
v0.13.0.
