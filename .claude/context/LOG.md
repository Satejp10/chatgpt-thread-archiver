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
