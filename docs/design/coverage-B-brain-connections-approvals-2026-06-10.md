# Coverage audit B — Brain · Connections · Approvals
**Date:** 2026-06-10  
**Source:** `docs/design/final.html` · `apps/api/main.py` · `apps/api/db/_legacy_sqlite.py`  
**Scope:** area B: Brain page, Connections page (+OAuth), Approvals (incl. standalone + Slack/WhatsApp)

---

## BRAIN

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Folder list — file_count column | BUILT | `ContextSummary.file_count` computed from `iter_context_files` (main.py:5392), returned on `GET /contexts` | — |
| Folder list — updated_at column | BUILT | `ContextSummary.updated_at = context_updated_at(root)` (main.py:5395) | — |
| Folder list — worker_count ("Used by N") | BUILT | `_context_worker_counts` (main.py:5155), single O(workers) pass, exposed as `ContextSummary.worker_count` | — |
| Folder create ("New folder") button | BUILT | `POST /contexts/{name}` (main.py:5620) | — |
| Folder detail — Files tab | BUILT | `ContextDetail.files: List[ContextFileItem]` on `GET /contexts/{name}` (main.py:5648) | — |
| Nested subfolders in a context | PARTIAL | Backend supports path-prefixed uploads (`path_prefix` param on `POST /contexts/{name}/upload`, main.py:5849) and dir-aware delete (main.py:5832). No separate "create subfolder" endpoint exists; subfolders exist only via uploading a file with a path prefix. Design shows them as first-class navigable items (breadcrumb navigation). No dedicated `GET /contexts/{name}/tree` endpoint. | File issue #NEW-B1 |
| File rows — size | BUILT | `ContextFileItem.size` (models via `context_file_metadata`) | — |
| File viewer — markdown render | BUILT (frontend) | `GET /contexts/{name}/files/{path}` returns raw bytes; inline for text/md. Backend sets correct MIME. Frontend renders markdown — no explicit endpoint gap. | FRONTEND-ADJUST: ensure markdown renderer is wired |
| File viewer — SQLite .db table/row viewer | MISSING | No endpoint to query a `.db` file's tables or rows. `GET /contexts/{name}/files/{path}` for binary `.db` forces `attachment` download (main.py:5762–5763). No `/contexts/{name}/files/{path}/query` endpoint. | File issue #NEW-B2 |
| File Edit | BUILT | `PUT /contexts/{name}/files/{path}` (main.py:5783) — JSON body with `content` | — |
| File Download | BUILT | `GET /contexts/{name}/files/{path}` returns `FileResponse` for binary (main.py:5764) | — |
| Breadcrumb navigation | FRONTEND-ONLY | Backend path is a flat string; breadcrumb is UI state. No server gap. | — |
| Drag-drop upload — single file | BUILT | `POST /contexts/{name}/upload` (main.py:5845) accepts `List[UploadFile]` | — |
| Drag-drop upload — multi-file | BUILT | Same `POST /contexts/{name}/upload` iterates `files: List[UploadFile]` (main.py:5894) | — |
| "Used by" tab — reverse worker lookup | BUILT | `ContextDetail.used_by: List[ContextWorkerRef]` on `GET /contexts/{name}` (main.py:5460); worker_id + worker_name | — |
| Folder share | BUILT (see area A) | `POST /contexts/{name}/share-link` (main.py:6892); #765–766 cover link toggle | — |
| Content category tags on Brain folders (marketing/accounting/research/data) | MISSING | `ContextSummary` has no `category` or `tags` field. The design tag-bar at Brain page (`tags.content: [['bf_mkt','marketing'],...]`, final.html:627) implies folders carry a category. No schema column, no API param for it. | File issue #NEW-B3 |

---

## CONNECTIONS

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| Connection list — all three types (OAuth/Connection, MCP, API key/Secret) | PARTIAL | `GET /connections` (main.py:14008) returns `ConnectionItem` rows with `kind: composio` (OAuth) or `kind: mcp`. **API key / secret type is NOT in ConnectionItem**. Secrets live in a completely separate `GET /secrets` endpoint (main.py:13206). The design shows one unified list. | File issue #NEW-C1 |
| List columns — account/endpoint | BUILT | `ConnectionItem.account_label` / `ConnectionItem.mcp_url` | — |
| List columns — type badge | BUILT | `ConnectionItem.kind` (composio / mcp) | — |
| List columns — extra (scopes / tools / last-used) | PARTIAL | Scopes: BUILT (`ConnectionItem.scopes: List[str]`, main.py:13289). MCP tools list: MISSING (no endpoint enumerates live tools from an MCP server). Last-used: PARTIAL — activity exists via `GET /connections/{id}/activity` (main.py:14454) returning recent runs, not a single `last_used_at` timestamp on the item. | File issue #NEW-C2 |
| List columns — status (active/reauth/error) | BUILT | `ConnectionItem.status` + auto-refresh (`_refresh_connection_status_for_list`, main.py:13552); hourly health sweep (main.py:235–316) | — |
| Connection detail — Overview tab | BUILT | `GET /connections/{id}/account-info` (main.py:14503) returns email, scopes, connected_at | — |
| Connection detail — Permissions tab (scopes list) | BUILT | Scopes cached in DB from Composio, returned in `ConnectionItem.scopes` and `/account-info` | — |
| Connection detail — Activity tab (usage log per connection) | BUILT | `GET /connections/{id}/activity` (main.py:14454) returns `List[RunSummary]` | — |
| MCP detail — Tools tab (live tool list from server) | MISSING | No `GET /connections/{id}/tools` endpoint. `ConnectionItem.mcp_allowed_tools` stores the operator-configured allow-list, not the server-advertised tool catalogue. | File issue #NEW-C3 |
| MCP detail — Config tab | BUILT | `ConnectionItem.mcp_command/mcp_url/mcp_transport/mcp_args/mcp_env/mcp_cwd` | — |
| API Key detail — Overview | BUILT | `GET /secrets` (main.py:13206) returns `SecretItem` with name, status, used_by | — |
| API Key detail — Used by | BUILT | `SecretItem.used_by: List[str]` computed from workers declaring the secret | — |
| Action: Test connection | BUILT | `POST /connections/{id}/test` (main.py:14681); returns `ConnectionTestResult` | — |
| Action: Reconnect/Reauth | BUILT | `POST /connections` re-initiates OAuth flow (main.py:14094); `GET /connections/by-app/{app}` shows existing account | — |
| Action: Remove | BUILT | `DELETE /connections/{id}` (main.py:14430) | — |
| Add connection — browse catalog | BUILT | `GET /integrations/catalog` (main.py:13363); per-app tools via `GET /integrations/catalog/{slug}/tools` (main.py:13439) | — |
| Add connection — OAuth start flow (redirect-based) | BUILT | `POST /connections` returns `redirect_url` (Composio-managed OAuth); callback at `GET /connections/callback` (main.py:14193) | — |
| OAuth consent screen — scopes preview | PARTIAL | Composio-managed OAuth; scopes are fetched AFTER connect via `/account-info`. No pre-consent scopes preview endpoint. Design shows scopes before user authorises. | FRONTEND-ADJUST: show post-connect scopes; pre-consent scopes require Composio catalog integration |

