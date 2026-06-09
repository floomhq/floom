# Workeros Admin vs. Member Role Differences

## Summary

Workeros has TWO application-level roles: `admin` and `member`. These are enforced in the **API backend only**. The web UI has **NO role-gated navigation or UI elements** — all pages and buttons are visible to both roles; access control is enforced at the API level via 403 Forbidden responses.

**Key fact**: Both roles can perform the same UI actions on the web. Differences emerge only when:
1. A Member tries to perform an action only Admins can do (gets 403).
2. A Member's worker visibility is filtered by `workspace` visibility (shared workers).

---

## Role Definition

| Field | Admin | Member |
|-------|-------|--------|
| **`auth.role`** | `"admin"` | `"member"` |
| **`auth.is_admin`** | `True` | `False` |
| **`auth.scopes`** | `("admin",)` | `()` |
| **Endpoint**: `/auth/me` | ✓ returns `role: "admin", is_admin: true` | ✓ returns `role: "member", is_admin: false` |

**Source**: `/root/workeros/apps/api/auth/multi_member.py:131-168`, `/root/workeros/apps/api/auth/context.py:13,18-19`

---

## Worker Visibility & Access

### Worker List Filtering

**Endpoint**: `GET /workers` (line 5892)

```python
workers = _list_visible_workers(user_id=worker_user_id, repos=repos, use_cache=True, role=auth.role)
```

**Admin sees**: All workers in the database (regardless of owner or visibility).
**Member sees**: 
- Own workers (where `owner_id == user_id`)
- Workspace-shared workers (where `visibility == 'workspace'`)

**Implementation**: `/root/workeros/apps/api/db/sqlite.py:377-397`
- Admin: `SELECT * FROM workers` (no WHERE clause)
- Member: `SELECT * FROM workers WHERE w.owner_id = ? OR w.visibility = 'workspace'`

### Worker Detail Access

**Endpoint**: `GET /workers/{worker_id}` (line 6820, calls `_get_visible_worker`)

Same filtering as list above applies to individual worker fetches.

---

## Worker Mutations (Create, Edit, Delete)

### Create Worker
**Endpoint**: `POST /workers` (line 9065)
- **Admin**: Can create
- **Member**: Can create
- **Enforcement**: None (both can create)

### Edit Worker (PUT /workers/{worker_id})
**Endpoint**: `PUT /workers/{worker_id}` (line 9835, line 9875)

```python
if _get_db_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
    raise HTTPException(status_code=404, detail="Worker not found")
```

- **Admin**: Can edit any worker (because `_get_db_worker` with admin role returns all workers)
- **Member**: Can only edit own workers
- **Shared workers**: Members cannot edit shared workers (403 Not Found)

**Implementation**: `/root/workeros/apps/api/db/sqlite.py:399-425`

### Delete Worker
**Endpoint**: `DELETE /workers/{worker_id}` (line 7426, calls `_delete_worker_impl`)

```python
worker = repos.workers.get(user_id=owner_id, worker_id=worker_id)
if not worker:
    raise HTTPException(status_code=404, detail="Worker not found")
```

- **Admin**: Can delete any worker (role-aware `get` returns all)
- **Member**: Can only delete own workers
- **Shared workers**: Members cannot delete (403 Not Found)

---

## Worker Sharing & Visibility Control

### Set Worker Visibility
**Endpoint**: `PUT /workers/{worker_id}/visibility` (line 6835)

```python
result = asset_access.set_visibility(
    workspace_id=str(worker.get("workspace_id") or "local-default"),
    actor_id=auth.user_id,
    asset_type="worker",
    asset_id=worker_id,
    visibility=payload.visibility,
)
```

- **Admin**: Can set visibility on any worker
- **Member**: Can only set visibility on own workers
- **Enforcement**: AssetAccessRepository enforces `can_share` permission; non-owner gets 403 PermissionError

---

## User Management (System Admins Only)

