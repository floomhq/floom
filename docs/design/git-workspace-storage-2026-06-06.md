# Git-Backed Workspace Storage Design

Date: 2026-06-06
Status: recommendation only
Supersedes: PR #479, `docs/design/cloud-worker-storage-2026-06-06.md`

## Summary

Use git as the durable substrate for authored workspace source in both OSS and Cloud. The repository is private per workspace, invisible in the product UI, and stores source-like content only:

- worker bundles: `worker.yml`, `run.py`, `SKILL.md`, `requirements.txt`, and support files
- brain folders and files, with metadata and tags in YAML frontmatter
- `workspace.base.md`
- `workspace.md`
- workspace instruction and persona metadata

The runtime database remains the source of truth for operational state: runs, logs, conversations, metrics, schedules, trigger registrations, approvals, secrets metadata, and search indexes. Large brain binaries use object storage pointers in Cloud and optional Git LFS in OSS or GitHub mirrors.

Recommended implementation choices:

- Git library: `isomorphic-git` in a small internal `workspace-git` service/module.
- Cloud repository location: Workeros-owned bare repos on a persistent volume, outside Railway's ephemeral app filesystem, with object-store bundle backups.
- Rollout: OSS local git foundation first, then Cloud pilot, then Cloud cutover, then optional GitHub mirror/import.

## Verified Current Facts

This design is grounded in the current code paths named in the brief:

- `apps/api/worker_registry.py` defines `WORKERS_DIR` from `FLOOM_WORKERS_DIR` or `../../workers`, scans folders, and treats each folder with `worker.yml` as a worker.
- `apps/api/main.py:create_worker` writes `worker.yml`, `run.py`, `requirements.txt`, and `SKILL.md` under `WORKERS_DIR/<id>`, then calls discovery and `_persist_discovered_workers`.
- `apps/api/main.py:update_worker_files` replaces all worker files through a staging directory, then records an `asset_versions` snapshot.
- `apps/api/chat_service.py` has Emily worker create/update tools converged onto the same filesystem materialization paths rather than DB-only updates.
- `apps/api/contexts.py` stores brain/context files as directories under `CONTEXTS_DIR`; in Cloud mode the root can be scoped by workspace/user. Metadata and tags currently live in `.workeros-contexts.json`.
- `apps/api/main.py` records DB snapshots for workers, brain packs/files, `workspace.md`, and `workspace.base.md` through `asset_versions`.
- `apps/api/chat_service.py` reads and writes `workspace.md` and `workspace.base.md` from root-level files.
- PR #479 proposed DB indexing plus object-storage worker bundles. This design carries forward durable storage, workspace scoping, immutable run snapshots, stock worker protection, and large-object controls. It changes the canonical authored source store from DB/object-store bundle rows to git history.

## Repository Layout

One private repo exists per workspace. The repo stores the workspace's authored source exactly once, in a layout close to the product mental model.

```text
/
  workeros.workspace.yml
  workspace.base.md
  workspace.md
  workers/
    <worker-id>/
      worker.yml
      run.py
      SKILL.md
      requirements.txt
      lib/
      tests/
  brain/
    <folder>/
      <file>.md
      <file>.txt
      <file>.yaml
      <large-file>.pointer.yml
  .workeros/
    indexes/
      brain-index.yml
      worker-index.yml
    migrations/
      fs-import.yml
      asset-version-import.yml
  .gitattributes
  .gitignore
```

`workeros.workspace.yml` contains non-secret workspace metadata:

```yaml
schema_version: "1"
workspace_id: "ws_..."
name: "Marketing Ops"
created_at: "2026-06-06T00:00:00Z"
default_branch: "main"
source_store: "git"
```

Workers keep the current bundle shape. `worker.yml` remains the manifest source. Any worker metadata needed for browsing that is not already in the manifest lives in manifest fields rather than a parallel DB-only blob. The DB can cache parsed worker fields for fast lists.

Brain files use real folders plus frontmatter. Tags are metadata, not synthetic folders:

