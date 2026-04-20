# Local stash archive (2026-04-21)

This directory exists so **19 `git stash` entries** that previously lived only in a single developer clone are **also** stored as **committed patches** in Git history. After this lands on `origin`, the work is recoverable even if someone runs `git stash clear` or loses that machine.

## Contents

| File | Purpose |
|------|---------|
| `STASH-LIST.txt` | Output of `git stash list` at archive time (newest stash is `stash@{0}`). |
| `patches/stash-NN-full.patch` | `git stash show --include-untracked -p stash@{NN}` for each index `0…18`. |

Index `NN` matches `stash@{NN}` **at archive time** (not necessarily after future stash drops).

## Restore (careful)

Patches were produced against **whatever commit each stash was based on** (see each stash’s “On &lt;branch&gt;” in `STASH-LIST.txt`). They will **not** always apply cleanly to current `main`.

Suggested workflow:

1. Create a recovery branch from a sensible base (often `origin/main`, or the branch named in the stash message).
2. Preview:  
   `git apply --check docs/internal/stash-archive-20260421/patches/stash-06-full.patch`
3. Apply:  
   `git apply docs/internal/stash-archive-20260421/patches/stash-06-full.patch`  
   Resolve conflicts, run tests, commit.
4. For **binary** hunks (PNGs, etc.), prefer checking out files from a branch created with `git stash branch …` on the **original** clone if it still exists; patches may omit or mangle binaries.

## Index ↔ original message (at archive time)

| NN | Stash message (first line) |
|----|----------------------------|
| 00 | On feat/hub-smoke-e2e: journal-wip-before-hub-smoke-rebase |
| 01 | On fix/ux-loading-auth-2026-04-18: wip other files |
| 02 | On fix/ux-hub-me-notice-2026-04-18: wip unrelated before ux-a11y branch |
| 03 | On fix/ux-loading-auth-2026-04-18: wip before ux-hub-me-notice |
| 04 | WIP on feat/me-v15.1-claude-shape: … |
| 05 | On feat/revive-runtime-deploy: more me-v15.1 inflight: MeAppRunPage prompt prefill |
| 06 | On feat/revive-runtime-deploy: unrelated inflight changes from concurrent feat/me-v15.1 session |
| 07 | On feat/logo-glow-expansion-2026-04-17: W1-inflight-changes-before-v15public-work |
| 08 | On main: pre-v15.2-uncommitted-rate-limit-work |
| 09 | On fix/rate-limits-hardening-2026-04-17: consent-sentry-lane-WIP |
| 10 | On fix/rate-limits-hardening-2026-04-17: lane-d-stash-1776457619 |
| 11 | WIP on main: d129ab8 Merge pull request #25 … |
| 12 | On main: in-flight other lanes work (visibility, etc) - not for rate-limit PR |
| 13 | On polish/logo-glow-2026-04-17: logo-glow-wip |
| 14 | On main: W4M.gap-close WIP: better-auth migrations + /me/settings + run ctx |
| 15 | On wave/W2.1-per-user-state: W2.1 landed changes - stashed by W2.2 for branch switch |
| 16 | On wave/W2.1-per-user-state: W2.2 openapi-ingest renderer integration |
| 17 | On wave/W2.1-per-user-state: W2.2 uncommitted work preserved by W2.1 agent |
| 18 | On main: W1.3 landing polish WIP - stashed by W2.2 agent before branch switch |

## After this is merged

- Optional: on the **original** machine, once you have recovered anything you need, you can drop stashes in reverse order (`git stash drop` after verifying). **Do not** mass-drop until you have confirmed patches or recovered work.
- The separate **git bundle** at `~/Archive/floom-home-clone-20260421.bundle` (if still present) remains an older full-object backup; this archive is easier to browse in PRs.
