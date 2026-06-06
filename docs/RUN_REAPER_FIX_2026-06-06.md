# Run Reaper Fix - 2026-06-06

## Bug

When the API process restarted while a worker run was in flight, the process-local execution thread disappeared but the database row could remain `status='running'` indefinitely. The normal `FLOOM_RUN_TIMEOUT` limit only applies while an executor is alive, so abandoned rows could block worker concurrency guards and show as running forever.

## Fix

The engine now runs an abandoned-run reaper:

- On API startup, before the queue drain loop starts.
- Periodically in a lightweight daemon thread every 180 seconds by default.
- Only for `running` rows older than `FLOOM_RUN_TIMEOUT + 60s` by default.
- Only when the run ID is not present in the process-local active execution registry.
- With an idempotent database update guarded by `WHERE status = 'running'`.

Reaped runs are marked:

- `status='failed'`
- `error_code='run_abandoned_server_restart'`
- `error='run abandoned (server restarted): no active executor after timeout window'`

The reaper uses `started_at` with `created_at` fallback because the current `runs` schema has no `updated_at` column.

## Operational Reconciliation

Checked the active OS API SQLite database configured by systemd:

```text
/root/workeros/data/floom.db
```

Result on 2026-06-06: zero rows remained with `status='running'`, so there were no current local rows to update manually. The older `/root/workeros/data/workeros.db` file does not contain a `runs` table.

No input, output, or secret values were read for this check.

## Verification

Added regression coverage:

- A stale `RUNNING` run older than timeout plus grace is reaped.
- A fresh `RUNNING` run remains running.
- A stale `RUNNING` run with an active in-process execution handle remains running.
- Re-running the reaper after it already failed a row returns zero.
- Queued runs remain queued during startup reconciliation.
