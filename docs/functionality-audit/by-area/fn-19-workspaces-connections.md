# FN-19 — Workspaces and Composio connections

**Scope:** `apps/server/src/routes/workspaces.ts`, `apps/server/src/services/workspaces.ts`, `apps/server/src/routes/connections.ts`, `apps/server/src/services/composio.ts`.  
**Product anchor:** [`docs/PRODUCT.md`](../../PRODUCT.md) — multi-tenant workspace membership and “connect a tool” OAuth support the hosted product (auth, secrets, three surfaces) without pushing OAuth plumbing onto the ICP; these modules are not listed as load-bearing delete targets but they implement real tenancy and integration boundaries.

---

## 1. Invite flows

### Create (`POST /api/workspaces/:id/members/invite`)

- **Route:** `requireAuthenticatedInCloud` then Zod body `{ email, role? }` (default role `editor`).
- **Service (`inviteByEmail`):** `assertRole(..., 'admin')`; normalizes email; rejects invalid shape via regex; rejects if a member already has that email (`DuplicateMemberError`); deletes prior **pending** invites for the same workspace+email; inserts `workspace_invites` with `token` (48 hex chars from 24 random bytes), `status = 'pending'`, `expires_at` = now + 14 days (`INVITE_TTL_MS`).
- **Response:** `{ invite, accept_url }` where `accept_url` = `{BETTER_AUTH_URL || PUBLIC_URL || http://localhost:$PORT}/invite/{token}`.

### List (`GET /api/workspaces/:id/invites`)

- **Route:** No `requireAuthenticatedInCloud` (relies on service).
- **Service:** `assertRole(..., 'admin')`; returns **all** rows for the workspace (no `status` filter), newest first.

### Revoke (`DELETE /api/workspaces/:id/invites/:invite_id`)

- **Route:** No `requireAuthenticatedInCloud`.
- **Service:** `assertRole(..., 'admin')`; `UPDATE ... SET status = 'revoked'` only where `status = 'pending'` (idempotent for already-non-pending rows: zero rows updated, still `200 { ok: true }`).

### Accept (`POST /api/workspaces/:id/members/accept-invite`)

- **Route:** Body `{ token }`; `:id` is documented as informational — **truth is the token** (`services/workspaces.ts` loads by token only).
- **Service:** Rejects unauthenticated synthetic OSS user (`!ctx.is_authenticated && ctx.user_id === DEFAULT_USER_ID`). Loads `pending` row by token; marks `expired` in DB then throws `InviteExpiredError` if past `expires_at`. Loads caller email from Floom `users`; mismatch throws **`InviteNotFoundError`** (same as missing token — intentional ambiguity). Transaction: insert membership if absent (if already member, **no role change** but invite still marked `accepted`), set `user_active_workspace` to invited workspace.

### Gaps and edge cases

- **Wrong-email path** returns `invite_not_found` (404), not a distinct “email mismatch” code — reduces enumeration of valid tokens vs emails at the cost of debuggability.
- **Already a member:** Accept succeeds and consumes the invite without upgrading role if their current role differs from the invite.
- **Cloud anonymous + workspace `local`:** See §2 — admin-only invite routes still call `assertRole`; the synthetic `local` user on workspace `local` bypasses membership checks, so invite list/revoke behavior on `local` is reachable without Better Auth when cloud session is absent (same pattern as FN-04 session audit for OSS-shaped anonymous cloud ctx).

---

## 2. RLS-equivalent checks (app-layer tenancy)

Floom uses **SQLite + explicit `SessionContext` filters**, not Postgres RLS. Effective rules:

### Workspaces service

- **Membership:** `getMemberRole` + `assertRole` enforce `viewer` / `editor` / `admin` hierarchy on `workspace_id` from the URL or target resource. Exceptions: `DEFAULT_USER_ID` + `DEFAULT_WORKSPACE_ID` (`local` / `local`) **always passes as admin** (`assertRole` short-circuit).
- **Reads:** `getById`, `listMembers` require at least `viewer` on that workspace.
- **Writes:** `update`, `remove`, `changeRole`, `removeMember`, `inviteByEmail`, `listInvites`, `revokeInvite` require `admin` (except `switchActiveWorkspace` / `getById` / `listMembers` as noted).
- **Cross-user safety:** Workspace rows are addressed by id from the client; authorization is “is `ctx.user_id` a member with sufficient role,” not “does `ctx.workspace_id` from session equal this id.” So listing another workspace fails with `not_a_member` / `workspace_not_found` as appropriate.

### Route vs service gates (`workspaces.ts`)

- **`requireAuthenticatedInCloud`:** Applied on create/update/delete workspace, member role patch/delete, and **create invite** only.
- **Not gated at route (cloud anonymous allowed through to service):** `GET /`, `GET /:id`, `GET /:id/members`, `GET /:id/invites`, `DELETE /:id/invites/:invite_id`, `POST .../accept-invite`, `POST /api/session/switch-workspace`, `GET /api/session/me`.

