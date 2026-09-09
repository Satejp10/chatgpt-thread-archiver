# Branch cleanup log

Record of branch pruning on `Satejp10/chatgpt-thread-archiver`. Append a new
section per cleanup pass. Never delete a branch without first recording here
why its commits are safe to lose, and where they remain recoverable.

## Recovery rules used

A branch is safe to delete when at least one of these holds:

1. **Merged** — `git merge-base --is-ancestor <branch> origin/main` succeeds. The
   commits are reachable from `main` forever.
2. **Content-identical to a merged tip** — `git diff <tip> <merged-tip>` is empty.
   Nothing unique is lost.
3. **Preserved by a pull request ref** — GitHub keeps every PR head at
   `refs/pull/<n>/head` permanently, even for closed and unmerged PRs. Fetch with
   `git fetch origin refs/pull/<n>/head`.

Anything that satisfies none of these stays.

## 2026-09-09 — post v0.12.0 pass

Audited 12 non-`main` remote branches against `origin/main` @ `10c50a0`
(merge of [#21](https://github.com/Satejp10/chatgpt-thread-archiver/pull/21), v0.12.0).

### Deleted — merged into `main`

| Branch | Tip | PR | Merged |
|---|---|---|---|
| `chatgpt-images-stats-v0.7` | `f2b8280` | [#9](https://github.com/Satejp10/chatgpt-thread-archiver/pull/9) | 2026-08-22 |
| `chatgpt-message-models-v0.8.1` | `cdb741b` | [#11](https://github.com/Satejp10/chatgpt-thread-archiver/pull/11) | 2026-08-23 |
| `claude-basic-v0.6` | `2de19a3` | [#8](https://github.com/Satejp10/chatgpt-thread-archiver/pull/8) | 2026-08-22 |
| `docs-refresh-install-image` | `5f943b9` | [#16](https://github.com/Satejp10/chatgpt-thread-archiver/pull/16) | 2026-09-09 |
| `fix-offline-controls` | `5467a6a` | [#13](https://github.com/Satejp10/chatgpt-thread-archiver/pull/13) | 2026-08-26 |
| `message-level-branch-controls` | `d5cc29e` | [#14](https://github.com/Satejp10/chatgpt-thread-archiver/pull/14) | 2026-08-26 |
| `pending-projects-theme-branches` | `3e0077f` | [#12](https://github.com/Satejp10/chatgpt-thread-archiver/pull/12) | 2026-08-25 |
| `release-history-links` | `5a191b9` | [#15](https://github.com/Satejp10/chatgpt-thread-archiver/pull/15) | 2026-09-03 |

Rule 1 for all eight.

### Deleted — not merged, but nothing unique lost

| Branch | Tip | Why safe |
|---|---|---|
| `chatgpt-image-options-v0.8` | `6afb4cc` | Rule 2. Tip tree is byte-identical to `cdb741b`, the merged tip of `chatgpt-message-models-v0.8.1` ([#11](https://github.com/Satejp10/chatgpt-thread-archiver/pull/11)). `git diff 6afb4cc cdb741b` is empty. The branch was a stale duplicate of the same v0.8.1 work; [#10](https://github.com/Satejp10/chatgpt-thread-archiver/pull/10) merged an earlier head (`75b438c`) from it. |
| `restore-original-install-screenshot` | `fe082be` | Rule 3. [#17](https://github.com/Satejp10/chatgpt-thread-archiver/pull/17) was **closed without merging** — a deliberate decision to keep `docs/assets/install-guide.png` on `main` rather than swap it for the `.jpg`. The tip equals the PR head, so it stays fetchable at `refs/pull/17/head`. |

### Deleted — working branch history now on `main`

| Branch | Tip | PR | Merged |
|---|---|---|---|
| `claude/archiver-context-port-f7z4ql` | `dea2507` | [#19](https://github.com/Satejp10/chatgpt-thread-archiver/pull/19), [#20](https://github.com/Satejp10/chatgpt-thread-archiver/pull/20), [#21](https://github.com/Satejp10/chatgpt-thread-archiver/pull/21) | 2026-09-09 |

This is the reusable Claude Code working branch. It is reset to `origin/main`
at the start of each new task rather than deleted, so it is listed here for
completeness only.

### Kept

| Branch | Tip | Reason |
|---|---|---|
| `image-model-metadata` | `79e4681` | Carries one commit that is on no other ref and in no PR: `docs/claude-code-context-port-v0.11.0.md`, a point-in-time handoff snapshot written at v0.11.0. It satisfies none of the three rules. It is also now stale — `docs/developer-handoff.md` on `main` supersedes it at v0.12.0 — so the branch is a deletion candidate as soon as the owner confirms the snapshot is not worth keeping. |

## How to re-run this audit

```sh
git fetch --prune origin
for b in $(git branch -r --format='%(refname:short)' | grep -v 'origin/main$'); do
  merged=$(git merge-base --is-ancestor "$b" origin/main && echo MERGED || echo UNMERGED)
  printf '%-45s %-9s %s\n' "${b#origin/}" "$merged" "$(git log -1 --format='%h %cs %s' "$b")"
done
```

Then, for every `UNMERGED` branch, check rules 2 and 3 before deleting.
