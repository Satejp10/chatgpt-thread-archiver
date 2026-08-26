# Version history records

This folder is the permanent, per-version release log for ChatGPT Thread Archiver. Starting with the v0.9.0 release line, every version built for review or release must have one Markdown record named `v<major>.<minor>.<patch>.md`.

## Required workflow

Create or update the version record on the feature branch before opening the pull request. Mark the record as a **candidate** while the work is under review. After the pull request is merged, update the same record with the merge commit and mark the version as **stable** only after the required local and live acceptance checks are complete.

Each record must state the release date or candidate date, source branch, base and merge commits when known, purpose, user-visible changes, privacy or compatibility implications, local validation results, live acceptance status, pull-request link, and known limitations or follow-up decisions. Keep the record concise enough to scan but specific enough for a future maintainer to reconstruct what was built and tested.

Version records are documentation, not a second changelog. The `CHANGELOG.md` remains the user-facing summary; `docs/build-history.md` remains the high-level release matrix and reproducible command history. The per-version record should link to those documents when useful and provide the detailed release decision for that version.

Never place conversation transcripts, raw API responses, browser logs, cookies, access tokens, signed URLs, full private identifiers, or other sensitive data in these records. Use sanitized descriptions, fixture names, test commands, commit hashes, and public pull-request URLs only. Do not record claims of live compatibility unless the relevant browser scenario was actually tested.

Before committing a version record, run the normal build and regression checks, verify that the root and `dist/` userscripts are byte-identical, and run `git diff --check`. A candidate record must clearly distinguish automated validation from product-owner live testing.

## Record template

```markdown
# vX.Y.Z — candidate/stable

| Item | Value |
|---|---|
| Date | YYYY-MM-DD |
| Source branch | `branch-name` |
| Base commit | `abcdef0` |
| Merge commit | `abcdef0` or pending |
| Pull request | [#N](https://github.com/Satejp10/chatgpt-thread-archiver/pull/N) |
| Release state | Candidate / Stable |

## Purpose

One paragraph describing why this version exists.

## User-visible changes

A concise description of the behavior users can see.

## Validation

| Check | Result |
|---|---|
| Automated checks | Passed / pending |
| Live acceptance | Passed / pending, with scenarios |

## Limitations and decision

Known limitations, risks, and the next product decision.
```
