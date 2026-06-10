# Coverage Audit D — Settings, Nav/⌘K, Workspace Switcher, Account Menu, Role Gating

**Date:** 2026-06-10  
**Source frontend:** `docs/design/final.html` (settingsBody, SECS, pageSettings, wsbrand/wspop, acctpop, nsearch, setRole)  
**Source backend:** `apps/api/main.py`  
**Pre-established:** Issues #765–#773. #772 (changelog) and #773 (appearance) skipped per brief.

---

## SETTINGS — System

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Workspace name (display) | BUILT | `GET /workspaces` → `LocalWorkspaceOut.name`; `GET /me` carries workspace_id | — |
| Workspace name (rename/edit) | MISSING | No `PATCH /workspaces/{id}` or `PUT /workspaces/{id}` exists. `POST /workspaces` creates; no update route | File issue |
| Region (display + edit) | MISSING | No region field in `LocalWorkspaceOut`. No DB column. No endpoint. | File issue (fold into name-edit issue or standalone) |
| Timezone (display + edit) | MISSING | No workspace-level timezone field. `cron_timezone` is per-worker only (line 3650). No workspace-default-timezone endpoint | File issue |
| Require approval before writes (toggle, workspace default) | MISSING | `require_approval` exists at **per-worker level** (`models.py:341`, `runner_sandbox/agent_capabilities.py:282`) but no workspace-level default toggle. `WorkspaceAgentSettingsUpdate` (line 642) only controls brain_read/write/connections; no approval_default field | File issue |
| Auto-pause failing workers (toggle) | PARTIAL | `_auto_pause_on_consecutive_failures_enabled()` exists in `run_service.py:2556` but reads `WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES` env var — not a DB-persisted, user-configurable toggle. No endpoint to read/set it | File issue |
| Email me run failures (toggle) | PARTIAL | `_send_email_notification` + `_fire_alert_webhooks` exist (`run_service.py:290,353`), but these are **per-worker alert rows** (webhook/email_to per worker). No workspace-level "email me on any run failure" toggle | File issue |
| Model defaults — default model + fallback (display + edit) | MISSING | No workspace model defaults endpoint. `WorkspaceAgentSettingsUpdate` (line 642) has no model fields. Model is hardcoded in chat_service / worker runner. | File issue |
| Run limits — max tokens/run (display + edit) | MISSING | `token_cap_exceeded` message exists (line 12310) but no workspace-level configurable cap endpoint | File issue (fold with model defaults) |
| Run limits — timeout (display + edit) | MISSING | Worker-level timeout in `worker.yml` only. No workspace-default timeout endpoint | File issue (fold) |
| Monthly spend cap (display + edit) | MISSING | No spend tracking or monthly budget cap anywhere in the API. `token_cap_exceeded` is output-token cap, not spend cap | File issue |