Implication: In **cloud mode without a session**, `resolveUserContext` still yields the synthetic `local` user (`session.ts`). That principal is **treated as admin on workspace `local`**. Any route that only uses `assertRole` against `:id` without `requireAuthenticatedInCloud` can therefore operate on workspace id `local` (e.g. list members, list invites, revoke invites) without signing in. Mutations that add `requireAuthenticatedInCloud` (create workspace, invite creation, etc.) remain blocked for anonymous cloud callers.

### Connections service (`composio.ts`)

- **Tenant column:** Every query includes `workspace_id = ctx.workspace_id` plus `owner_kind` / `owner_id` from `contextOwner(ctx)` (`user` when `ctx.is_authenticated`, else `device` + `device_id`).
- **`finishConnection` binding:** Before calling Composio, loads the local row with `(workspace_id, owner_kind, owner_id, composio_connection_id)`. Prevents user A from finishing user B’s Composio request id even if they guess the id.
- **`listConnections` / `getConnection` / `revokeConnection`:** Same composite key — no cross-owner reads or deletes.
- **Login migration:** `rekeyDevice` in `session.ts` updates `connections` from `owner_kind='device'` to `owner_kind='user'`, rewrites `workspace_id` to the post-login active workspace, and skips if a conflicting `user` row already exists for that provider (documented orphan edge case).

### Connections routes (`connections.ts`)

- **No `requireAuthenticatedInCloud`:** Pre-login “Connect a tool” on the anonymous cloud context is intentional: `ctx.workspace_id` stays `local` until auth; Composio rows are device-scoped then rekeyed.

---

## 3. OAuth state (Composio ramp)

- **No first-party OAuth `state` query param** is generated or validated in Floom code. The Composio SDK’s `connectedAccounts.initiate` receives `userId` (Floom’s `device:<uuid>` or `user:<id>`) and optional `callbackUrl`; the returned **`connection_id`** and **`redirectUrl`** are the client-facing correlation handles.
- **CSRF / mix-up mitigation:** Server-side, **`finishConnection`** requires a **pre-inserted local row** matching `(workspace_id, owner_kind, owner_id, composio_connection_id)` before polling Composio. Random guessing another user’s Composio id without having initiated (and thus inserted) under the same owner tuple should 404 with `ConnectionNotFoundError`.
- **TTL hint:** `initiateConnection` returns `expires_at` = now + 15 minutes (documented as a conservative UI hint, not enforced server-side against Composio).
- **Status mapping:** Composio strings normalized to `active` / `pending` / `expired` / `revoked` (`normalizeStatus`).

---

## 4. Token storage

### Workspace invites

- **Storage:** Plain **`token`** column on `workspace_invites` (high-entropy hex). **No HMAC/JWT** wrapping; security is unguessability + HTTPS in production + one-time status transition to `accepted` / `revoked` / `expired`.
- **Transport:** Full token embedded in `accept_url` path segment `/invite/{token}` — log/referrer leakage surfaces apply standard to magic links.

### Composio / third-party OAuth tokens

- **Not stored in Floom’s `connections` row** as refresh/access secrets. Persisted fields: `composio_connection_id`, `composio_account_id`, `status`, optional `metadata_json` (e.g. `account_email` derived from Composio `get` payload). Route serializer explicitly notes secrets are not on this row.
- **Pending row:** `upsertConnection` stores `composio_account_id` as the **Floom Composio user key** (`device:…` or `user:…`) while status is `pending`; after `get`, the same column flow is reused — **`executeAction`** passes `conn.composio_account_id` as Composio `userId` for `tools.execute` (must stay consistent with what Composio bound at initiate time; `rekeyDevice` does **not** rewrite Composio-side ids; `users.composio_user_id` stores legacy `device:…` when rows were rekeyed).

### API / session tokens

- Out of scope for these four files; workspace flows rely on Better Auth session cookies and `resolveUserContext` (see FN-04).

---

## 5. Miscellaneous correctness notes

- **`InviteExpiredError` HTTP status:** Mapped to `410` via `status: 410 as unknown as 400` in `mapError` — works at runtime but relies on a cast; worth aligning types if the codebase tightens response typing.
- **`acceptInvite` auth predicate:** Only blocks the combination **unauthenticated synthetic default user**; any other `user_id` with `is_authenticated === false` would pass the first check (unlikely for normal Better Auth flows but worth knowing if contexts are ever constructed manually).

---

## 6. Summary table

| Area | Assessment |
|------|------------|
| Invite lifecycle | Create → pending token → accept/revoke/expiry; duplicate pending invites for same email replaced; accept binds membership + active workspace. |
| Tenancy / “RLS” | Strong member/role checks on workspace id; Composio scoped by workspace + owner tuple + finish ownership check. Synthetic `local` admin bypass is the main anonymous-cloud footgun for **non–`requireAuthenticatedInCloud`** workspace routes targeting id `local`. |
| OAuth state | Delegated to Composio; Floom enforces initiation ownership on finish. |
| Token storage | Invite token in DB; OAuth secrets at Composio; Floom stores linkage/metadata only. |
