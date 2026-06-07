# Multi-Member Parity Verification - 2026-06-07

## Scope

Wave 2 P0 asked for live OSS API parity for PR #491 multi-member routes on `workers-api.floom.dev`, role-isolation proof, FL1 regression proof, cleanup of throwaway users/workers, and GitHub issue updates only after live evidence.

## Root Cause

The multi-member code was present on `origin/main`, but the live service was not serving the current deployed source until the OSS backend deploy path synced `/opt/workeros-api-deploy` from `origin/main`.

After deploying the code, the remaining role-isolation failure was configuration, not Vivek-owned feature code:

- `workeros-api` runs from `/opt/workeros-api-deploy/apps/api`.
- The service was in `WORKEROS_DEPLOY=local` with `FLOOM_WORKERS_DIR=/root/workeros/workers`.
- `_list_visible_workers()` and `_get_visible_worker()` correctly filtered SQLite rows by role, but then local shared-filesystem fallback re-added bundles from the shared worker directory.
- That fallback exposed admin-private filesystem bundles to member sessions/PATs even though the DB repository layer denied them.

## Fix

Code deployed:

- `origin/main` SHA: `9f2c9cec171f0027e03c7a204179f57d3e447302`
- Hotfix included wrong shared-secret responses returning HTTP 401.
- Deploy command used the OSS deploy script:
  `WORKEROS_ROOT=/opt/workeros-api-deploy FLOOM_DB=/root/workeros/data/floom.db WORKEROS_DB=/root/workeros/data/floom.db WORKEROS_API_VENV=/root/workeros/apps/api/venv /opt/workeros-api-deploy/ops/deploy-api.sh`

Config deployed:

- Added `/etc/systemd/system/workeros-api.service.d/user-scope.conf`
- Contents: `Environment=WORKEROS_ENABLE_USER_HEADER_SCOPE=1`
- Reloaded systemd and restarted through the deploy script.

Live process proof:

- `systemctl show workeros-api`: active/running, PID `1482361`
- `/proc/<pid>/environ`: `WORKEROS_ENABLE_USER_HEADER_SCOPE=1`
- `GET http://127.0.0.1:8011/health`: `status=ok`
- `GET https://workers-api.floom.dev/healthz`: HTTP 200

Deploy proof:

- DB backup: `/root/backups/manual/floom-predeploy-1780810184.db`
- Health gate: passed
- Schema drift gate: passed, migration version 59
- Hard post-deploy smoke gate: passed

## Live Route Matrix

Sanitized evidence file: `/tmp/multimember-live-matrix.json`

Run id: `78ffb9b4`

All matrix checks passed:

- Missing public auth: HTTP 401
- Wrong public auth: HTTP 401
- Valid secret/admin list: HTTP 200, 86 default visible workers
- Admin setup/session `/auth/me`: HTTP 201 / HTTP 200
- Admin created member: HTTP 201
- Member login/session `/auth/me`: HTTP 200 / HTTP 200
- Admin PAT `/auth/me`: HTTP 200, role `admin`
- Member PAT `/auth/me`: HTTP 200, role `member`
- Admin created private, workspace, webhook, and schedule workers: HTTP 200
- Admin shared workspace worker: HTTP 200, visibility `workspace`
- Member created own worker: HTTP 200
- Member list excludes admin private worker: not in list
- Member list includes shared worker: in list
- Member list includes own worker: in list
- Member list excludes private webhook worker: not in list
- Member list excludes private schedule worker: not in list
- Member session get private: HTTP 404
- Member session patch private: HTTP 404
- Member session run private: HTTP 404
- Member session rotate private webhook: HTTP 404
- Member session get private schedule: HTTP 404
- Member PAT get private: HTTP 404
- Member PAT run private: HTTP 404
- Admin session gets private: HTTP 200
- Admin PAT users list: HTTP 200
- Member PAT users list denied: HTTP 403
- Admin webhook secret rotation: HTTP 200
- Webhook bad token rejected: HTTP 401

Frontend proxy proof for issue #528:

- `GET https://workers.floom.dev/api/auth/setup`: HTTP 200, `{"required":true}`

## FL1 Regression

FL1 still holds after multi-member deployment and scoped filesystem fallback:

- Live default list with valid secret: HTTP 200, `default_federico_private=85`
- Live complete list with valid secret and `include_system=true&include_archived=true`: HTTP 200, `federico_private=99`, `owner_perms=99`
- Direct SQLite verification after cleanup: `federico_private=99`

The default list intentionally excludes system and archived workers. The complete query proves the 99 legacy private rows remain visible to Federico's legacy owner session.

## Cleanup

Throwaway probe data was removed and verified:

- `users=0`
- `mm_workers=0`
- `mm_triggers=0`
- `mm_skills=0`
- Temp worker directories removed: 5

Direct post-cleanup DB check:

- `users=0`
- `mm_workers=0`
- `mm_triggers=0`
- `mm_skills=0`
- `federico_private=99`

## GitHub Issue Status

Closed with live proof:

- #525 - multi-member auth surface live and role matrix passed.
- #528 - OSS `/api/auth/setup` frontend proxy route returns HTTP 200.

Left open:

- #526 - seven-day run failure rate was not part of this verified fix.
- #527 - encoded CRLF alert webhook validation was not part of this verified fix.
- #529 - still reproduces: live private worker summaries still include `public_link`.
- #530 - no issue or PR with number 530 exists in `floomhq/workeros`.
- #531 - already closed before this task.

