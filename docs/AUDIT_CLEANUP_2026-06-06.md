# Audit Cleanup 2026-06-06

## Task 1: PATCH Trigger Reconciliation

Verdict: the round 11-22 audit was correct on clean `origin/main`; memory M50 described the startup/registration reconcile path, not the `PATCH /workers/{id}` route path.

Trace:

- Route handler: `apps/api/main.py:update_worker`.
- Trigger change block: `payload.trigger_type`, `payload.cron_expr`, or `payload.cron_timezone`.
- Scheduler source of truth: `repos.workers.list_due_schedule_triggers(...)`, which reads enabled `worker_triggers` rows where `type = 'schedule'`.
- Repository reconcile behavior: `SqliteWorkerRepository.reconcile_triggers(...)` upserts declared trigger rows and deletes rows no longer declared.

Pre-fix evidence:

- Added `apps/api/tests/test_multi_trigger_e2e.py::test_patch_schedule_to_manual_reconciles_scheduler_trigger_rows`.
- On unmodified clean `origin/main`, the test failed after `PATCH /workers/single-trigger-worker` with `{"trigger_type": "manual"}`.
- The stale row remained in `worker_triggers` as `type='schedule', enabled=1`, matching the audit report.

Fix:

- `update_worker` now derives the effective single trigger from the PATCH payload and current worker state.
- It persists matching `triggers_json`.
- It calls `repos.workers.reconcile_triggers(...)` so `worker_triggers` matches the new trigger declaration before the scheduler can read stale rows.

Post-fix evidence:

- `pytest apps/api/tests/test_multi_trigger_e2e.py -q` passes: `3 passed`.
- The regression asserts:
  - PATCH schedule -> manual returns HTTP 200.
  - `worker_triggers` becomes exactly one enabled `manual` row.
  - `list_due_schedule_triggers(...)` returns no rows for the patched worker.

## Task 2: Cloud Migration Version Control

Verdict: `supabase/migrations/0026_lock_down_public_rls_policies.sql` was missing from clean cloud `origin/main`; `supabase/migrations/0029_brain_asset_access.sql` is already tracked on clean cloud `origin/main`.

Version-control confirmation:

- Added `supabase/migrations/0026_lock_down_public_rls_policies.sql` to `/root/workeros-cloud-audit-migrations`.
- `0029_brain_asset_access.sql` is already tracked by commit `3e9e276 fix(brain): wire cloud context asset access (#93)`.
- The dirty source-tree `0029` file and clean `origin/main` `0029` file have identical SHA-256:
  `377b4ac26b2855e916fa87781ea0a7a576263436c4dbad73fce1757c464f260f`.

Production Supabase verification:

- Credential path used: Supabase Management API PAT, read-only database query endpoint.
- `supabase_migrations.schema_migrations` contains `0026_lock_down_public_rls_policies`.
- Catalog state for `asset_versions`, `workspace_agent_settings`, and `workspace_agent_channel_bindings` matches the 0026 lockdown intent:
  - RLS enabled and forced.
  - Service-role policies are scoped to `service_role`.
  - Authenticated user policies are owner-scoped.
  - Direct `anon` and `PUBLIC` table grants are absent.
  - `service_role` has SELECT, INSERT, UPDATE, and DELETE privileges.
- Catalog state for `brain_packs`, `assistants`, and `brain_files` matches 0029:
  - All three tables exist.
  - RLS is enabled and forced.
  - Service-role full-access policies exist with `USING (true)` and `WITH CHECK (true)`.
  - Direct `anon` and `PUBLIC` table grants are absent.
  - `service_role` has SELECT, INSERT, UPDATE, and DELETE privileges.
  - Expected indexes exist:
    `idx_brain_packs_owner_id`, `idx_brain_packs_share_token_hash`,
    `idx_assistants_owner_id`, `idx_brain_files_owner_id`,
    `idx_brain_files_share_token_hash`.

Cloud test evidence:

- `pytest tests/test_brain_asset_access.py -q`: `4 passed`.
- `pytest tests/test_workspaces_migration.py -q`: `11 passed`.
