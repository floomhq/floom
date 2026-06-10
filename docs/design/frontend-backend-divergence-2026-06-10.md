# Frontend–Backend Divergence Report
**Date:** 2026-06-10  
**Wireframe reference:** `docs/design/final.html`  
**Backend audit scope:** `apps/api/main.py`, `apps/api/models.py`, `apps/api/db/sqlite.py`

---

## Summary Table

| # | Feature | Frontend Design | Backend Status | Evidence (file:line) | Action |
|---|---------|-----------------|----------------|----------------------|--------|
| 1 | Share a RUN via link | Runs page has a "Share" button that opens the share modal; recipient gets a read-only run page with output/trace | **MISSING** — no run share link or public run endpoint exists; all `/runs/{id}` endpoints require owner auth | `main.py:10608` (GET /runs), `main.py:11747` (GET /runs/{id}) — both owner-scoped only | Backend issue [#765](https://github.com/floomhq/workeros/issues/765) |
| 2 | "Anyone with the link" public-link toggle per asset | Share modal shows a toggle switch to enable/disable the public link; toggle implies revocable, per-asset on/off | **PARTIAL** — `standalone_share_links` table stores one token per (entity_type, entity_id, owner_id) and it is always-derivable once created; no enabled/disabled column, no DELETE/revoke endpoint; the toggle in the UI cannot be wired to any backend action | `main.py:6154–6170` (`_ensure_standalone_share_links_table`), `main.py:6173` (`_create_or_get_standalone_share_link`) | Backend issue [#766](https://github.com/floomhq/workeros/issues/766) |
| 3 | Specific-people grants (invite specific users to an asset) | Share modal "Specific people" mode shows an invite-by-name-or-email search box and a people list with roles | **PARTIAL** — `specific_people` is a valid visibility enum value but is noted "reserved (UI hides it)" in three places; `grants_json` column exists on workers but no endpoint populates it with user-level grants; no invite/grant API; access check (`_worker_access_user_id`) resolves via workspace membership only, never via grants_json | `db/sqlite.py:2649–2651` (VISIBILITY_VALUES comment), `models.py:1638` ("reserved"), `db/sqlite.py:328` (grants_json parse, always `{}`), `main.py:3784–3807` (`_worker_access_user_id`) | Backend issue [#767](https://github.com/floomhq/workeros/issues/767) |
| 4 | People-with-access listing | Share modal shows a "People with access" section listing every person who can access the asset, with their role | **MISSING** — no endpoint exists to enumerate who has access to a worker/context/prompt; `/workspace/members` lists workspace members, not per-asset access | `main.py:894` (GET /workspace/members) — workspace-level only | Backend issue [#768](https://github.com/floomhq/workeros/issues/768) |
| 5 | Workspace share and duplicate (Notion-style) | Share modal supports `shareKind='workspace'`; recipient gets a read-only workspace page; design index has "Share / duplicate workspace" | **BUILT** — `GET /workspace/share-link` returns an HMAC-signed URL; `GET /workspace/template/{token}` serves a zip bundle; `POST /workspace/import` and `POST /workspaces/{id}/duplicate` cover the duplicate path | `main.py:9823` (share-link), `main.py:9840` (template download), `main.py:9887` (import), `main.py:737` (duplicate) | None |
| 6 | Approval comment on APPROVE | Standalone approval page shows a "Comment" textarea above the Approve/Reject buttons; optional note for the team | **PARTIAL** — `ApproveRequest` body contains `annotations` (structured) and `edited_output` but no plain-text `reason` field; `RejectRequest` has `reason`; `PublicApprovalDecisionRequest` (used by the public link endpoint) also omits `reason` on approve path | `main.py:10924–10931` (ApproveRequest / RejectRequest), `main.py:11164–11167` (PublicApprovalDecisionRequest), `main.py:11228` (approve path passes no reason) | Backend issue [#769](https://github.com/floomhq/workeros/issues/769) |
| 7 | Per-day run stats for sparklines/tooltips | Overview sparklines and worker cards show per-day run counts with tooltip drill-down | **BUILT** — `GET /workers/{id}/runs/timeseries` returns zero-filled per-day buckets; overview `runs_7d_sparkline` (OverviewSparklineBucket) and `runs_24h_sparkline` exist on `GET /overview` | `main.py:2350` (timeseries endpoint), `main.py:17847–17848` (sparkline fields on overview) | None |
| 8 | Brain file move/reorder + drag-drop upload | Brain page shows drag-row handle to reorder files; drop zone "Drag files here to upload"; files can be moved between folders | **PARTIAL** — `PUT /contexts/{name}/files/{path}` supports plain-body multipart upload; drag-drop in the browser can target this endpoint; but there is **no move/rename endpoint** (no API to change a file's path within a context without delete + re-upload) | `main.py:5783` (PUT context file), `main.py:5819` (DELETE context file) — no PATCH/move endpoint | Backend issue [#770](https://github.com/floomhq/workeros/issues/770) |
| 9 | Visibility filter on list endpoints | N/A in wireframe directly, but implied by member vs admin role views (member sees workspace-shared only) | **PARTIAL** — `GET /workers` has no `?visibility=` query param; filtering is baked into `_list_visible_workers` (owner sees all owned; `_worker_access_user_id` uses workspace membership for impersonation); there is no way for the frontend to explicitly request `?visibility=private` or `?visibility=workspace` | `main.py:5961–5990` (list_workers — no visibility param), `main.py:3887` (_list_visible_workers) | Backend issue [#771](https://github.com/floomhq/workeros/issues/771) |
| 10 | "Duplicate to my workspace" from a public share link | Public share standalone page has a prominent "Duplicate to my workspace" button; authenticated recipient can import in one click | **BUILT** — `POST /workers/import-from-share` consumes a share token and registers a new worker in the caller's workspace with deduplication | `main.py:6846–6869` (import_worker_from_share) | None |
| 11 | Workspace-level version history as one combined changelog | "Versions" button on the Assistant settings panel; the wireframe implies a unified history across workers + contexts + prompt | **PARTIAL** — per-asset version history is fully built: `GET /workers/{id}/versions`, `GET /contexts/{name}/versions`, `GET /workspace/versions` (prompt only); no combined/unified changelog endpoint exists that merges all asset types into one timeline | `main.py:2883` (worker versions), `main.py:2983` (context versions), `main.py:19994` (workspace prompt versions only) | Backend issue [#772](https://github.com/floomhq/workeros/issues/772) |
| 12 | Account settings vs workspace settings split | Settings page has "Developer" tab with PAT (personal, per-user) and "System"/"Members"/"Appearance" tabs (workspace-level); design treats PAT as per-user, not workspace-wide | **PARTIAL** — PATs exist and are per-user (`/auth/tokens` scoped to `auth.user_id`); however, settings like theme/appearance and workspace defaults have **no per-user storage** — "Appearance" tab is frontend-only in the wireframe; there is no `GET/PUT /user/settings` or `GET/PUT /users/{id}/preferences` endpoint | `main.py:21251` (GET /auth/tokens, per-user), `main.py:18621` (PUT /system/workspace-agent/settings — workspace-level only) — no user-level settings endpoint | Backend issue [#773](https://github.com/floomhq/workeros/issues/773) |

---

## Detailed Evidence Notes

### Item 1 — Run share link (MISSING)
The wireframe run detail page (line 554 in final.html) includes: `<button class="btn sm" onclick="openShareAsset('run','Run · ${rr.w}')">Share</button>`. This triggers the generic share modal for a run. The backend has no concept of a run share token or a public run endpoint. All run-read endpoints (`/runs`, `/runs/{id}`, `/runs/{id}/stream`, `/runs/{id}/events`) gate on `auth.user_id`.

Minimal API proposal:
```
POST /runs/{run_id}/share-link       → {token, url}      (owner only)
GET  /runs/public/{run_id}?token=    → read-only run detail (no auth required)
```
Reuse the existing `standalone_share_links` table; add `entity_type='run'`.

### Item 2 — Public link toggle (PARTIAL)
`standalone_share_links` has no `enabled` column (schema: `main.py:6158`). Once a token is created via `POST /workers/{id}/share-link`, it cannot be revoked. The UI toggle (line 423 in final.html: `<div class="sw on" ... onclick="this.classList.toggle('on')">`) implies a mutable on/off state per asset.

Minimal API proposal:
```
DELETE /workers/{worker_id}/share-link              (revoke = delete token row)
DELETE /contexts/{name}/share-link
DELETE /contexts/{name}/files/{path}/share-link
```

### Item 3 — Specific-people grants (PARTIAL)
`grants_json` is stored on the workers table (`db/sqlite.py:450`) but is always `{}` in practice; no endpoint writes user IDs into it. The `specific_people` visibility value is accepted by the API but the comment says "UI hides it" (`models.py:1638`). At access-check time, `_worker_access_user_id` only resolves workspace membership; it never reads `grants_json`.

Minimal API proposal:
```
GET  /workers/{id}/grants                → [{user_id, email, role}]
POST /workers/{id}/grants                → body: {email, role: "viewer"|"editor"}
DELETE /workers/{id}/grants/{user_id}
```
Same shape for `/contexts/{name}/grants`.

### Item 4 — People-with-access listing (MISSING)
The share modal "People with access" section (final.html line 421, `peopleSec`) needs a per-asset membership list. The workspace `/workspace/members` endpoint lists all workspace members but does not reflect per-asset visibility overrides or specific-people grants.

Minimal API proposal:
```
GET /workers/{id}/access   → [{user_id, email, display_name, role, source: "owner"|"workspace"|"grant"}]
GET /contexts/{name}/access
```

### Item 6 — Approval comment on APPROVE (PARTIAL)
The standalone approval page (final.html line 409) renders: `<h4>Comment</h4><textarea class="finp" rows="2" placeholder="Optional note for the team…"></textarea>` above the Approve button. `ApproveRequest` (`main.py:10924`) has only `edited_output` and `annotations` (structured). `RejectRequest` (`main.py:10929`) has a `reason: str`. The approve path has no equivalent plain-text comment field.

Minimal API change: add `reason: Optional[str] = None` to `ApproveRequest` and store it alongside the decision. Same for `PublicApprovalDecisionRequest` approve path.

### Item 8 — Brain file move (PARTIAL)
Upload works via `PUT /contexts/{name}/files/{file_path:path}` with a raw body (`main.py:5783`). The drag-drop zone in the wireframe (final.html line 612) can be wired to that endpoint. But the wireframe also shows a grip handle for reordering and implies files can be dragged between folders (i.e., moved). No move endpoint exists.

Minimal API proposal:
```
POST /contexts/{name}/files/{old_path:path}/move   → body: {new_path: str}
```

### Item 9 — Visibility filter (PARTIAL)
`GET /workers` accepts `include_system`, `include_archived`, and `shape` but no `visibility` param. For the role-aware member view the frontend would need to request only workspace-visible workers, but the current backend resolves this entirely server-side via `_worker_access_user_id` impersonation.

Minimal API proposal: add `?visibility=private|workspace|all` query param to `GET /workers` to allow the frontend to explicitly filter by visibility tier.

### Item 11 — Combined changelog (PARTIAL)
`GET /workspace/versions` tracks only `workspace.md` (the Emily system prompt). Per-worker and per-context versions are separate endpoints. The wireframe "Versions" button on the assistant page (`settingsBody('assistant')`) currently only maps to the workspace prompt history, but a proper combined changelog would merge worker edits, context edits, and prompt changes into a single timeline.

Minimal API proposal:
```
GET /workspace/changelog?limit=50  → [{asset_type, asset_id, asset_name, sha, message, committed_at}]
```
Implemented by fanning out to `_git_ops.get_log` across all tracked assets and merging by `committed_at`.

### Item 12 — Account vs workspace settings (PARTIAL)
PATs are correctly per-user (`/auth/tokens`). Theme ("Appearance" tab) and notification preferences are surfaced in the wireframe as per-user (e.g. "Toggle theme" in the account popover at final.html line 286). No `GET/PUT /user/settings` or `GET/PUT /users/{id}/preferences` endpoint exists. The `appearance` settings section in `settingsBody('appearance')` has no backend API to persist theme choice per user.

Minimal API proposal:
```
GET  /user/settings           → {theme: "day"|"dark"|"system", ...}
PUT  /user/settings           → body: {theme?, ...}
```
---

*This document was generated by automated backend audit against the wireframe. Do not modify manually; re-run the audit script to regenerate.*
