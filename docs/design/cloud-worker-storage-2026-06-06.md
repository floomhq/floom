# Cloud Worker Storage Design

Date: 2026-06-06

## Summary

Use a hybrid durable worker store:

- Database rows own worker identity, workspace scope, manifest metadata, version lineage, and the canonical file manifest.
- Object storage owns bundle file bytes for Cloud deployments.
- A runtime materializer writes a per-run bundle copy into local/E2B staging only when a worker is edited, inspected, or run.
- The OSS single-tenant path keeps the existing filesystem store by default and can opt into the same durable store later.

This fixes the gap recorded in `docs/design/worker-push-fix-2026-06-06.md`: the worker-push P0 fix made current filesystem writes atomic and recoverable, but it explicitly left `WORKERS_DIR/<id>` non-workspace-scoped and ephemeral on Cloud/Railway.

## Current Facts From Mainline

- `apps/api/worker_registry.py` discovers workers by scanning `WORKERS_DIR` and uses folder names as worker IDs.
- Create/edit/delete paths write bundles under `WORKERS_DIR/<id>`.
- `workers.id` is a global primary key in SQLite, while later migrations add `workspace_id` and `visibility`.
- `skill_versions.bundle_path` stores filesystem paths or relative `workers/<id>` paths.
- Runner paths resolve `runtime.bundle_path` or `WORKERS_DIR/<id>` and then copy/upload that directory for local/E2B execution.
- Protected stock workers are enforced by `PROTECTED_STOCK_WORKER_IDS`; worker-push P0 added fork-on-write and clone-on-edit so stock templates remain read-only.

## Storage Options

### Option A: Database-Backed Worker Source And Bundles

Store every worker file as rows:

- `worker_bundles`: bundle/version metadata, manifest JSON, content hash, size, created actor.
- `worker_bundle_files`: one row per file path with text/blob content.

Advantages:

- One transactional store for metadata and bytes.
- Easy backups and point-in-time rollback when the database supports it.
- No object storage dependency for small bundles.

Tradeoffs:

- Large files, generated assets, vendored dependencies, and binary worker resources bloat the relational database.
- Editing a single file can write large row payloads through the API database.
- E2B/local runners still need a filesystem materialization step.

Fit: acceptable for early small text-only workers, poor as the default Cloud storage contract.

### Option B: Object-Storage-Backed Bundles

Store bundle bytes only in S3/R2/Supabase Storage and keep existing database rows as pointers.

Advantages:

- Cheap, durable storage for arbitrary bundle sizes and binary files.
- Content-addressed paths make dedupe and integrity checks simple.
- Runners download a zip/tarball directly into staging.

Tradeoffs:

- Metadata queries still require database rows.
- Updates need two-phase coordination between DB and object storage.
- Listing/editing individual files requires fetching and unpacking the object, or maintaining an index elsewhere.

Fit: strong for immutable run bundles, incomplete for source editing and worker list/detail without a DB file index.

### Option C: Hybrid Database Index Plus Object Storage Bytes

Store identity, workspace scope, manifest JSON, file index, versions, hashes, and active bundle references in the database. Store the canonical bundle archive and optional large file bodies in object storage.

Recommended schema shape:

- `workers.worker_key`: internal stable UUID primary key.
- `workers.workspace_id`: active workspace scope.
- `workers.id`: external worker slug shown in URLs and API responses.
- Unique constraint: `(workspace_id, id)`.
- `worker_versions.version_key`: immutable version UUID.
- `worker_versions.worker_key`: parent worker.
- `worker_versions.manifest_json`: parsed manifest snapshot.
- `worker_versions.files_json`: ordered file index with path, kind, size, sha256, storage key, and optional inline text for small files.
- `worker_versions.bundle_storage_key`: canonical zip/tar object key for the full bundle.
- `worker_versions.content_sha256`: hash over normalized file paths and bytes.
- `workers.active_version_key`: current editable version pointer.

Object key format:

```text
workspaces/{workspace_id}/workers/{worker_key}/versions/{version_key}/bundle.tar.zst
workspaces/{workspace_id}/workers/{worker_key}/versions/{version_key}/files/{sha256}
```

Advantages:

- Workspace slug collisions are resolved at the database boundary.
- Worker detail/edit screens read from the DB file index and only fetch bytes when needed.
- Runners receive immutable bundles by version key, giving reproducible run snapshots.
- Large and binary files stay out of relational rows.
- The API can transact metadata first, then promote object storage bytes with a clear pending/active state.

Tradeoffs:

