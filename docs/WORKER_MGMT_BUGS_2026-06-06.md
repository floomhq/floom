# Worker Management Bugs - 2026-06-06

## Summary

Two production-facing issues were verified and fixed on branch `fix/worker-mgmt-bugs`.

- Worker ID path parameters now canonicalize slug-equivalent values before worker detail, patch update, visibility update, archive/restore, file update, run creation, and delete lookups. The assistant's direct worker get/update/run tools use the same canonicalization.
- Scheduled workers now compute configured/default inputs before firing. If required scheduled inputs are still missing, the scheduler advances the schedule and logs a warning instead of creating another failed run.
- `workers/slack-listener` no longer requires `channel` as a scheduled input. It resolves `SLACK_LISTENER_CHANNEL_ID`, `SLACK_CHANNEL_ID`, or `SLACK_DEFAULT_CHANNEL`, and exits with a successful skipped summary when no channel is configured.

## PR #465 Overlap

PR #465 (`fix/worker-push-p0`, commit `1c63e47`) overlaps the worker ID bug. It adds `_canonical_worker_id()` and applies it to `GET /workers/{id}`, `PATCH /workers/{id}`, `PUT /workers/{id}/visibility`, and `DELETE /workers/{id}`. It also adds orphan bundle deletion behavior.

Determination: PR #465 fixes the canonical path-ID lookup part of the reported worker-management bug, but it does not fix the Slack Listener scheduled-input failure. This branch keeps the canonical lookup fix local to `origin/main` and adds regression coverage for GET/PATCH/visibility/DELETE resolving the same worker ID shown by list.

## Live Slack Listener Disable

Live API process inspected:

- PID: `3586260`
- Command: `/root/workeros/apps/api/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8011 --timeout-graceful-shutdown 85`
- DB from process env: `/root/workeros/data/floom.db`

Before mitigation:

- `workers.id='slack-listener'`
- `workers.enabled=1`
- `workers.trigger_type='schedule'`
- `workers.cron_expr='*/10 * * * *'`
- `worker_triggers.id='trg_slack-listener_0'`
- `worker_triggers.enabled=1`

Initial DB-only mitigation was re-persisted by the running API from the live worker manifest. Durable mitigation applied:

- Added `paused: true` to `/root/workeros/workers/slack-listener/worker.yml`.
- Set `workers.enabled=0` and `workers.next_run_at=NULL`.
- Set `worker_triggers.enabled=0` and `worker_triggers.next_run_at=NULL`.
- Set the stored `skill_versions.manifest_json` to `paused=true`, `enabled=false`, and `exec.inputs[channel].required=false`.

```sql
UPDATE workers
SET enabled = 0, next_run_at = NULL
WHERE id = 'slack-listener';

UPDATE worker_triggers
SET enabled = 0, next_run_at = NULL, updated_at = datetime('now')
WHERE worker_id = 'slack-listener';
```

Verified status:

- `workers.enabled=0`
- `worker_triggers.enabled=0`
- Stored DB manifest has `paused=true`
- Live worker file has `paused: true`
- Joined scheduler query for enabled schedule rows returned `[]`
- Public live API detail/list hide `slack-listener`, so DB scheduler state is the authoritative verification path.
- A 20-second re-check still returned `enabled_due_rows=[]`.

## Tests

Passed:

```bash
pytest -q apps/api/tests/test_worker_mgmt_bugs.py
pytest -q apps/api/tests/test_worker_mgmt_bugs.py apps/api/tests/test_scheduled_worker_defaults.py tests/test_api_endpoints.py::TestPatchWorker
pytest -q apps/api/tests
```

Final backend result: `594 passed`.

## Follow-Up

Emily worker creation took about 120 seconds and produced a schedule-only shell with no meaningful `run.py` logic. This was not fixed in this branch. The follow-up is to improve creation latency and enforce generated-worker completeness before a scheduled worker can be presented as ready.

## Pull Request

PR: https://github.com/floomhq/workeros/pull/484
