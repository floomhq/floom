# FL1 Visibility Fix - 2026-06-07

## Root Cause

Federico's worker data was intact. The live SQLite DB at `/root/workeros/data/floom.db` contained:

- 100 total worker rows
- 99 rows with `owner_id='federico'`
- 100 rows with `visibility='private'`
- 88 rows with `workspace_id='local-default'`
- 12 rows with an empty `workspace_id`

The UI-visible API path was wrong in two places:

- New login sessions use UUID user IDs, while the legacy OSS worker rows are owned by the literal engine owner `federico`.
- `_list_visible_workers` applied filesystem/internal hiding rules to DB-owned worker rows. That suppressed private workers whose IDs matched tracked or internal filesystem worker IDs, even though the DB row was Federico-owned data.

## Fix

- Added a worker-specific owner resolver in `apps/api/main.py`.
- The resolver maps a local authenticated username back to the legacy `local-default` owner when `workspace_members` or `local_workspaces` proves that username owns the default workspace.
- Kept auth identity unchanged for account routes.
- Changed `_list_visible_workers` so DB-owned rows are not hidden by filesystem fallback filters. The hidden filter still applies to filesystem fallback discovery.
- Added regression tests for:
  - `x-floom-secret` access to legacy private workers.
  - Empty-workspace legacy worker rows.
  - DB-owned workers with internal-style IDs such as `smoke-*`.
  - Federico session login mapping back to the legacy worker owner.

## Verification

Focused backend suite:

```text
pytest apps/api/tests/test_local_workspaces.py apps/api/tests/test_multi_member.py apps/api/tests/db/test_workspace_members_and_visibility.py apps/api/tests/db/test_sqlite_workers.py
46 passed in 72.36s
```

Live FastAPI route verification against `/root/workeros/data/floom.db`:

```text
secret_status 200
secret_total 100
secret_federico_private 99
secret_owner_permissions 99
secret_detail_status 200
secret_detail_owner federico
secret_detail_is_owner True

session_status 200
session_total 100
session_federico_private 99
session_owner_permissions 99
session_detail_status 200
session_detail_owner federico
session_detail_is_owner True
```

Post-verification worker row counts remained unchanged:

```text
100 total / 99 federico / 100 private / 88 local-default / 12 empty workspace
```

## PR

PR: pending

Note for Vivek / `itachi-hue`: this touches the role-aware worker visibility path from the multi-member work. The patch keeps the new role-aware model intact while restoring legacy OSS owner mapping for Federico's local-default private workers.
