# Vivek Git Workspace Reconciliation

Date: 2026-06-07
Repo: `floomhq/workeros`
Compared refs: `origin/main` at `e3b6e46` and `origin/feat/git-workspace` at `11811d3`
Scope: analysis and coordination only. No merge performed.

## Verdict

Collision severity is high.

`apps/api/main.py` has a real content conflict, plus semantic conflicts in worker visibility, versioning, workspace scoping, and secrets.

Visibility model: `worker.yml` can carry authored visibility as portable git metadata, but DB `workers` / `asset_access` / `workspace_members` remain the enforcement and query authority until the git store has a complete migration and cache contract.

Secrets model: vault and DB-backed secret values win. Git can store secret references and required secret names; `.secrets.enc` plus a GitHub-readable key conflicts with the #488 "no secrets in git" rule unless Federico explicitly approves it as a separate encrypted backup model.

Recommended merge order: rebase `feat/git-workspace` onto current `origin/main` first, resolve the conflicts there, then land the reconciled git workspace branch. Do not stack new Claude/Codex visibility, secret, or scoping patches on main while Vivek is rebasing.

Boundary: Claude/Codex stops touching `apps/api/main.py` worker visibility/list/detail, secret persistence, workspace scoping, version endpoints, and Settings git UI until the git-workspace rebase lands or Vivek publishes a narrower integration branch.

## Diff Stat

Verified with:

```bash
git diff origin/main...origin/feat/git-workspace --stat
```

Result:

```text
 .secrets.enc                               |  Bin 0 -> 254 bytes
 apps/api/chat_service.py                   |   10 +-
 apps/api/db/_legacy_sqlite.py              |   18 +
 apps/api/db/factory.py                     |    4 -
 apps/api/db/interface.py                   |   37 -
 apps/api/db/sqlite.py                      |  140 ---
 apps/api/git_ops.py                        |  305 +++++
 apps/api/github_api.py                     |  242 ++++
 apps/api/main.py                           | 1743 +++++++++++++++++-----------
 apps/api/models.py                         |    5 +
 apps/api/tests/test_git_workspace.py       |  354 ++++++
 apps/api/tests/test_git_workspace_e2e.md   |  377 ++++++
 apps/api/tests/test_versioning.py          | 1023 ++++------------
 apps/web/app/assistant/page.tsx            |    4 +-
 apps/web/app/contexts/page.tsx             |   27 +-
 apps/web/app/settings/page.tsx             |   12 +-
 apps/web/app/workers/[id]/page.tsx         |   43 +-
 apps/web/components/GitWorkspacePanel.tsx  |  474 ++++++++
 apps/web/components/VersionDiffPanel.tsx   |    8 +-
 apps/web/components/VersionHistoryMenu.tsx |   53 +-
 apps/web/lib/api.ts                        |   29 +
 apps/web/lib/types.ts                      |   28 +-
 workers/topic-explainer/SKILL.md           |    3 +
 workers/topic-explainer/run.py             |    2 +
 workers/topic-explainer/worker.yml         |   63 +
 workspace-tools.yml                        |    2 +
 26 files changed, 3269 insertions(+), 1737 deletions(-)
```

## Merge Conflict Map

Verified with:

```bash
git merge-tree --write-tree origin/main origin/feat/git-workspace
```

Text conflicts:

- `apps/api/main.py`
  - Version endpoints conflict directly: `GET /workers/{id}/versions`, `GET /workers/{id}/versions/{sha}`, and `POST /workers/{id}/rollback/{sha}` contain markers between DB `asset_versions` snapshot semantics and git commit semantics.
  - The merged result keeps `_worker_access_user_id()` from main, but this must be intentionally preserved when resolving the versioning conflict because list/detail calls now depend on it.
  - The branch adds `_git_workspace()`, `_workers_git_prefix()`, `_contexts_git_prefix()`, git commit hooks, git status/link endpoints, `.secrets.enc` sync, and `workspace-tools.yml` sync in the same file that main recently changed for auth, visibility, and worker status.
