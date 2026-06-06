# Worker Push P0 Fix Design

Date: 2026-06-06

## Scope

Fix the worker push/create path failures documented in `docs/worker-push-p0-brief.md`:

- protected stock-name push failure
- non-atomic create leaving filesystem orphans
- ghost worker recovery and slug divergence
- missing or invalid workspace write context returning a server error

This pass keeps the current filesystem-backed worker store and SQLite repository model. It does not migrate workers into workspace-scoped storage.

## Failure #1 Decision: Fork On Write

Use fork-on-write for raw `POST /workers` payloads whose manifest ID is protected stock worker ID such as `gmail_inbox_manager`.

Behavior:

- The request is accepted.
- The protected ID is not modified on disk.
- The new worker receives a free user-owned ID based on the protected name: `_slugify_worker_id(stock_id) + "-copy"`, deduped by `_free_worker_id`.
- The manifest identity is rewritten to the new ID.
- `is_example` is forced to `false`.
- The response returns the new worker detail, so the caller can continue with the created worker ID.

Rationale:

- This lets an operator ship a customized Gmail worker without needing a second request or a reserved-name error.
- It matches the existing `PUT /workers/{id}/files` clone-on-edit behavior, keeping stock templates read-only while giving the user an editable worker.
- A clear 409/422 reserved-name response would protect stock templates, but it would still block the real push path from shipping the customized worker.

## Atomic Create

Create writes use a staging directory under `WORKERS_DIR` and commit only after the full create transaction succeeds.

Required properties:

- All paths are written under the staging directory first.
- The canonical worker ID is computed before collision checks.
- Existing target directory or existing DB row returns 409 before commit.
- DB rows are persisted only after the staged bundle has passed parse and discovery.
- On any exception, the staging directory is removed and any partial DB rows for the new worker are deleted.
- The target directory appears only after successful DB persist and detail build.

This fixes the "500 but worker exists" orphan state.

## Canonical IDs And Orphan Recovery

All create, get, and delete paths canonicalize request IDs with `_slugify_worker_id`, while preserving known protected stock IDs exactly. This makes `fede-gmail-cleaner` and `fede_gmail_cleaner` resolve to the same canonical worker ID.

Delete gains orphan reaping:

- If the worker has a DB row, delete follows the existing DB cleanup path and removes the bundle directory when unreferenced.
- If no DB row exists but `WORKERS_DIR/<canonical_id>` exists and is not protected, delete removes that directory and invalidates the worker cache.
- Protected stock directories remain non-deletable.

## Workspace Write Validation

Writes that create, update, or delete workers require a valid local workspace context when local workspace scoping is active. Missing or invalid `x-workeros-workspace` / `workspace_id` returns a clean 400 with an actionable message.

The default `local-default` workspace remains valid when explicitly provided. Read paths can continue to use existing fallback behavior.

## Follow-Up Gap

The worker store remains filesystem-backed at `WORKERS_DIR/<id>` and is not workspace-scoped on disk. Two workspaces with the same worker ID still collide in the filesystem and the current Cloud/Railway filesystem is ephemeral across redeploys. This P0 fix makes the current single-tenant OS push path atomic and recoverable, but durable multi-tenant worker storage needs a separate design.