- More moving parts than the current filesystem store.
- Requires garbage collection for unreferenced objects.
- Requires a materializer layer for current runner code that expects directories.

Recommendation: use Option C for Cloud. It gives durable multi-tenant storage without making the database a blob store, while keeping the runner interface stable through materialization.

## Per-Workspace ID Scoping

External APIs keep the existing worker slug contract:

- `GET /workers/{id}`
- `PUT /workers/{id}/files`
- `POST /workers/{id}/runs`
- MCP worker tools that pass `id`

Every request resolves the active workspace from Cloud auth or `x-workeros-workspace`. Repository lookups use `(workspace_id, id)` and return the internal `worker_key`. The response still exposes `id` as the workspace-local slug.

Rules:

- Two workspaces can both own `id = "gmail-cleaner"` because uniqueness is `(workspace_id, id)`.
- A single workspace cannot have two active workers with the same slug.
- Run creation stores `worker_key`, `workspace_id`, and the display `worker_id` snapshot. This keeps history stable if the slug changes later.
- Triggers, alerts, MCP tools, approvals, versions, and artifact ownership reference `worker_key` internally.
- Existing API paths never accept a cross-workspace worker by slug alone.

SQLite migration can preserve compatibility by adding `worker_key TEXT` and backfilling it from `id` for local databases, then gradually moving new FKs to `worker_key`. Cloud can enforce the new shape first because it already has workspace-aware auth.

## Built-In And Protected Stock Workers

Stock workers remain filesystem-backed templates in the source tree:

- `workers/<stock_id>/worker.yml`
- `workers/<stock_id>/run.py` or `SKILL.md`
- `PROTECTED_STOCK_WORKER_IDS`
- `PUBLIC_STOCK_WORKER_IDS`

They are not tenant data. They are product templates shipped with the app.

Cloud boot loads stock workers into a read-only catalog view:

- `stock_worker_id`
- manifest metadata
- source bundle path in the deployed image
- `protected = true`
- optional `template_version`

The catalog is separate from tenant `workers` rows. Listing workers merges:

1. User/workspace workers from the durable store.
2. Stock templates from the catalog, marked read-only/example/system according to existing flags.

Mutation behavior keeps the worker-push P0 decisions:

- Direct mutation of `PROTECTED_STOCK_WORKER_IDS` is rejected.
- First edit or raw create against a protected ID forks into a workspace-owned copy.
- The copy gets a free slug inside that workspace, for example `gmail-inbox-manager-copy`.
- The copied bundle is written to durable Cloud storage, not back to the source tree.
- The source stock worker files remain immutable and shared across deployments.

This preserves stock worker availability after redeploy while making all tenant-owned copies durable.

## Runtime Materialization

Current runner code expects a local directory. Keep that interface behind a storage abstraction:

```text
WorkerSourceStore.get_active_bundle(workspace_id, worker_id) -> WorkerBundleRef
WorkerSourceStore.get_version_bundle(version_key) -> WorkerBundleRef
WorkerBundleMaterializer.materialize(ref, target_dir) -> Path
```

Cloud behavior:

- Resolve `(workspace_id, worker_id)` to `worker_key` and `active_version_key`.
- Download the immutable bundle archive by `bundle_storage_key`.
- Verify `content_sha256`.
- Extract into a per-run staging directory under the DB/data volume or the E2B upload temp root.
- Run local/E2B code against that directory.
- Store the run's `version_key` and optional materialized snapshot path for debugging.

OSS default behavior:

- `FilesystemWorkerSourceStore` continues to return `WORKERS_DIR/<id>`.
- No object storage is required.
- Existing `FLOOM_WORKERS_DIR` installs keep working.

## Migration Path From The Current Filesystem Store

### Phase 0: Read-Only Inventory

Add an inventory command that scans `WORKERS_DIR` and reports:

- worker ID
- inferred workspace/owner row
- protected stock status
- manifest parse status
- file count and total size
- target durable storage key
- collision status under `(workspace_id, id)`

No writes happen in this phase.

### Phase 1: Dual-Read Store Interface

Introduce `WorkerSourceStore` behind worker registry/detail/edit/run code.

Resolution order:

1. Durable DB/object store for tenant workers.
2. Stock catalog for protected/public stock workers.
3. Filesystem fallback for OSS and pre-migration local workers.

This phase changes call sites but does not migrate data.

### Phase 2: Backfill Tenant Workers

For every non-stock filesystem worker with a DB owner/workspace:

