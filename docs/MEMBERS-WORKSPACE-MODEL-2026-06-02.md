# Members v1 — Workspace & Admin Model

_Added 2026-06-02. Covers the full members system: auth, data visibility, admin
access, shared-worker execution, clone tokens._

---

## Roles

There are two sources of authority in a workspace:

| Who | Role | How |
|-----|------|-----|
| `workspaces.owner_user_id` | always `admin` | Set at workspace creation; never changes except on ownership transfer |
| `workspace_members.role` | `admin` or `member` | Set at invite time; changeable by any admin |

The workspace owner is **not** duplicated in `workspace_members`. Ownership is authoritative.

Role is resolved per-request by `SupabaseAuthProvider.verify` and stored in the
`_active_member_role` ContextVar. Repositories and routes read it via
`get_active_member_role()`.

---

## Invite flow

```
Admin POSTs /api/workspaces/{id}/members/invite
  → workspace_invitations row created (status=pending, 7-day expiry)
  → invitation email sent via Resend (build_workspace_invite_email)
  → raw wsi_* token returned to admin once — only the SHA-256 hash is stored

Invitee POSTs /api/workspaces/accept-invite { token }
  → token validated (not expired, status=pending)
  → invitation marked accepted
  → workspace_members row upserted (idempotent re-join)
  → workspace-scoped PAT minted immediately — returned to invitee once
```

The invite token and PAT are each shown **once** at the time of creation; only
SHA-256 hashes are persisted. This matches the PAT model for secrets.

Pending invites are revocable. Accepted/revoked rows are kept for audit.

The `workspace_invitations` table has a deferrable unique constraint on
`(workspace_id, email)` scoped to pending rows, preventing double-invites
while keeping historical rows.

---

## Worker visibility

Each worker has a `visibility` column with two values:

| Value | Who can see it |
|-------|---------------|
| `private` (default) | Owner + workspace admins |
| `shared` | All active workspace members |

### published_at

`published_at` is stamped **once**, on the first transition to `shared`. It is
immutable — cycling `shared → private → shared` keeps the original timestamp.

Members see run history **from `published_at` onwards only**. Private run history
is never exposed, even if the worker is later shared.

### Enforcement

In `SupabaseWorkerRepository._worker_rows`, the visibility filter is:

```python
# Role is the caller's role from the _active_member_role ContextVar.
if workspace_id_in_context and user_id and role != "admin":
    builder = builder.or_(f"user_id.eq.{user_id},visibility.eq.shared")
```

Admins bypass the filter and see all workers in the workspace.
Out-of-request paths (scheduler, webhook) have no contextvar set, so they fall
back to user_id scoping (same as pre-members behaviour).

---

## Admin access log

Admins can read any member's private data. Every such access is **silently
logged** to `admin_access_log` with no notification to the target member.

This is the industry standard — Slack workspace exports, Google Workspace admin
console, and GitHub org admin work the same way.

### When a row is written

`SupabaseWorkerRepository.get()` logs when **all three** conditions hold:

1. Caller's role is `admin`
2. The worker's `user_id` ≠ caller's `user_id` (admin is not the owner)
3. Worker's `visibility = 'private'`

### Schema

```sql
admin_access_log (
    id              uuid pk,
    workspace_id    text → workspaces,
    admin_user_id   uuid → users,
    target_user_id  uuid → users,
    resource_type   text,  -- 'worker' | 'run' | 'secret' | 'connection'
    resource_id     text,
    accessed_at     timestamptz default now()
)
```

RLS is enabled; no policies created — service_role (the only data path) bypasses
RLS. Anon/authenticated roles get deny-all by default.

---

## Shared-worker execution

When a member triggers a shared worker, the run executes **as the worker owner's
identity**. Specifically, `get_secrets_for_worker` resolves secrets by
`_worker_owner_id(worker_id)` first, then falls back to the triggering user_id.

```python
# run_service.py (OSS)
owner_id = _worker_owner_id(worker_id, repos_obj) or user_id
```

This means:
- The member does not need to have the same secrets configured.
- The worker's connection grants are checked against the owner's connections.
- The triggering member's identity is recorded in `runs.trigger_member_id` for audit.

The triggering member sees the run in their run history; the owner also sees it.

---

## Clone tokens

Clone tokens let a worker be shared across workspace boundaries (or to external
collaborators) without exposing credentials.

```
POST /workers/{id}/clone-link
  → generates wct_* token (7-day expiry)
  → stores SHA-256 hash in workers.clone_token_hash
  → returns raw token once

POST /workers/clone/{token}
  → validates token + expiry (410 if expired)
  → reads source worker files (disk in OSS; Supabase manifest_json._files in Cloud)
  → creates new worker with a new id
  → auto-wires connections by app_name (first active connection)
  → does NOT copy: secrets, run history, brain data
```

Cloud override (`cloud_clone_worker` in `main.py`) reads source files from
`skill_versions.manifest_json._files` since Railway disk is ephemeral.

---

## PAT scoping

All PATs are scoped to `(user_id, workspace_id)`. A PAT cannot be used across
workspaces. Members' auto-minted PATs are created at invite-accept time.

Revocation: `DELETE /api/workspaces/{id}/members/{uid}` soft-deletes the member
row (status=removed) but does **not** revoke their PATs automatically. Workspace
admins should separately delete PATs from the API tokens settings if immediate
revocation is needed. Full PAT revocation on member removal is a v2 item.

---

## Key invariants

1. **Owner is never in workspace_members.** Owner authority comes from
   `workspaces.owner_user_id` exclusively.

2. **published_at is write-once.** Once set, it cannot be cleared or reset.
   Going private and re-sharing keeps the original timestamp.

3. **Admin access log is best-effort.** `_log_admin_access` catches all
   exceptions — a Supabase write failure does not block the read.

4. **Role resolution is separated from workspace resolution.** In
   `SupabaseAuthProvider._resolve_workspace_and_build_context`, these run in
   separate `try/except` blocks so a role-lookup failure never masks a
   successful workspace resolution.

5. **Clone does not transfer identity.** The cloned worker's `user_id` is the
   cloner's id, not the original owner's. Secrets must be re-configured.
