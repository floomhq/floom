# Git-backed workspace — cloud architecture

## What this is

Every workspace in WorkerOS cloud has a fully versioned git repository. Saving a worker, editing a context, or updating workspace instructions creates a git commit. Version history, rollback, and rollforward all read from this repo. No separate versioning system exists.

The engine's `git_ops.py` handles all git operations. The cloud wrapper (`startup.py`) overrides the relevant functions to add multi-tenancy and durability on top.

## Data ownership

| Data | Primary store | Git versioned? | Notes |
|---|---|---|---|
| Worker manifests + files | Supabase `skill_versions.manifest_json._files` | ✓ | Git is secondary; Supabase is runtime source |
| Context files (non-sensitive) | Supabase Storage `contexts` bucket | ✓ | Also committed to git + the bundle; hydrated to disk on first access |
| Context files (**sensitive**) | Supabase Storage `contexts` bucket | ✗ | **Never** in git or the bundle (may hold credentials); Storage is the only durable backup |
| Workspace instructions | Disk + git workspace | ✓ | |
| Workspace tools | Supabase `mcp_tools` | ✓ | Serialised to `workspace-tools.yml` on commit |
| Version history | Local disk + Supabase Storage bundle | ✓ | Bundle = git disaster recovery |
| Runs | Supabase `runs` | ✗ | Immutable log, not versioned |
| Secrets | Supabase Vault (pgsodium) | ✗ | Intentional — never in git |
| Alert registrations | Supabase `worker_alerts` | ✗ | |
| Composio connections | Supabase `connections` | ✗ | OAuth token lives on Composio side |
| Git history (DR) | Supabase Storage `workeros-git-bundles` | — | IS the git, bundled after every commit |