- `apps/web/app/assistant/page.tsx`
  - Rollback UI conflicts between `refresh()` / `version_number` and `loadVersions()` / `sha`.
- `apps/web/app/settings/page.tsx`
  - Settings tab model conflicts between main's renamed `Developer` tab and the branch's new `git` tab plus `GitWorkspacePanel`.
- `apps/web/lib/api.ts`
  - Workspace/base-persona API additions from main conflict with the branch's git workspace client methods.

Auto-merged but high-risk files:

- `apps/web/app/contexts/page.tsx`
  - Version restore behavior changes from DB file snapshots to git commit restore.
- `apps/web/lib/types.ts`
  - `VersionSummary` shape changes from `version_number/change_source/created_at` to `sha/message/author/timestamp`.
- `apps/api/db/interface.py`, `apps/api/db/sqlite.py`, `apps/api/db/factory.py`
  - The branch removes `VersionRepository`. This is coherent with git-backed history, but it invalidates any main-side patches that still expect `repos.versions`.
- `apps/api/chat_service.py`
  - The branch adds `WORKEROS_WORKSPACE_DIR` support for workspace files; this overlaps with the git workspace root and Cloud scoping model.

## Conceptual Overlap

Recent main-side fix mapping:

- FL1 worker visibility from PR #492: conflicts-must-reconcile.
  - Main verified a specific compatibility path: `_worker_access_user_id()` maps Federico session-shaped auth back to the legacy local owner for worker list/detail access.
  - `origin/feat/git-workspace` lacks that function before rebase.
  - Resolution: preserve main's owner mapping and role-aware `repos.workers.list(..., role=auth.role)` behavior. Add git `worker.yml.visibility` as portable metadata, not as the only enforcement gate.
- Multi-member parity and role isolation from `e3b6e46` / main: preserved, with integration work required.
  - Main's `workspace_members`, `asset_access`, PAT/session auth, and role-aware worker reads remain the enforcement layer.
  - Git workspace scoping can use a workspace resolver, but it must not bypass member role checks or collapse all members into one local user.
- Wrong shared secret returns 401 from `9f2c9ce`: preserved.
  - `origin/feat/git-workspace` still returns 403 for wrong `x-floom-secret`.
  - Rebase resolution is one line: keep main's 401 response for both missing and wrong shared secret.
- Reliability-by-design issue #551: preserved as a future gate, not implemented by the git branch.
  - Main already computes `MISSING_SECRET` status from declared worker secrets.
  - The git branch makes manifest-stored secret requirements more durable, which helps #551, but activation/scheduling still needs an enforcement gate over required connections, secrets, and inputs.
  - Resolution: after git-workspace lands, implement #551 against the manifest parser plus DB/vault availability, not by adding another secrets model.
- DB `asset_versions` versioning: obsoleted-by-git-workspace, with migration requirement.
  - The branch removes `VersionRepository` and rewrites version endpoints/tests to git logs.
  - Resolution: git history wins for authored files only. Runtime records remain in DB. Legacy `asset_versions` need import or read fallback during migration.

## Model Boundaries

Visibility:

- Git source of truth: authored default visibility in `worker.yml` and portable workspace files.
- Runtime source of truth: `workers.visibility`, `asset_access`, `workspace_members`, and role checks for list/detail/run enforcement.
- Required reconciliation: on manifest import or save, sync `worker.yml.visibility` into DB rows. On API visibility change, write both DB enforcement state and the manifest commit. Reject a git manifest that grants visibility beyond the caller's role.

Secrets:

- Git stores required secret names, connection declarations, and `secret_ref` references.
- Vault/DB stores secret values and availability metadata.
- The branch's `.secrets.enc` and GitHub Actions Variables key path conflicts with the issue #488 rule if treated as part of the workspace source repo. It also makes repo read access equivalent to secret-value read access.
- Required reconciliation: remove `.secrets.enc` from the workspace source repo path or gate it behind an explicit product/security decision. Do not use GitHub Variables as the default key authority for workspace secret values.

