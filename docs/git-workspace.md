# Git-backed workspace

Every write to the workspace — saving a worker, editing a context, updating workspace instructions — creates a git commit. Version history is git log. Rollback is `git checkout`. There is no separate versioning system.

## Workspace layout

```
{WORKEROS_WORKSPACE_DIR}/          ← git root (WORKERS_DIR parent by default)
  workers/{worker_id}/
    worker.yml                     ← manifest (name, description, inputs, triggers, …)
    run.py                         ← entrypoint
    SKILL.md                       ← system prompt
    requirements.txt               ← optional Python deps
  contexts/{context_name}/
    {files…}                       ← arbitrary context files
  workspace.md                     ← workspace instructions (live)
  workspace.base.md                ← editable base persona
  workspace-tools.yml              ← MCP tool registrations (serialised)
  .gitignore                       ← excludes *.env, workeros.db, .venv, __pycache__
```

Not tracked: `.secrets.enc`, `*.env`, `workeros.db*`, `__pycache__`. Secrets have their own encrypted store.

`WORKEROS_WORKSPACE_DIR` defaults to `WORKERS_DIR.parent` (one level above the workers directory). Override with the `WORKEROS_WORKSPACE_DIR` env var.

## How commits happen

`git_ops.commit_paths(workspace_dir, rel_paths, message)` is the single write path. The engine calls it from `main.py` after every mutation:

- Worker save → `commit_paths(…, ["workers/{id}"], "feat(worker): …")`
- Context write → `commit_paths(…, ["contexts/{name}"], "feat(context): …")`
- Workspace instructions update → `commit_paths(…, ["workspace.md"], "…")`

`commit_paths` does `git add -- {rel_paths}` then `git commit`. If nothing changed (identical content), it skips the commit and returns the current HEAD sha. Returns the 7-char short sha of the resulting commit.

## Rollback

`git_ops.checkout_path(workspace_dir, sha, rel_path)` restores `rel_path` to its state at `sha` via `git checkout {sha} -- {rel_path}`. This modifies the working tree only — the caller is responsible for calling `commit_paths` afterwards to record the rollback as a new commit in history.

`get_file_at_sha(workspace_dir, sha, rel_path)` reads file content at a given sha without touching the working tree. Used by the versions API.

`list_files_at_sha(workspace_dir, sha, prefix)` lists all paths under `prefix` at a given sha. Used by rollback to know which files to restore.

## Version history

`git_ops.get_log(workspace_dir, rel_path, limit)` returns commits that touched `rel_path`, newest first. Each entry: `{id, sha, message, author, timestamp, asset_type, asset_id}`. Both `id` and `sha` are 7-char short hashes.

## Remote sync (optional)

If `WORKEROS_GIT_REMOTE` is set, the engine calls `configure_remote(workspace_dir, remote_url)` on startup and `push_background(workspace_dir)` after every commit. `push_background` runs in a daemon thread — a transient push failure is logged at DEBUG and never surfaces to the user.

`clone_or_init(workspace_dir, remote_url)` is used on a fresh install when a remote is already configured: it clones the remote so the full history arrives intact rather than starting blank.

## Host hook: workspace_id resolver

In self-hosted single-tenant mode the git root is a single directory shared by the one user. A downstream multi-tenant host can give each workspace its own isolated git root.

`set_workspace_id_resolver(fn)` registers a callable that returns the active `workspace_id` for the current request. When set, the host uses the returned value to scope the git root to the right per-workspace directory. In self-hosted mode this resolver is never registered and all functions receive the workspace dir directly as a parameter.

A downstream host can register this at startup:

```python
import git_ops
git_ops.set_workspace_id_resolver(get_active_workspace_id)
```

## Initialisation

`ensure_repo(workspace_dir)` initialises the git repo if one does not exist. Creates the default `.gitignore`, sets `user.email = workeros@local`, `user.name = Floom`, and makes an initial commit of any pre-existing files. Returns `True` if it initialised, `False` if already a repo.

Call `ensure_repo` once at startup before any `commit_paths` call. The API server does this in its startup sequence.