## SETTINGS — Channels

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Slack connection status row | BUILT | `GET /slack/setup/status` (line 15707) returns `SlackSetupStatus` | — |
| Slack connect/configure | BUILT | `POST /slack/setup/config` (line 15712), `POST /slack/oauth/install` (line 15731), OAuth callback (15743) | — |
| Email (Gmail) connection status | MISSING | No dedicated email-channel status endpoint. Slack has `/slack/setup/status`; Gmail has no equivalent. Alerts use `notify_email` per-worker but no workspace-level Gmail channel binding status | File issue |
| WhatsApp connection status row | PARTIAL | `POST /whatsapp/bindings/claim` (16714) + internal binding table `whatsapp_sender_bindings`. No `GET /whatsapp/status` or `GET /whatsapp/bindings` endpoint to read connection status. UI reads status row but there is no status API | File issue |
| WhatsApp connect (QR/number flow) | PARTIAL | `claim_whatsapp_sender` exists, webhook receiver exists (16969). Connect UI triggers a flow but no documented setup-initiation endpoint (unlike Slack's explicit install URL). Issue #733 tracks this. | Tracked #733 |
| Agent install (MCP) | BUILT | `GET /workspace-agent/mcp` + `POST /workspace-agent/mcp` (17786/17819). MCP token issued by `system/workspace-agent`. | — |

## SETTINGS — Assistant

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Base instructions (read-only, display) | BUILT | `GET /workspace/base` (19845) returns base persona. `GET /workspace/base/state` (19857) returns `is_custom` flag | — |
| Base instructions (edit by admin) | BUILT | `PUT /workspace/base` (19974), `DELETE /workspace/base` (19881) reset to default | — |
| Workspace instructions (read + edit) | BUILT | `GET /workspace` (19838) + `PUT /workspace` (20064) | — |
| Final prompt (composed view) | BUILT | `GET /system/workspace-agent` (18588) returns `system_prompt` (the resolved/composed prompt including workspace.md + base) | — |
| Versions | BUILT | `GET /workspace/versions` (19994), per-sha (20017), rollback (20037); same for base (19910, 19929, 19949) | — |
| Member read-only gating (UI) | BUILT (UI only) | Design: `role==='member'` renders warning banner and removes edit affordance. **Server-side:** `PUT /workspace` and `PUT /workspace/base` do not call `_require_admin(auth)`. Any member with a PAT can call them. | File issue — server-side guard missing |

## SETTINGS — Members

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| List members with roles Owner/Admin/Member | BUILT | `GET /workspace/members` (894) returns `WorkspaceMembersResponse` with `my_role` + full member list including roles | — |
| Owner/Admin/Member role distinction | BUILT | `role: Literal["owner","admin","member"]` in `WorkspaceMemberOut` (line 779); repo enforces hierarchy | — |
| Invite member (admin only) | BUILT | `POST /workspace/members` (918); repo checks owner/admin authority | — |
| Change role (owner only) | BUILT | `PATCH /workspace/members/{user_id}` (943); repo enforces owner-only for role changes | — |
| Remove member (owner/admin) | BUILT | `DELETE /workspace/members/{user_id}` (971); admins can't remove owner/admins | — |
| Transfer ownership | BUILT | `POST /workspace/members/transfer-owner` (997) | — |
| Member invite gating (UI only shows to admin) | BUILT | Design line 637/713 gates "+ Invite member" on `role==='admin'`. `POST /workspace/members` enforces server-side | — |
| "Manage" button (change role UI) | BUILT | Design shows Manage button only when `role==='admin'&&r!=='Owner'`. Backend: PATCH enforces server-side | — |
| "Give feedback" action on locked worker | MISSING | Design line 537: `locked` workers show ["Versions","Request edit access","Give feedback"]. Issue #731 already filed for worker feedback endpoint. | Tracked #731 |
| "Request edit access" action | MISSING | Design line 537. No `POST /workers/{id}/request-edit` or similar endpoint exists | File issue |

## SETTINGS — Version history

Skipped per brief (issue #772 already filed).

## SETTINGS — Danger

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Export all data | BUILT | `GET /workspace/export` (9770) — exports workers, brain, workspace.md as .zip. Rate-limited (20/60s). | — |
| Delete workspace | MISSING | No `DELETE /workspaces/{id}` endpoint. `DELETE /workspace/base` (19881) only resets the base persona. No full workspace deletion route exists. | File issue |

## SETTINGS — Developer

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| PAT list/reveal | BUILT | `GET /auth/tokens` (21251) lists PATs (token value shown once on create only; list shows masked) | — |
| PAT create | BUILT | `POST /auth/tokens` (21261) | — |
| PAT delete/rotate | BUILT | `DELETE /auth/tokens/{token_id}` (21298); rotate = delete + create | — |
| CLI install instructions | FRONTEND-ONLY | Static code snippet (`npm i -g @floomhq/workeros`). No backend needed. | — |
| MCP config + token | BUILT | `GET /system/workspace-agent` (18588) returns MCP token info. MCP endpoint at `/workspace-agent/mcp`. | — |
| API base URL | FRONTEND-ONLY | Static display of `https://workers-api.floom.dev/v1`. No backend needed. | — |

## SETTINGS — Appearance

Skipped per brief (issue #773 already filed).

---

## NAV

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| ⌘K search (global) | MISSING | No `GET /search` or global search endpoint. No full-text search across workers/runs/contexts. Design `nsearch` is FE-only over loaded data (line 290). | File issue |
| Nav badge — approvals pending count | BUILT | `GET /approvals/count` (10963) returns `{"pending": N}` scoped to `owner_id` | — |
| Nav collapse state | FRONTEND-ONLY | Toggled via `tog('nav')` JS + CSS class `.nav.col`. No persistence endpoint needed (FE localStorage). | — |

---

## WORKSPACE SWITCHER

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| List my workspaces | BUILT | `GET /workspaces` (687) — OSS local mode only. Cloud uses multi-tenant per-workspace routing. | — |
| Create new workspace | BUILT | `POST /workspaces` (699) — OSS local mode. | — |
| Select/switch workspace | BUILT | `POST /workspaces/{id}/select` (714) | — |
| Share workspace | BUILT | `GET /workspace/share-link` (9823) generates template link; `GET /workspace/template/{token}` serves it | — |
| Duplicate workspace | BUILT | `POST /workspaces/{id}/duplicate` (737) | — |
| Multi-workspace per user (Cloud) | PARTIAL | OSS: `_require_local_workspace_mode()` guard (669) — list/create/select only in local mode. Cloud multi-tenant: each workspace is a separate database/git repo, no cross-workspace list for a user. No `GET /me/workspaces` in cloud mode. | FRONTEND-ADJUST: switcher list must be gated on OSS mode; Cloud needs a different entrypoint |

---

## ACCOUNT MENU

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Profile info (email/name display) | BUILT | `GET /me` (674) returns `CurrentUserResponse` with `user_id`, `email`, `display_name`, `role` | — |
| Log out | BUILT | `POST /auth/logout` (21038). Auth uses session cookie + Bearer PAT (`auth_middleware` line 1385). Magic-link (`/auth/magic-link`, 21102) also supported. | — |
| Settings link | FRONTEND-ONLY | `closeAcct();go('settings')` — client nav. No backend needed. | — |
| Theme toggle | FRONTEND-ONLY (skip) | Issue #773 filed. | — |

---

## ROLES — Server-side enforcement

| Gate | Status | Evidence | Action |
|------|--------|----------|--------|
| Admin-only: system git/secret operations | BUILT | `_require_admin(auth)` called at lines 18909, 18947, 18966, 18989, 19038, 19062, 19090 | — |
| Admin-only: user management | BUILT | `_require_admin(auth)` at lines 21168, 21181, 21212, 21240 | — |
| Owner/admin: invite member | BUILT | `members_repo.invite()` enforces in repo layer (line 924 comment) | — |
| Owner-only: change role / transfer | BUILT | `members_repo.set_role()` / `transfer_owner()` enforce in repo layer (lines 950, 1003) | — |
| Owner/admin: remove member | BUILT | `members_repo.remove()` enforces; admins can't remove owner/admins (line 977) | — |
| Member: read-only on assistant prompt | MISSING (server-side) | `PUT /workspace` and `PUT /workspace/base` have no `_require_admin` guard. Design gates the edit UI client-side only (line 695). A member with a PAT can overwrite workspace instructions. | File issue |
| Member: view-only on workspace-shared workers | BUILT | `_list_visible_workers(role=auth.role)` passes role to `repos.workers.get/list`; workers repo uses role to limit mutations. Brain edit also enforced server-side (`_require_context_for_user`). | — |
| Member: cannot share assets | BUILT | `AssetAccessRepository` enforces `can_share` (line 5669, 6990, 18644). `actor_id` checked in asset_access repo. | — |

---

## Summary counts

- **BUILT:** 30 elements
- **PARTIAL:** 3 (auto-pause toggle, email channel status, WhatsApp connection status)
- **MISSING:** 12 (workspace rename/region/timezone; approval default toggle; email failure toggle; model defaults; run limits + spend cap; delete workspace; global search; request-edit access; assistant write guard)
- **FRONTEND-ONLY (no backend needed):** 5
- **SKIPPED (pre-filed):** 2 (#772, #773)
- **Tracked by existing issues:** 2 (#731 feedback, #733 WhatsApp setup)