### List Users
**Endpoint**: `GET /users` (line 19799)

```python
_require_admin(auth)  # raises 403 if not admin
user_repo, _, _ = _require_multi_member_repos(repos)
rows = user_repo.list()
```

- **Admin**: Can list all users ✓
- **Member**: 403 Forbidden

### Create User
**Endpoint**: `POST /users` (line 19812)
- **Admin**: Can create users ✓
- **Member**: 403 Forbidden

### Update User
**Endpoint**: `PATCH /users/{uid}` (line 19843)
- **Admin**: Can update any user ✓
- **Member**: 403 Forbidden

### Delete User
**Endpoint**: `DELETE /users/{uid}` (line 19871)
- **Admin**: Can delete users ✓
- **Member**: 403 Forbidden

**Enforcement**: `_require_admin()` at `/root/workeros/apps/api/main.py:19677-19679`

---

## Workspace Member Management

### List Members
**Endpoint**: `GET /workspace/members` (line 792)

```python
_ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
rows = members_repo.list(workspace_id=workspace_id)
```

- **Owner/Admin**: Can list members ✓
- **Member**: 403 Forbidden (enforced by `_ensure_owner_membership`)
- **Enforcement**: Repository checks if user's role is "owner" or "admin"

### Invite Member
**Endpoint**: `POST /workspace/members` (line 816)
- **Owner/Admin**: Can invite ✓
- **Member**: 403 Forbidden

### Change Member Role
**Endpoint**: `PATCH /workspace/members/{user_id}` (line 841)
- **Owner**: Can change admin ↔ member; demote admin ✓
- **Admin**: Can promote/demote members (some restrictions via DB layer)
- **Member**: 403 Forbidden

### Remove Member
**Endpoint**: `DELETE /workspace/members/{user_id}` (line 869)
- **Owner/Admin**: Can remove (with restrictions) ✓
- **Member**: 403 Forbidden

### Transfer Ownership
**Endpoint**: `POST /workspace/members/transfer-owner` (line 895)
- **Owner**: Can transfer ownership ✓
- **Admin/Member**: 403 Forbidden

**Enforcement**: All check `_ensure_owner_membership()` which verifies user is owner/admin.

---

## Connections Management

### List Connections
**Endpoint**: `GET /connections` (implied)
- **Admin**: All connections in workspace
- **Member**: All connections in workspace
- **Access**: Scoped to current user (no role-based filtering)

### Create Connection (Composio OAuth)
**Endpoint**: `POST /connections` (line 13720)

```python
repos.connections.upsert(
    user_id=auth.user_id,
    ...
)
```

- **Admin**: Can create ✓
- **Member**: Can create ✓
- **Enforcement**: No admin check; per-user storage

### Create MCP Connection
**Endpoint**: `POST /connections/mcp` (line 13773)
- **Admin**: Can create ✓
- **Member**: Can create ✓
- **Enforcement**: No admin check; per-user storage

### Delete Connection
**Endpoint**: `DELETE /connections/{connection_id}` (line 14056)
- **Admin**: Can delete ✓
- **Member**: Can delete ✓
- **Enforcement**: No admin check; per-user ownership

**Conclusion**: Connections are **NOT role-gated**; they are user-scoped and both roles have full access.

---

## Secrets Management

### List Secrets
**Endpoint**: `GET /secrets` (line 12934)

```python
db_secrets = {
    row["name"]: row_to_dict(row)
    for row in repos.secrets.list(user_id=auth.user_id)
}
workers = _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True)
```

- **Admin**: Sees all secrets in workspace
- **Member**: Sees only secrets from own + shared workers
- **Enforcement**: Filters via `_list_visible_workers()` with role

### Create/Update Secret
**Endpoint**: `POST /secrets/{name}` (line 12751)
- **Admin**: Can create/update ✓
- **Member**: Can create/update ✓
- **Enforcement**: No admin check; user-scoped