## Architecture: three layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: Local git workspace (per-server disk, EPHEMERAL)          │
│  $WORKEROS_GIT_WORKSPACES_DIR/{workspace_id}/                       │
│  (default: /opt/workeros-cloud/var/git-workspaces — MUST be         │
│   writable by the container user; see #319 below)                   │
│    workers/{id}/worker.yml  run.py  SKILL.md …                      │
│    contexts/{name}/…  (non-sensitive only)                          │
│    workspace.md  workspace.base.md  workspace-tools.yml             │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Supabase Storage bundle (disaster recovery)               │
│  bucket: workeros-git-bundles / {workspace_id} / repo.bundle        │
│  Updated after every commit. Restored on cold start.                │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Supabase (runtime source of truth)                        │
│  skill_versions.manifest_json._files  ← what E2B actually runs      │
│  All other tables (runs, secrets, connections, alerts, …)           │
└─────────────────────────────────────────────────────────────────────┘

Optional sync layer (when GitHub is connected):
  Local git workspace → GitHub repo (via Contents API or git push)
```

E2B reads worker files from `skill_versions._files` in Supabase — never from disk or the bundle directly. The disk workspace is for version control; Supabase is for execution.

## Sensitive vs non-sensitive contexts

Contexts ("brain packs") carry a `sensitive` flag (default **true** on create). It decides whether a context's contents are allowed into git:

| | git repo / **bundle** | disk (`context_dir`) | **`contexts` Storage bucket** |
|---|---|---|---|
| Non-sensitive context | ✓ versioned | ✓ | ✓ |
| **Sensitive** context | ✗ **never** | ✓ | ✓ |

Sensitive contexts may hold credentials, so they are deliberately kept out of git history (which can sync to a connected GitHub repo). They are therefore **not versioned and have no rollback** — but they still get a durable backup via a direct upload to the `contexts` Storage bucket, and rehydrate on a fresh server exactly like non-sensitive ones.

The enforcement points: `_git_commit_context` / `_write_context` skip git for sensitive contexts; the cloud `_override_git_commit_context_for_cloud` (`startup.py`, #319) ensures the sensitive write still reaches Storage (previously it reached neither git nor Storage and had no backup at all).

## Normal commit flow (worker save)

```
PUT /workers/{id}
  → SupabaseWorkerRepository.save() → Supabase skill_versions updated
  → engine calls commit_paths(workspace_dir, ["workers/{id}"], message)
  → cloud override (_cloud_commit_paths in startup.py):
      → cloud_git_local.commit_workspace(workspace_id, rel_paths, message)
          → write worker files from Supabase to git workspace on disk
          → git add -A && git commit
          → upload_bundle_background() → Supabase Storage (daemon thread)
      → cloud_git.schedule_push()  ← no-op if GitHub not connected
```

The bundle upload is async (daemon thread) so it never adds latency to the response.

## Cold start flow (new server or server wipe)

```
First git operation for workspace_id
  → ensure_workspace_repo(workspace_id)
      → .git/ exists? → return immediately (fast path)
      → not found → download bundle from Supabase Storage
          → bundle found → git clone bundle → repo restored to disk
              → _backfill_worker_files_from_git()
                  for each workers/{id}/ in git workspace:
                    if skill_versions._files is empty in Supabase:
                      read files from git workspace
                      write to skill_versions._files in Supabase
                  workers can now run via E2B on this new server
          → no bundle (brand new workspace) → git init
```

After restore, the server has the full git history and all workers are executable. No GitHub connection required.

## Rollback flow

```
POST /workers/{id}/rollback/{sha}
  → engine calls checkout_path(workspace_dir, sha, "workers/{id}")
  → cloud override (_cloud_checkout_path in startup.py):
      → git checkout {sha} -- workers/{id} (or contexts/{name})  in local git
          → success: sync the restored tree back to where reads serve from —
              → workers:  sync_checkout_to_workers()
                  → copy git → FLOOM_WORKERS_DIR/{id}/, update skill_versions._files
              → contexts: sync_checkout_to_contexts()   (#319)
                  → copy git → context_dir(name), re-upload to the contexts bucket
              (without this back-sync the git tree reverts but reads keep
               serving the old content — the bug fixed in #319)
          → failure (sha not in local history): fall back to GitHub API
              → fetch files at sha from GitHub Contents API
              → write to disk + update Supabase
  → engine calls commit_paths() to record the rollback as a new commit
```

Rollback works for **workers** and **non-sensitive contexts**. Sensitive contexts are not in git, so they have no version history to roll back to. The git log shows: `[original commits] → [rollback commit]`.

## Version history (get_log / get_file_at_sha)

Read operations try local git first, fall back to GitHub API if the sha is not in local history (e.g. workspace has GitHub history predating local git):

```python
# _cloud_get_log in startup.py
git_dir = ensure_workspace_repo(workspace_id)
entries = git_ops.get_log(git_dir, rel_path=rel_path, limit=limit)
if entries:
    return entries
# fall back to GitHub commits API if connected
```

## GitHub sync (optional)

When a user connects a GitHub account (`POST /system/git/connect`):
- `cloud_git.schedule_push()` is called after every `commit_paths`, pushing the same changes to the GitHub repo via the Contents API
- `cloud_git.push_all()` does a full workspace snapshot on initial link
- Rollback falls back to GitHub API if the sha is not in the local git repo

The GitHub repo layout mirrors the local git workspace layout exactly (`workers/{id}/`, `contexts/{name}/`, etc.) so the two can substitute for each other in recovery scenarios.

## Key modules

| File | Purpose |
|---|---|
| `engine/apps/api/git_ops.py` | All git operations — commit, log, checkout, push, clone |
| `apps/api/cloud_git_local.py` | Local git workspace management, bundle upload/restore, backfill, `sync_checkout_to_workers` / `sync_checkout_to_contexts` |
| `apps/api/cloud_git.py` | GitHub Contents API sync layer |
| `apps/api/startup.py` | Overrides engine git_ops/context functions for cloud: `_override_git_ops_for_cloud`, `_override_git_rollback_for_cloud`, `_override_workers_git_prefix_for_cloud` (#319), `_override_git_commit_context_for_cloud` (#319) |

> **#319 cloud overrides (engine bugs patched cloud-side; should be upstreamed):**
> - `_workers_git_prefix()` returned `''` for cloud, but workers live under `workers/<id>/` — so version-read/rollback queried the wrong path and `/versions` was always empty even though commits existed. The override forces `'workers'`.
> - `_git_commit_context()` skipped git **and** Storage for sensitive contexts (the Storage upload lived inside the git-commit path they bypass) — so sensitive contexts had no backup. The override uploads them to the `contexts` bucket on write.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKEROS_GIT_WORKSPACES_DIR` | falls back to `/opt/workeros-cloud/var/git-workspaces` | Root directory for per-workspace git repos. **Must be writable by the container user** (uid 10001) — only `/opt/workeros-cloud/var/*` is chowned in the Dockerfile. `get_workspaces_root()` (#319) checks writability and falls back to the writable path if the configured one (or the legacy `/var/workeros-cloud/workspaces`) isn't usable. |

> **#319 footgun:** if this dir isn't writable, `commit_workspace`'s `mkdir` raises `PermissionError`, which used to be swallowed silently — breaking versioning, rollback **and** the bundle backup with no error surfaced. `commit_workspace` now logs git failures at ERROR. Any new host must give the process a writable workers dir **and** git-workspaces dir.

## Known limitations

- `alert_incidents` (internal dedup tracker for consecutive-failure alerts) stays in SQLite on disk. If the server is wiped, at most one duplicate alert notification fires per worker on first failure after restore. Acceptable trade-off — the table is never user-visible.
- The git bundle upload runs in a background thread. In the window between a commit and its bundle upload, a simultaneous server wipe would lose the last commit. This window is typically under a second.
- Concurrent writes to the same workspace from two API processes are serialised by a per-workspace `threading.Lock`. This lock is in-process only — if you run multiple API instances pointing at the same workspace directory, last write wins. Prod runs a single instance; this is not currently a concern.
- **Hydration only restores what was actually persisted.** A fresh server rebuilds workers (`skill_versions._files`), git history (the bundle), and contexts (the `contexts` bucket) from Supabase on demand — but only for data that reached Supabase. Workers whose `_files` were never persisted (e.g. created out-of-band / on a misconfigured host), or a workspace that never produced a bundle, do **not** rehydrate. New cloud writes always persist; legacy/corrupted rows won't reappear.
- A new host also needs the non-data config to "just work": Supabase URL + service key, LLM/E2B creds, and writable `FLOOM_WORKERS_DIR` + `WORKEROS_GIT_WORKSPACES_DIR`. Supabase holds *data*, not server *config*.
