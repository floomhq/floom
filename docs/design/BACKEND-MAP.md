# Backend reality map — every planned UI surface → real endpoint (2026-06-09)

Source: live probe of workers-api.floom.dev + the 2026-06-08 agent-interface audit (58 MCP tools).
Status: WORKS / BROKEN (filed) / MISSING (file) / VERIFY.

## The clean win: per-asset `permissions`
`GET /workers/{id}` and `GET /contexts/{name}` BOTH return a **`permissions`** object + `owner_id` + `visibility`.
→ The UI gates edit/share/delete directly off `permissions` (and shows `visibility`). **No custom role logic in the
frontend** — exactly the "super simple, no custom wiring" you wanted. The `<Collection>` reads `item.permissions`.

## Map

| UI feature (punchlist) | Backed by | Status |
|---|---|---|
| Worker list/detail/run/logs/delete | workers.* CRUD + runs.* | **WORKS** |
| **Version history** (workers, contexts, assistant) | `workers/{id}/versions` (200), `contexts.versions`, `workspace.versions` | **WORKS** — build it |
| **Archive** (smart tag + restore) | worker `archived` field + `workers.archive/restore` | **WORKS** |
| **Shared / Private** + view-only gating | worker/context `visibility` + `permissions` + `public_link` | **WORKS** — gate off `permissions` |
| **Duplicate / Fork** | worker `cloned_from` field | **WORKS** |
| **Example badge** | worker `is_example` (real field) | **WORKS** (so it's real data, your call to keep/hide) |
| Worker tags + folder | worker `tags`, `folder` | **WORKS** |
| Last run / recent stats (card hover) | `recent_stats`, `recent_runs` | **WORKS** |
| Brain folders + files + read-only/writeable | contexts: `read_only`, `writeable`, `sensitive`, `visibility`, `permissions` | **WORKS** — read-only flag is real |
| Brain binary `.db` / writeback (SQLite memory) | contexts binary-safe + writeable | **WORKS** (audit-verified) |
| **Emily earlier chats (history)** | `GET /conversations` (200) + `conversations.list/get` | **WORKS** — build the history list |
| Emily chat / workspace prompt | `workspace.chat`, `workspace.instructions.get/set` | **WORKS** |
| Connections / MCP / Secrets | connections.*, secrets.* | **WORKS** (remote MCP serve = 58 tools) |
| Runs detail tabs (Output/Inputs/Steps/Files/Logs/Raw/Metadata) | runs.* + logs/events | **WORKS** — align UI tabs to these |
| Triggers (per worker) | worker `triggers_spec` + `triggers.list` (MCP) | **WORKS** (REST `/triggers` 404 — triggers are per-worker) |
| Roles: member vs admin | session role + per-asset `permissions` + 403 on admin paths | **WORKS** (audit-verified) |
| **Approvals gate** | `approvals.required` does NOT pause | **BROKEN — #595** |
| Agent-install (MCP package / CLI) | npm `workeros-mcp` broken; CLI cred mismatch | **BROKEN — #596, #598** |
| PAT auth | `POST /auth/tokens` 500 | **BROKEN — #597** |
| **Member Feedback on a worker** | `GET /workers/{id}/feedback` → **404** | **MISSING — file** |
| **Nested Brain folders (folder-in-folder)** | contexts are FLAT (named folder + files; files can have sub-paths, folders don't nest) | **MISSING/decision — file** |
| **Channels (Slack / WhatsApp)** | not in MCP tool list; `integrations.catalog` exists; channel functionality unverified | **VERIFY — file** |

## Net
- ~85% of the planned UI is **already backed** — including the things I worried about (versions, archive, shared/private, fork, chat-history, read-only brain). Build freely.
- The `permissions` field makes the roles/sharing UI trivial (no frontend role logic).
- **3 genuine backend gaps to file for Vivek:** Feedback (missing), nested Brain folders (flat today — either model "nesting" via file sub-paths inside one folder, or add nested contexts), Channels Slack/WhatsApp (verify works + easy setup).
- 6 already-filed backend blockers (#594–#601) stand.

## Implication for the wireframe
- Run-detail tabs → **Output/Inputs/Steps/Files/Logs/Raw/Metadata** (match reality).
- Worker detail → add **Versions ▾** + **Share** + **Shared/Private** (all backed).
- Brain → folders are **flat**; show file sub-paths for "nesting" (don't promise nested folders until backend).
- Feedback → show the UI but mark it depends on the new backend issue.