### Delete Secret
**Endpoint**: `DELETE /secrets/{name}` (line 12786)
- **Admin**: Can delete ✓
- **Member**: Can delete ✓
- **Enforcement**: No admin check; user-scoped

**Conclusion**: Secrets are **NOT role-gated**; both roles have equal write access.

---

## Contexts (Brain) Management

### List Contexts
**Endpoint**: `GET /contexts` (implied)
- **Admin**: All contexts
- **Member**: User-scoped contexts
- **Enforcement**: No role check; user-scoped storage

### Create Context
**Endpoint**: `POST /contexts/{name}` (line 175 in lib/api.ts)
- **Admin**: Can create ✓
- **Member**: Can create ✓
- **Enforcement**: No admin check; user-scoped

### Edit/Delete Context
- **Admin**: Can edit/delete ✓
- **Member**: Can edit/delete ✓
- **Enforcement**: No admin check; user-scoped

**Conclusion**: Contexts are **NOT role-gated**; both roles have full access to their own contexts.

---

## System Settings

### Settings Pages
**Endpoint**: `/settings` (line 36 in `app/settings/page.tsx`)

The Settings UI has tabs:
- **API access** (PAT list/create)
- **System** (info, platform config, reload workers)
- **Appearance** (theme toggle)
- **Danger zone** (clear all runs)

**Admin Access**:
- ✓ Can access all settings (API, system, appearance, danger)
- ✓ Can clear run history
- ✓ Can reload workers

**Member Access**:
- ✓ Can access all settings (API, system, appearance, danger)
- ✓ Can clear run history
- ✓ Can reload workers

**Enforcement**: 
- **No role check in the UI** (no conditional rendering)
- **API endpoints** like `POST /workers/reload` and `POST /runs/clear` do **not check role**
- Both roles have equal access to all settings

---

## Assistant/Workspace Agent

### View Assistant
**Endpoint**: `GET /system/workspace-agent` (line 17917)
- **Admin**: Can view ✓
- **Member**: Can view ✓
- **Enforcement**: No role check

### Update Assistant Settings
**Endpoint**: `PUT /system/workspace-agent/settings` (line 17950)
- **Admin**: Can update ✓
- **Member**: Can update ✓
- **Enforcement**: No role check; per-user settings

### Set Assistant Visibility
**Endpoint**: `PUT /system/workspace-agent/visibility` (line 17965)

```python
try:
    result = asset_access.set_visibility(
        workspace_id=workspace_id,
        actor_id=owner_id,
        asset_type="assistant",
        asset_id=aid,
        visibility=payload.visibility,
    )
except PermissionError as exc:
    raise HTTPException(status_code=403, detail=str(exc)) from exc
```

- **Admin**: Can set assistant visibility ✓
- **Member**: Cannot set assistant visibility (403 PermissionError from AssetAccessRepository)

**Note**: Assistant defaults to `workspace` (shared); only owner/admin can change.

---

## Web UI Role Gating

**CRITICAL**: The web frontend does **NOT implement role-based UI gating**.

Checked files:
- `/app/settings/page.tsx` (line 36-314): No role checks; all tabs/buttons visible
- `/app/layout.tsx`: No auth checks
- `/components/layout/sidebar.tsx`: No conditional nav items based on role
- `/lib/types.ts`: `CurrentUser` interface does NOT include role field (line 459-465)
- `/lib/api.ts`: No role-aware API client logic

**Implementation**: `CurrentUser` type (returned by `GET /api/me`) includes:
- `user_id`
- `email`
- `display_name`
- `workspace_id`
- `scopes` (array, empty for members)

Web UI would need to fetch `role` field from `/api/me` response (currently returned from `GET /auth/me` at line 19768-19777) but the frontend `CurrentUser` type does NOT have a `role` field. The UI cannot render role-gated elements because the type interface doesn't include role data.

---

## Summary Table: Access Matrix

