# Cloud Worker & Workspace Storage Model (CANONICAL — read before touching cloud workers)

> Written 2026-06-15 after NovaSearch-v4 was repeatedly mis-deployed by registering it with a
> hardcoded disk `bundle_path` + no `_files`, pinning it to one machine. This documents the
> EXISTING, intended system so that never recurs.

## TL;DR — cloud workers are PORTABLE; they live in Supabase, NOT on any one machine's disk
A cloud worker's code is stored in **Supabase** — either inline in `skill_versions.manifest_json._files`
(original) or in the **`worker-bundles` Storage bucket** with a `_files_in_storage: true` marker in the
manifest (see "Bundle offload" below). At run time, whichever executor picks up the run (Railway prod,
the AX41 dev mirror, any host) materializes the files to its local `FLOOM_WORKERS_DIR` via
`_materialize_worker_files()` and runs them. This is why a worker runs anywhere, survives Railway
container restarts, and is multi-drainer-safe. **The portability invariant is unchanged** — only the
storage location of the bytes moved; every executor still materializes from Supabase.

## Bundle offload to Storage (2026-06-24) — why the workers list got fast
Inlining `_files` into `manifest_json` made that metadata column multi-MB for code-heavy workers
(novasearch/reltix ~1.2 MB each), so `GET /workers` (a `select(*)` on `skill_versions`) downloaded
~18 MB of bundle code the grid never shows — ~9 s. Fix: store the bundle in the **`worker-bundles`**
Storage bucket (`{skill_version_id}/files.json`), leave a tiny `_files_in_storage` marker +
`runtime.bundle_sha256` in the manifest, so the list transfers metadata only (~0.3 MB).

- **Write** (`supabase_repos._offload_bundle_files`): on create/update/disk-sync, `_files` is uploaded
  to Storage and the manifest stored lean. **Gated by `WORKEROS_BUNDLE_OFFLOAD` (default OFF).**
- **Read** (`get_recipe` / `get`): if `_files_in_storage` is set, the bundle is fetched from Storage and
  materialized to disk exactly as inline `_files` was. **Always active** (no-op without the marker), so
  any executor on this code runs both inline and offloaded workers.
- **Backfill**: `ops/backfill_worker_bundles.py` migrates existing inline `_files` to Storage.

### CUTOVER ORDER IS MANDATORY (else you reproduce the NovaSearch-v4 outage)
A worker whose `_files` is offloaded is `worker_not_found` on any executor WITHOUT this code. So:
1. Deploy this code to **every** executor on this Supabase (Railway `workeros-cloud-api` +
   `workeros-cloud-worker`, the AX41 mirror, local `:8002`). Default flag OFF → zero behaviour change.
2. Confirm all executors are updated.
3. Run `ops/backfill_worker_bundles.py` (the read path everywhere can now hydrate from Storage).
4. Set `WORKEROS_BUNDLE_OFFLOAD=1` so new writes also stay lean.
Rollback: unset the flag; re-inline by re-running the worker's normal write path, or restore `_files`
from the Storage `files.json`. Full runbook: `docs/RUNBOOK-bundle-offload-cutover.md`.

**NEVER register a worker with an absolute disk `bundle_path` (e.g. `/opt/workeros-cloud-deploy/engine/workers/X`)
or with an empty `_files`.** That pins the worker to one machine — every other executor gets
`worker_not_found` / "can't find workers". (This is the exact bug that broke NovaSearch-v4:
`bundle_path=/opt/.../novasearch-v4`, `_files` empty → only AX41 could run it; Railway + Vivek's box failed it.)

## Hosting (do not confuse — see also reference-workeros-cloud-railway-oss-ax41)
- `workeros.floom.dev` = CLOUD = **Railway** backend (`api-production-b866.up.railway.app`, manual `railway up`, token `/root/.config/railway-token`) + **Vercel** frontend.
- `workers.floom.dev` = OSS = **AX41** (`workeros-api` :8011).
- AX41 `workeros-cloud-api` :8030 = DEV mirror only (NOT prod).

## The four pieces
1. **Worker code → Supabase `_files`.** `_cloud_persist_worker_files(worker_id, files, repos)`
   (`apps/api/main.py`) writes file contents into `skill_versions.manifest_json._files`.
   Limits (`_sanitize_cloud_worker_files` / supabase_repos): ≤200 files, ≤5MB total, ≤1MB/file.
   `bundle_path` is the **relative** `workers/{worker_id}`. Triggered by the standard worker
   create/update path: `POST /workers/draft-and-create`, `POST /workers/new/from-prompt`,
   **`PUT /workers/{worker_id}/files`**, etc. (each calls `_read_worker_files_from_disk` then
   `_cloud_persist_worker_files`).
2. **Runtime materialization.** Any executor calls `_materialize_worker_files()` (engine) to write
   `_files` → its `FLOOM_WORKERS_DIR` before running. Executor-agnostic by design.
3. **Workspace git tracking.** Each workspace is an isolated git repo (`apps/api/cloud_git_local.py`)
   on the server disk, backed up to Supabase Storage bucket `workeros-git-bundles/{workspace_id}/repo.bundle`
   (restored on cold start / server wipe). With GitHub connected, `commit_workspace` →
   `cloud_git.schedule_push`. See `docs/GIT-WORKSPACE-CLOUD.md`.
4. **Brain / contexts → Supabase Storage.** `apps/api/cloud_contexts.py`, bucket
   `contexts/{workspace_id}/{context_name}/{rel_path}`. Uploaded on write, downloaded on read.
   **Large data (>1MB/file — e.g. candidate DBs) lives HERE, not in `_files`.** The worker's
   `run.py` loads it from `context/{pack}/...`.

## How to add ANY worker (incl. a complex code worker like NovaSearch) — the STANDARD way
1. Create/update through the normal API so the code lands in `_files`:
   `PUT /workers/{worker_id}/files` (with run.py + lib/*.py + worker.yml) — or the draft/create flow.
   Do **NOT** hand-insert `skill_versions` rows with a disk `bundle_path`.
2. Put large data in the **brain** (a context pack); have `run.py` read it from `context/{pack}/...`.
3. Result: portable across Railway/AX41, survives restarts, no multi-drainer breakage.

## Anti-patterns that MUST never recur
- ❌ `bundle_path` = absolute machine path. Use the relative `workers/{id}`.
- ❌ `_files` empty for a cloud/user worker.
- ❌ Bootstrap/seed scripts that register a worker by disk path instead of the standard create/`PUT /files` flow.
- ❌ Bundling large data (candidate DBs, >1MB files) into the worker instead of the brain.
- ❌ "Deploy the worker to Railway" / committing a user worker into the engine repo. A worker is a
  workspace row + `_files` + brain — NOT a platform/Docker change.
