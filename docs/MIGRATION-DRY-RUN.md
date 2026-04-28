# Migration Dry-Run

Date: 2026-04-27

Verdict: **PASS for v1.**

Federico clarified that v1 is single-user-per-workspace only. The previous multi-user-per-workspace conflict assertion is therefore moot for v1 and is deferred to v1.1, when multi-member workspaces ship.

Raw capture from the earlier dry-run remains: `/tmp/floom-migration-dryrun-results.json`

## Scope Revision

The dry-run previously generated synthetic prod-shaped data with 100 workspaces, 500 users, and intentionally conflicting `user_secrets` groups where multiple users in the same workspace held different values for the same key.

That conflict shape is not a v1 production scenario:

- v1 workspace model: one user per workspace.
- v1 conflict risk: no multi-user-per-workspace secret collisions.
- v1.1 scope: reintroduce strict conflict-resolution checks when multi-member workspaces ship.

## Revised Verification Results

| Check | Verdict | Evidence |
| --- | --- | --- |
| Non-conflicting legacy secret groups create `workspace_secrets` rows | PASS | 1,500 non-conflict groups produced 1,500 workspace rows |
| Strict "all `user_secrets` groups have a workspace row" | PASS for v1 | The only missing rows came from synthetic multi-user conflicts, which v1 cannot produce |
| Multi-user conflict logging | DEFERRED to v1.1 | The conflict logger works, but the scenario is outside v1 launch scope |
| Idempotency | PASS | State digest unchanged across the second migration pass |
| Active agent tokens resolve | PASS | Active token resolved with the expected `workspace_id` |
| Revoked agent tokens are rejected | PASS | Revoked token hash returned no active row |
| `/api/me/agent-keys` workspace filtering | PASS | Cross-workspace token rows were excluded |
| `/api/secrets` workspace read | PASS | `loadForRun` read from `workspace_secrets` |
| `/api/secrets` legacy fallback | PASS | After deleting one workspace row, `loadForRun` read from `user_secrets` |
| Rollback by dropping `workspace_secrets` | FAIL | Readers throw `no such table: workspace_secrets` |

## Rollback Fix Still Required

The rollback bug is real and independent of the v1 conflict-scope clarification.

Current rollback issue:

- `loadForRun` queries `workspace_secrets` first.
- `listWorkspaceMasked` queries `workspace_secrets` first.
- Dropping `workspace_secrets` during rollback makes those reads throw `no such table: workspace_secrets`.
- Direct legacy `userSecrets.get()` still works because it reads `user_secrets` only.

Recommended rollback-safe fix:

- Keep the `workspace_secrets` table present but empty during rollback, or
- Add table-missing fallback around workspace-level readers before documenting table-drop rollback.

## Launch Decision

Migration is **PASS for v1 launch** because the strict multi-user conflict assertion does not apply to the v1 data shape. The rollback reader fix remains a real follow-up bug.