```markdown
---
title: "Pricing notes"
tags: ["pricing", "sales"]
owner: "federico"
source: "upload"
updated_at: "2026-06-06T12:00:00Z"
agent_scope:
  workers: ["proposal-writer"]
  retrieval: true
---

# Pricing notes
...
```

For YAML, JSON, CSV, and plain text files where frontmatter is awkward, Workeros can store a sidecar metadata file under `.workeros/indexes/brain-index.yml` keyed by path. Markdown and MDX use frontmatter by default. Existing `.workeros-contexts.json` metadata migrates into frontmatter or the index file.

Large binary pointer file:

```yaml
schema_version: "1"
kind: "workeros.asset_pointer"
path: "brain/contracts/vendor-master.pdf"
mime_type: "application/pdf"
size_bytes: 24839218
sha256: "..."
storage:
  provider: "r2"
  key: "workspaces/ws_.../brain/contracts/vendor-master.pdf"
tags: ["contracts"]
source: "upload"
```

## Write Mechanism

All user and agent writes go through one server-side `WorkspaceSourceStore`:

```text
WorkspaceSourceStore.save_files(workspace_id, paths, base_revision, actor, source)
WorkspaceSourceStore.read_tree(workspace_id, revision)
WorkspaceSourceStore.diff(workspace_id, from_revision, to_revision)
WorkspaceSourceStore.rollback(workspace_id, target_revision, paths)
```

Each save creates a git commit. The UI never exposes git commands; it displays saved state, version history, rollback, and export.

Commit rules:

- One logical product save maps to one commit.
- Commit messages are generated from the product action, for example `Update worker gmail-cleaner` or `Add brain file sales/pricing.md`.
- Commit author records `actor_type` and `actor_id` through the author identity and commit trailers.
- The commit includes `Workeros-Source: user|agent|migration|system` and `Workeros-Request-Id: ...` trailers.
- Secret scanning runs before staging. Writes with likely credentials fail before a commit exists.

Concurrency uses a per-workspace serialized write queue:

1. API receives `base_revision` from the editor or agent task.
2. The write enters the workspace queue.
3. The queue reads the current head.
4. If `base_revision == head`, it applies the patch and commits.
5. If head moved, the queue applies the incoming full-file save onto the new head.
6. Disjoint file edits both commit cleanly.
7. Same-file edits commit in queue order; the later save wins for current head and the earlier content remains in git history.
8. The UI receives the new revision and a normal saved response, with no merge prompt.

This gives deterministic behavior for agent and user edits. The product can add a non-blocking "updated while you were editing" notice later, but v1 keeps merges out of the user workflow.

## Library Recommendation

Use `isomorphic-git` for the git engine.

Verified package facts on 2026-06-06:

- `isomorphic-git` npm version: `1.38.4`, modified `2026-06-02`, MIT license.
- `nodegit` npm version: `0.27.0`, modified `2026-04-23`, MIT license.
- local git CLI version on this machine: `2.43.0`.

Reasons:

- `isomorphic-git` is pure JavaScript and avoids native module builds in Railway, E2B, and local OSS installs.
- Its public docs describe bare repository initialization and Node filesystem support.
- It can fetch, push, create commits, inspect history, and work with existing on-disk git formats.
- `nodegit`/libgit2 brings native dependency and ABI risk into deployment images.
- Shelling to `git` is viable for admin scripts, but it expands command construction, PATH, environment, and sandbox risk in the request path. Keep it as an offline migration fallback only.

Because the API is currently FastAPI/Python, the clean implementation boundary is a small internal `workspace-git` Node service or module with a narrow API. The Python API calls it through an internal queue/HTTP boundary. This keeps git mechanics out of route handlers and avoids Python reimplementations of git behavior.

## Repository Location

### OSS

Default OSS storage:

```text
data/workspaces/<workspace-id>/repo.git
data/workspaces/<workspace-id>/checkout/
```

The bare repo is canonical. The checkout is a disposable working tree or cache used for editor reads, worker discovery, and run materialization. Existing `FLOOM_WORKERS_DIR` and `FLOOM_CONTEXTS_DIR` remain supported during migration and can be imported into the repo.

### Cloud

Railway app filesystem is ephemeral, so the Cloud canonical repo location cannot be the app container filesystem.