- Create `worker_key`.
- Preserve external `id`.
- Create `worker_versions` row.
- Upload bundle archive to object storage in Cloud.
- Store file index and hashes.
- Set `workers.active_version_key`.
- Mark source as `durable`.

Collision handling:

- Same `(workspace_id, id)` is a hard conflict requiring operator choice.
- Same `id` in different workspaces imports cleanly.
- Filesystem-only workers with no DB row import into `local-default` for OSS or into an admin-selected workspace for Cloud.

### Phase 3: Dual-Write Create/Edit

Create and edit paths write durable storage first for tenant workers. Filesystem writes remain for OSS fallback only.

Cloud transaction model:

1. Validate worker manifest and file paths.
2. Write object storage bundle/files under a temporary object prefix.
3. Insert immutable `worker_versions` row with `state = "pending"`.
4. Update `workers.active_version_key` in the same DB transaction.
5. Promote object prefix or mark version active.
6. Schedule GC for abandoned pending objects.

If DB commit fails, objects remain under a pending prefix and GC removes them. If object upload fails, no DB active pointer changes.

### Phase 4: Cloud Filesystem Read Removal

Cloud stops reading tenant workers from `WORKERS_DIR`. That directory only supplies stock templates. Health checks fail Cloud startup if durable storage is unavailable.

OSS keeps filesystem reads/writes as the default path.

### Phase 5: Internal Key Migration

Move downstream references from `worker_id` to `worker_key`:

- runs
- approvals
- triggers
- worker alerts
- MCP custom tools
- versions
- run bundle snapshots

Keep `worker_id` as denormalized display history on rows where it helps debugging and API responses.

## OSS Single-Tenant Behavior

The open-source local install remains simple:

- Default store: `FilesystemWorkerSourceStore`.
- Default path: `FLOOM_WORKERS_DIR` or `../../workers`.
- Default workspace: `local-default`.
- Existing worker folders keep working without object storage.
- Existing runner code receives a local directory.
- The durable store is optional and enabled by configuration, for example `WORKEROS_WORKER_STORE=durable`.

Local SQLite can add `worker_key` and `(workspace_id, id)` columns/indexes without forcing object storage. For local single-tenant databases, backfill `worker_key = id` or a deterministic UUID and keep `workspace_id = local-default`.

## Rollout Plan

1. **Design and schema PR**: land this design, then a schema-only migration adding internal keys and durable version tables.
2. **Store abstraction PR**: add `WorkerSourceStore` and materializer with the filesystem implementation as the default.
3. **Cloud durable write PR**: implement DB plus object storage writes for create/edit while keeping dual-read fallback.
4. **Backfill and audit PR**: add inventory/backfill CLI, dry-run reports, and Cloud import playbook.
5. **Runner version pin PR**: make runs persist `version_key` and materialize immutable bundles.
6. **Cloud cutover PR**: disable tenant filesystem fallback in Cloud and leave only stock catalog reads from the deployed source tree.
7. **Cleanup PR**: migrate remaining FK-like references to `worker_key`, remove Cloud-only dead fallback paths, and keep OSS filesystem mode intact.

## Risks And Controls

- **Object storage and DB consistency**: use pending object prefixes, active DB pointers, and GC for unreferenced pending objects.
- **Slug collision during migration**: enforce `(workspace_id, id)` uniqueness and produce an operator-visible conflict report before writes.
- **Runner drift**: persist `version_key` on each run and materialize immutable version bundles, not mutable active workers.
- **Stock worker mutation regression**: keep `PROTECTED_STOCK_WORKER_IDS` checks in front of every write path and test clone-on-edit/create fork behavior against durable storage.
- **Large bundle abuse**: keep upload entry count, file size, total size, and path traversal guards before object upload.
- **Cloud cold-start latency**: cache materialized bundles by `version_key` on the ephemeral volume with hash verification; cache misses still download from durable storage.
- **OSS regression**: keep filesystem store as the default implementation and run existing worker-push P0 tests against it.
- **Partial migration visibility bugs**: dual-read order gives durable tenant rows priority and stock catalog fallback only for protected/public template IDs.

## Recommended Approach

Adopt the hybrid database index plus object storage bundle model for Cloud. Introduce an internal `worker_key` and make `id` a workspace-local slug with a `(workspace_id, id)` unique constraint. Keep stock workers as read-only filesystem templates and fork edits into durable workspace-owned copies. Preserve the OSS single-tenant filesystem store as the default. Roll out through dual-read, backfill, dual-write, Cloud cutover, and internal FK migration phases.