| Feature | Admin | Member | Notes |
|---------|-------|--------|-------|
| **View all workers** | ✓ | ✓ (own + shared) | Filtered by role in DB query |
| **Edit own workers** | ✓ | ✓ | Owner-only enforcement |
| **Edit others' workers** | ✓ | ✗ | 403 Not Found |
| **Delete workers** | ✓ (any) | ✓ (own only) | Owner-only enforcement |
| **Set worker visibility** | ✓ (any) | ✓ (own only) | AssetAccess enforces can_share |
| **Manage users** | ✓ (list, create, update, delete) | ✗ | `_require_admin()` gate |
| **Manage workspace members** | ✓ (invite, change role, remove, transfer) | ✗ | `_ensure_owner_membership()` gate |
| **Create connections** | ✓ | ✓ | User-scoped, no role check |
| **Manage secrets** | ✓ | ✓ | User-scoped, no role check |
| **Manage contexts** | ✓ | ✓ | User-scoped, no role check |
| **View/update assistant** | ✓ | ✓ | No role check |
| **Set assistant visibility** | ✓ | ✗ | AssetAccess enforces can_share |
| **Access Settings page** | ✓ | ✓ | No UI or API role check |
| **Clear run history** | ✓ | ✓ | No role check |
| **Reload workers** | ✓ | ✓ | No role check |
| **View member list** | ✓ | ✗ | `_ensure_owner_membership()` gate |

---

## Code Evidence

### Role Definition
- `/root/workeros/apps/api/auth/context.py:13` — role field in AuthContext
- `/root/workeros/apps/api/auth/context.py:18-19` — `is_admin` property
- `/root/workeros/apps/api/auth/multi_member.py:131-168` — role extraction from token/session

### Admin-Only Endpoints
- `/root/workeros/apps/api/main.py:19677-19679` — `_require_admin()` function
- `/root/workeros/apps/api/main.py:19799` — GET /users requires admin
- `/root/workeros/apps/api/main.py:19812` — POST /users requires admin
- `/root/workeros/apps/api/main.py:19843` — PATCH /users requires admin
- `/root/workeros/apps/api/main.py:19871` — DELETE /users requires admin

### Role-Aware Worker Filtering
- `/root/workeros/apps/api/main.py:5892` — `_list_visible_workers(..., role=auth.role)`
- `/root/workeros/apps/api/db/sqlite.py:377-397` — DB query with role-based WHERE clauses

### Workspace Member Enforcement
- `/root/workeros/apps/api/main.py:826` — invite requires `_ensure_owner_membership()`
- `/root/workeros/apps/api/main.py:852` — set_role requires `_ensure_owner_membership()`
- `/root/workeros/apps/api/main.py:879` — remove requires `_ensure_owner_membership()`

### No UI Role Gating
- `/root/workeros/apps/web/lib/types.ts:459-465` — `CurrentUser` type has no role field
- `/root/workeros/apps/web/app/settings/page.tsx:36-314` — All tabs visible; no role check
- `/root/workeros/apps/web/components/layout/sidebar.tsx:37-44` — Static nav array; no role filtering

---

## Conclusion

**The code enforces two distinct role levels: Admin and Member.**

- **Admins**: Can manage users, workspace members, worker visibility, and perform all workspace-level operations.
- **Members**: Can only manage their own workers, cannot invite/remove members, and cannot access user management.

**However**, the web UI is **role-agnostic** — it presents the same interface to both roles. The implementation relies entirely on **backend API access control** (403 responses) to prevent unauthorized actions. A member attempting to invoke an admin-only API will receive a 403 Forbidden; they cannot see this restriction in the UI because the frontend is not role-aware.

This is a **deliberate design choice**: the wire protocol (API) enforces roles, not the client. The implication is that a future web UI or API consumer could detect member role from the `/auth/me` endpoint's `is_admin` field and conditionally render UI, but the current codebase does not do this.