Recommended Cloud v1:

- Run a Workeros-owned git storage service with a persistent volume.
- Store one bare repo per workspace under `/var/lib/workeros/git/workspaces/<workspace-id>.git`.
- Keep transient checkouts and per-run materializations on ephemeral disk only.
- Snapshot bare repos to object storage with `git bundle` or packed archive backups after writes.
- Store large binary objects in object storage and commit pointer files.

This beats object-store-backed bare repos for v1 because git expects POSIX-style filesystem semantics, locks, atomic renames, and packfile updates. Object storage remains excellent for backup bundles and binary blobs. A managed git host is valuable as an optional mirror, not the canonical store, because users can operate without connecting GitHub.

## Connect To GitHub

Connect-to-GitHub is an optional mirror, not the primary source of truth in v1.

Flow:

1. User installs the Workeros GitHub App.
2. User selects an existing private repo or lets Workeros create one.
3. Workeros stores installation/repo IDs in the DB; tokens stay in the vault.
4. Workeros pushes the workspace repo to GitHub after successful local commits.
5. GitHub sync status appears as product state: connected, pushing, synced, failed.

What syncs:

- `workers/`
- `brain/` text files and pointer files
- `workspace.base.md`
- `workspace.md`
- `.workeros/` indexes and migration manifests
- `.gitattributes` and `.gitignore`

What never syncs:

- secret values
- run logs
- conversations
- schedules and trigger runtime state
- OAuth tokens or connection credentials
- object-store binary bytes when using pointer mode, unless the workspace explicitly enables Git LFS

v1 is push-only. Later phases can add GitHub import, pull, and branch/PR review flows after conflict policy and secret scanning are proven.

## Large Binaries And Secret Hygiene

Cloud default: object-store-with-pointer.

Reasons:

- It avoids Git LFS account quotas and bandwidth coupling.
- It keeps the canonical repo small.
- It lets Workeros enforce workspace ownership, signed download URLs, retention, and malware/secret scanning before access.
- It mirrors cleanly to GitHub as pointer metadata without leaking bytes.

Git LFS remains an optional OSS/GitHub mirror mode when an operator wants binary bytes in git infrastructure. `.gitattributes` can mark known large extensions for LFS in that mode.

Secret hygiene:

- Pre-commit secret scanning gates every write path.
- Connection config stored in source uses vault references only, for example `secret_ref: "vault://workspace/ws_.../OPENAI_API_KEY"`.
- Pointer files never contain signed URLs or temporary credentials.
- Migration imports run the same scanner before committing. Flagged content is quarantined into a report rather than committed.
- GitHub mirror pushes run a second scan on the outgoing tree.

## Migration Plan

Migration has to preserve both current filesystem source and existing DB entity-version history.

### Phase A: Inventory

Run a read-only inventory for each workspace:

- workers under `WORKERS_DIR`
- context/brain folders under the scoped `CONTEXTS_DIR`
- `workspace.md`
- `workspace.base.md`
- DB `asset_versions` rows for workers, brain packs/files, workspace instructions, and base persona
- DB `skill_versions` rows and current `workers` rows
- large files and binary files
- secret scan findings
- path conflicts and slug conflicts

The inventory writes a report only.

### Phase B: Create Repo

Create the per-workspace repo if absent. Add `workeros.workspace.yml`, `.gitignore`, `.gitattributes`, and empty indexes. Record the repo pointer in the DB:

```text
workspace_source_store.workspace_id
workspace_source_store.repo_location
workspace_source_store.default_branch
workspace_source_store.current_revision
workspace_source_store.migration_state
```

### Phase C: Import DB Version History

Import DB `asset_versions` first, oldest to newest, so git history contains the legacy version timeline.

Mapping:

- worker `asset_versions` rows write `workers/<id>/...` from the snapshot file list
- brain pack rows write `brain/<pack>/...`
- brain file rows write that single file path and preserve deletion commits
- workspace instructions rows write `workspace.md`
- base persona rows write `workspace.base.md`

Each imported commit uses the original `created_at` as author/committer date and includes trailers:

```text
Workeros-Migration: asset_versions
Workeros-Asset-Type: worker
Workeros-Asset-Id: gmail-cleaner
Workeros-Asset-Version-Id: ver_...
Workeros-Asset-Version-Number: 7
```

### Phase D: Import Current Filesystem State

After historical rows, import the current filesystem state. This guarantees the repo head matches what the app currently runs:

- copy current `WORKERS_DIR/<id>` worker bundles into `workers/<id>/`
- copy current scoped contexts into `brain/<folder>/`
- convert `.workeros-contexts.json` metadata to frontmatter or `.workeros/indexes/brain-index.yml`
- copy current `workspace.md` and `workspace.base.md` when present
- create one final `Import current filesystem state` commit

### Phase E: Idempotency

The migration is idempotent through three markers:

- commit trailers for each imported DB version
- `.workeros/migrations/asset-version-import.yml` containing imported version IDs and commit SHAs
- DB `workspace_source_store.migration_state` with the final head SHA

On rerun, the importer checks those markers and skips already imported versions. If the current filesystem changed since the prior run, it creates a new final filesystem-state commit rather than rewriting old history.

### Phase F: Cutover

After verification:

- worker registry reads from the repo checkout/materializer instead of raw `WORKERS_DIR`
- brain APIs read from `brain/` through `WorkspaceSourceStore`
- `workspace.md` and `workspace.base.md` reads come from git head
- existing DB version endpoints can read git history while keeping legacy rows available for audit
- `asset_versions` becomes legacy import data for source assets

No current worker or brain file is deleted during migration. Old filesystem directories can remain read-only until a later cleanup window.

## Runtime DB Coexistence

Git stores authored source. The DB stores runtime and query state.

Remain in DB:

- users, workspaces, membership, roles
- runs, logs, artifacts, approvals, conversations
- schedules, triggers, webhook secrets, Composio trigger IDs
- secret metadata and vault references
- connection metadata
- metrics and monitoring state
- search/retrieval index cache
- current workspace repo pointer and current head SHA
- parsed worker/cache rows for fast list views

Move to git as canonical source:

- worker bundle files
- brain file bytes for text/small files
- brain metadata/tags
- workspace instructions
- base persona
- source history and rollback data for those assets

Run execution records the worker revision SHA used for the run. This pins runs to source history without placing run data in git.

## Rollout

### V1

- Add `WorkspaceSourceStore` and `workspace-git` service.
- Create per-workspace repo layout.
- Implement auto-commit-on-save for workers, brain files, `workspace.md`, and `workspace.base.md`.
- Add secret scanning before commit.
- Add migration inventory and idempotent import.
- Keep existing filesystem paths as fallback in OSS.
- Ship Cloud pilot on a persistent-volume git storage service.
- Keep GitHub mirror out of the critical path.

### V1.1

- Cut Cloud tenant source reads over to git.
- Keep stock workers as source-tree templates and fork edits into workspace repos.
- Store run revision SHA on every run.
- Serve version history from git for source assets.
- Snapshot bare repos to object storage.

### Later

- GitHub push mirror.
- GitHub import and pull.
- Branch/PR workflows for advanced teams.
- Optional Git LFS mode.
- Cleanup of legacy `asset_versions` source snapshots after an audit window.

Rollout order: OSS local foundation first, Cloud pilot second, Cloud cutover third, GitHub mirror fourth. That order proves the source abstraction against the current filesystem-heavy code before making Cloud dependent on it.

## Recommendation

Use git as the canonical source store for workspace-authored files. Keep the DB for runtime state. Implement the git engine with `isomorphic-git`, store Cloud repos as Workeros-owned bare repos on a persistent volume with object-store backups, use object-store pointer files for large binaries, migrate legacy DB versions into commit history before importing current filesystem state, and roll out OSS foundation before Cloud cutover.

## Sources Read

- Issue #488: https://github.com/floomhq/workeros/issues/488
- PR #479: https://github.com/floomhq/workeros/pull/479
- isomorphic-git init docs: https://isomorphic-git.org/docs/en/init.html
- isomorphic-git project docs: https://isomorphic-git.org/en/