Scoping:

- Main's local workspace and multi-member scoping remain authoritative for API access.
- Git workspace can have one repo per workspace, but `_git_ops.get_active_workspace_id()` must be wired from the same auth/workspace context used by `workspace_members` and `asset_access`.
- Do not infer access from repo presence or GitHub PAT ownership.

Versioning:

- Git history wins for workers, contexts, `workspace.md`, and `workspace.base.md`.
- DB remains for runs, logs, schedules, approvals, conversations, metrics, and secret availability.
- The `VersionSummary` API shape needs one compatibility decision: either ship a breaking `sha` shape everywhere or keep an adapter that maps git commits into the old fields for existing callers.

## Recommended Merge Order

1. Freeze new main-side edits in the collision zones:
   - `apps/api/main.py` worker visibility/list/detail paths
   - secret save/delete and secret availability paths
   - workspace scoping and auth-to-owner mapping
   - version endpoints and `VersionSummary`
   - Settings git/developer tab API wiring
2. Vivek rebases `origin/feat/git-workspace` onto `origin/main`.
3. Resolve textual conflicts with these choices:
   - keep main's 401 for wrong shared secret;
   - keep `_worker_access_user_id()` and all role-aware member checks;
   - take git-backed version endpoints, but keep canonical worker IDs and access checks;
   - keep main's base-persona/workspace API additions and add git commits after those writes;
   - keep main's Developer tab rename and add Git as a separate tab without resurrecting `api` tab URLs except through the existing fallback.
4. Resolve model conflicts:
   - `worker.yml.visibility` is portable metadata;
   - DB/member/asset access is enforcement;
   - secrets values stay in vault/DB, git stores references;
   - git repo scoping uses the same workspace id as the auth/membership layer.
5. Run focused verification after rebase:
   - `pytest apps/api/tests/test_multi_member.py apps/api/tests/test_local_workspaces.py apps/api/tests/db/test_workspace_members_and_visibility.py`
   - git workspace tests from the branch
   - worker list/detail with session auth and `x-floom-secret`
   - wrong `x-floom-secret` returns 401
   - create/update/rollback worker version path creates git commits and preserves permissions
   - secret save/delete does not commit secret values to the workspace source repo

## Stop-Touch Boundary

Until Vivek's rebased git workspace branch lands:

- Vivek owns git storage, git version endpoints, manifest-backed visibility writes, `workspace-tools.yml`, and GitHub link/import UI.
- Claude/Codex owns no new changes in those surfaces.
- Claude/Codex can continue unrelated work outside these collision zones, especially docs, tests that do not rewrite the contract, and non-overlapping UI polish.
- Any urgent production fix inside the collision zones goes through a tiny patch plus an explicit note on #488 so Vivek rebases over known intent.

## Verification Evidence

- `git fetch origin main feat/git-workspace --prune` completed from `https://github.com/floomhq/workeros`.
- `git diff origin/main...origin/feat/git-workspace --stat` produced the 26-file stat above.
- `git merge-tree --write-tree origin/main origin/feat/git-workspace` reported content conflicts in `apps/api/main.py`, `apps/web/app/assistant/page.tsx`, `apps/web/app/settings/page.tsx`, and `apps/web/lib/api.ts`.
- `git show origin/main:apps/api/main.py` confirms `_worker_access_user_id()` exists on main.
- `git show origin/feat/git-workspace:apps/api/main.py` confirms the branch lacks `_worker_access_user_id()` before rebase and returns 403 for wrong shared secret.
- `gh issue view 492` confirms PR #492 is merged and documents the FL1 visibility verification.
- `gh issue view 551` confirms the reliability-by-design requirement is open and scoped to activation blocking for missing required connections, secrets, and inputs.