---

## APPROVALS

| Element | Status | Evidence | Action |
|---------|--------|----------|--------|
| List — pending count | BUILT | `GET /approvals/count` (main.py:10963) returns `{"pending": N}` | — |
| List — waiting badge (time ago) | BUILT | `approval.created_at` in rows from `GET /approvals` (main.py:10934) | — |
| Detail — Request tab: kv (worker, requested, why paused) | BUILT | `label`, `preview`, `created_at` in approval row; `decision_input_json` carries reason | — |
| Detail — Request tab: expires 24h display | FRONTEND-ONLY | No DB TTL column; "expires 24h" is display-only text in design (final.html:600). WhatsApp claim has a 24h `expires_at` (main.py:16664) but approval rows themselves have no expiry column. | FRONTEND-ADJUST: either show elapsed time or file separate TTL issue |
| Detail — Request tab: type-aware preview (email/CRM/tasks) | PARTIAL | `approval.preview` is a free-text string (TEXT column, _legacy_sqlite.py:930). No structured payload type field (e.g. `type: email\|records\|tasks`). The `apprPreview` function in the design dispatches on `a.ty` (email/records/tasks) — this `ty` field does not exist in the backend. `decision_input_json` carries structured inputs but is not typed for preview rendering. | File issue #NEW-A1 |
| Detail — Items tab | BUILT | Artifacts returned via `_approval_artifacts_for_response` (main.py:10973); `GET /approvals` response includes `artifacts` list | — |
| Detail — Run tab: link to paused run | BUILT | `approval.run_id` links to the run | — |
| Detail — Run tab: steps so far | BUILT | Run has `logs` and `tool_calls` on `GET /runs/{id}` | — |
| Detail — Run tab: cost so far (tokens · $) | PARTIAL | `RunDetail.total_tokens` available post-run (main.py:11868). No `cost_usd` field computed. Design shows "1.2k tok · $0.01" — no dollar cost field exists in backend. For a paused run the token count accumulated so far is not surfaced in the approval payload directly (must fetch `GET /runs/{id}` separately). | File issue #NEW-A2 |
| Approve / Reject | BUILT | `POST /runs/{id}/approve` + `POST /runs/{id}/reject` (main.py); also `POST /approvals/{id}/approve-action` for destructive kind | — |
| Comment on approve (#769) | OPEN ISSUE | Filed as #769 | SKIP |
| Share approval link | BUILT | `approval.public_link` in response (main.py:11027); `GET /approvals/public/{id}` | — |
| Approval expiry / TTL | MISSING | No `expires_at` column in approvals table. Design shows "expires 24h". WhatsApp claims expire, but approval decisions do not auto-expire. | File issue #NEW-A3 |
| Standalone approval page | BUILT | `/approvals/public/{id}` endpoints + HMAC token (main.py:11170–11264) | — |
| Slack approval buttons (Block Kit) | BUILT | `_slack_pending_approvals_response` (main.py:16007) generates Approve/Reject/Dismiss Block Kit buttons; Slack action handler at main.py:16249/16469 | — |
| WhatsApp approval reply-yes/no | MISSING | `_handle_whatsapp_message` (main.py:16906) routes ALL WhatsApp inbound text to the general assistant pipeline (`_collect_workspace_agent_reply_for_slack`). No special-case parsing for "yes"/"no"/"approve"/"reject" to resolve a pending approval. The design shows "Reply yes / no" as a functional flow. The engine audit confirmed this gap. | File issue #NEW-A4 |

---

## Summary

**BUILT:** 30 elements  
**PARTIAL:** 6 elements (nested subdirs, last-used timestamp, pre-consent scopes, approval type-aware preview, cost/dollar on run tab, MCP tools live list)  
**MISSING:** 7 elements (SQLite .db viewer, brain folder categories, secrets unified in connections list, MCP live tool enumeration, approval structured preview type, approval TTL/expiry, WhatsApp reply-yes approval)  
**FRONTEND-ADJUST (no backend gap):** 3 notes (markdown renderer wiring, elapsed time on approval expiry display, post-vs-pre-consent scopes)
