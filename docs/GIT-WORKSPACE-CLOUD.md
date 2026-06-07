# Git-backed workspace — cloud architecture

## What this is

Every workspace in WorkerOS cloud has a fully versioned git repository. Saving a worker, editing a context, or updating workspace instructions creates a git commit. Version history, rollback, and rollforward all read from this repo. No separate versioning system exists.

The engine's `git_ops.py` handles all git operations. The cloud wrapper (`startup.py`) overrides the relevant functions to add multi-tenancy and durability on top.

## Data ownership

| Data | Primary store | Git versioned? | Notes |
|---|---|---|---|
| Worker manifests + files | Supabase `skill_versions.manifest_json._files` | ✓ | Git is secondary; Supabase is runtime source |
| Context files | Supabase Storage `contexts` bucket | ✓ | Hydrated to disk on first access |
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
│  Layer 1: Local git workspace (per-server disk)                     │
│  /var/workeros-cloud/workspaces/{workspace_id}/                     │
│    workers/{id}/worker.yml  run.py  SKILL.md …                      │
│    contexts/{name}/…                                                │
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
      → git checkout {sha} -- workers/{id}  in local git workspace
          → success: sync_checkout_to_workers()
              → copy files from git workspace to FLOOM_WORKERS_DIR/{id}/
              → update skill_versions._files in Supabase
              → E2B now runs the rolled-back version
          → failure (sha not in local history): fall back to GitHub API
              → fetch files at sha from GitHub Contents API
              → write to disk + update Supabase
  → engine calls commit_paths() to record the rollback as a new commit
```

Rollback works for workers and contexts. The git log shows: `[original commits] → [rollback commit]`.

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
| `apps/api/cloud_git_local.py` | Local git workspace management, bundle upload/restore, backfill |
| `apps/api/cloud_git.py` | GitHub Contents API sync layer |
| `apps/api/startup.py` | Overrides engine git_ops functions for cloud (see `_override_git_ops_for_cloud`, `_override_git_rollback_for_cloud`) |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKEROS_GIT_WORKSPACES_DIR` | `/var/workeros-cloud/workspaces` | Root directory for per-workspace git repos |

## Known limitations

- `alert_incidents` (internal dedup tracker for consecutive-failure alerts) stays in SQLite on disk. If the server is wiped, at most one duplicate alert notification fires per worker on first failure after restore. Acceptable trade-off — the table is never user-visible.
- The git bundle upload runs in a background thread. In the window between a commit and its bundle upload, a simultaneous server wipe would lose the last commit. This window is typically under a second.
- Concurrent writes to the same workspace from two API processes are serialised by a per-workspace `threading.Lock`. This lock is in-process only — if you run multiple API instances pointing at the same workspace directory, last write wins. AX41 runs a single process; this is not currently a concern.
