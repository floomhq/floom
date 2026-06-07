# Backend hardening + consistency — `/runs/clear` + `/contexts` worker_count (2026-05-29)

Branch: `fix/runsclear-hardening-and-worker-count-2026-05-29`

Two backend fixes for Workeros OS (`/root/workeros`, prod API https://workers-api.floom.dev).

## FIX 1 — `/runs/clear` post-incident hardening

### Incident
A referee agent called `POST /runs/clear?confirm=yes-wipe-all-runs` against the
prod API (`:8011`) believing it was local dev, and irreversibly wiped 593
runs/logs/artifacts. The only protection was the `?confirm=` query gate.

### Change (`apps/api/main.py`)
- **Auto-backup before wipe** (`_backup_db_before_clear`): snapshots the live
  DB to `/root/backups/manual/floom-preclear-<epoch>.db` using SQLite
  `VACUUM INTO` — atomic, WAL-consistent, single-file (no `-wal`/`-shm`
  sidecar). The live DB path is resolved via `PRAGMA database_list` (the
  connection actually in use), not a possibly-stale module global. Backup
  directory is overridable via `WORKEROS_PRECLEAR_BACKUP_DIR` (defaults to the
  prod path) so tests never touch `/root/backups/manual`.
- **Abort on backup failure**: if the snapshot raises, or the resulting file is
  missing/empty, the endpoint returns HTTP 500 and deletes nothing. Never wipe
  without a verified backup.
- **Owner-scoped delete**: the underlying `RunsRepository.clear_all(user_id=...)`
  already deletes only `WHERE w.owner_id = ?` (via `list_all_ids`), so a single
  call can never nuke another tenant's runs. Made explicit in docstring + log.
- **Response**: `{status, cleared_count, deleted_runs (back-compat alias),
  backup_path}`.

The incident class is now closed in code (recoverable + scoped), not just by
agent-brief guardrails.

## FIX 2 — `/contexts` LIST `worker_count` consistency

### Bug
`_context_summary` hardcoded `worker_count=0`, so the `/contexts` LIST row
showed "0 workers" even when a worker referenced the pack. The DETAIL path
(`_context_detail`) correctly computed `used_by` and set
`worker_count = len(used_by)`. List and detail disagreed.

Live confirmation on `:8011` (pre-fix):
- `GET /contexts` → `worker-author-style` `worker_count = 0`
- `GET /contexts/worker-author-style` → `worker_count = 1`, `used_by = [Worker Author]`

### Change (`apps/api/main.py`)
- New `_context_worker_counts(repos, user_id)` builds a `pack_name -> count` map
  from a SINGLE `repos.workers.list()` call (O(workers), not O(packs*workers)),
  from the same `context_mount_names(config.contexts)` source the detail path
  uses.
- `list_contexts` now depends on `repos` and passes each pack's count into
  `_context_summary(..., worker_count=...)`.

List `worker_count` now equals detail `worker_count`/`used_by` length.

## Tests
- `tests/test_runs_clear_hardening.py` (new, 3/3): backup-before-delete +
  owner-scope + abort-on-backup-fail.
- `tests/test_round8_worker_authz.py::test_runs_clear_only_deletes_owner_history`:
  extended to assert the backup + `cleared_count` contract.
- `apps/api/tests/test_contexts_system_packs.py::test_list_worker_count_matches_detail`
  (new): list == detail == 1 after a worker mounts the pack.

## Verification
- Did NOT exercise a real prod wipe; the 595 prod runs are untouched.
- Pre-existing unrelated failures (`test_stock_worker_detail_omits_sensitive_fields`,
  `tests/test_api_endpoints.py` DeleteWorker/SSE/Approval) confirmed failing on
  `origin/main` as well — not introduced by this change.
- Live `/contexts` curl proof appended after deploy.
