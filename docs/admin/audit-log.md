# Audit Log

ADR-013 adds `audit_log` as the canonical compliance and debugging trail for
state changes in the backend.

## Schema

`audit_log` stores one immutable row per audited action:

- `id`: `audit_<uuid>` primary key
- `actor_user_id`: user id, nullable for system actions
- `actor_token_id`: agent token id when a bearer agent token caused the action
- `actor_ip`: best-effort client IP from proxy headers
- `action`: dotted action name, for example `app.visibility_changed`
- `target_type`: `app`, `agent_token`, `user`, `workspace_member`, or `secret`
- `target_id`: target identifier
- `before_state`: JSON snapshot before the mutation
- `after_state`: JSON snapshot after the mutation
- `metadata`: action-specific JSON, never plaintext secrets
- `created_at`: ISO-8601 timestamp

Indexes cover `actor_user_id`, `(target_type, target_id)`, `action`, and
`created_at DESC`.

`app_visibility_audit` remains in place for backward compatibility. New
visibility transitions write both tables; historical rows are migrated into
`audit_log` at boot.

## Actions

Current write coverage:

- `app.visibility_changed`
- `app.published`
- `app.updated`
- `app.deleted`
- `agent_token.minted`
- `agent_token.revoked`
- `secret.updated`
- `secret.deleted`
- `secret.policy_updated`
- `workspace_member.added`
- `workspace_member.removed`
- `workspace_member.role_changed`
- `account.deleted`
- `admin.app_approved`
- `admin.app_rejected`
- `admin.app_takedown`
- `admin.app_publish_status_changed`

## Admin API

Only admins can read audit rows.

```bash
GET /api/admin/audit-log?actor_user_id=user_123
GET /api/admin/audit-log?target=app:app_123
GET /api/admin/audit-log?action=agent_token.revoked&limit=50
GET /api/admin/audit-log?since=2026-04-26T00:00:00.000Z
GET /api/admin/audit-log/audit_550e8400-e29b-41d4-a716-446655440000
```

`target` uses `<target_type>:<target_id>`. `limit` accepts `1..500` and
defaults to `100`.

Legacy visibility queries using `app_id` still work:

```bash
GET /api/admin/audit-log?app_id=app_123
```

## Retention

The retention sweeper runs daily at 04:00 UTC unless
`FLOOM_DISABLE_AUDIT_SWEEPER=true`.

Policy:

- non-admin actions: retained for 1 year
- `admin.%` actions: retained forever

Each sweep appends the deleted row count to:

```text
/var/log/floom-audit-sweep.log
```
