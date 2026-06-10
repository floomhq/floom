# Coverage-C: Emily Side-Rail, Channel Modals, New Worker Flow
**Audit date:** 2026-06-10

---

## Matrix

| Element | Status | Evidence | Action |
|---|---|---|---|
| **EMILY CHAT** | | | |
| POST /chat — in-app streaming endpoint | BUILT | `main.py:20084` `@app.post("/chat")` streams SSE via `chat_service.stream_chat`; source param accepts `"web"` | — |
| Streaming/typing indicator | BUILT (backend) | SSE parts `{"type":"text",...}` / `{"type":"finish",...}` flow from `stream_chat`; FE shows typing dots in `emsg.emily .bub.typing` | — |
| Suggestion chips (canned prompts) | BUILT (FE-only) | `final.html:379` `suggest(t)` pushes to `emsgs` and calls `emilySend`; no backend needed | FRONTEND-ONLY OK |
| Conversation persistence — create | BUILT | `chat_service.py:426` `create_conversation`; auto-created on first message in `stream_chat` | — |
| Conversation persistence — list (GET /conversations) | BUILT | `main.py:20162` `GET /conversations` returns `ConversationSummary` list; `chat_service.list_conversations` | — |
| Conversation persistence — reopen (GET /conversations/{id}) | BUILT | `main.py:20172` `GET /conversations/{conversation_id}` returns messages + tool_cards | — |
| "View all chats" — FE design shows full list | PARTIAL | Backend supports `GET /conversations?limit=200`; FE design shows static mock list in popover (`final.html:502`), no real integration wired yet | FILE ISSUE |
| New chat (reset conversation_id) | BUILT (FE-only) | `final.html:378` `newEmilyChat()` clears `emsgs`; next `POST /chat` without `conversation_id` starts fresh server-side | — |
| Export chat (transcript download) | MISSING | `final.html:502` shows "Export chat" button; no `GET /conversations/{id}/export` or download endpoint exists in `main.py` | FILE ISSUE |
| Attachments: paperclip / file drop into chat | MISSING | `ChatRequest` model (`main.py:19814`) only has `{message, conversation_id, source}`; no `file_ids` field; `stream_chat` signature takes only `message:str`; `/uploads` endpoint exists but is not wired to `/chat` | FILE ISSUE |
| "Emily can make mistakes" footer | FE-ONLY | `final.html:509`; static disclaimer, no backend | FRONTEND-ONLY OK |
| Emily create-worker mode (prompt → draft worker) | BUILT | `main.py:8391` `POST /workers/new/from-prompt` launches worker-author run (async, returns `run_id`); also `POST /workers/draft-from-prompt` for sync YAML draft; `POST /workers/draft-and-create` for immediate create. FE `emode='create'` routes to same Emily input bar (`final.html:375,505`) | — |
| **CHANNEL MODALS** | | | |
| "Add Emily to Slack" — OAuth install URL | BUILT | `main.py:15731` `POST /slack/oauth/install` returns `{install_url, expires_at}`; callback at `GET /slack/oauth/callback` | — |
| Slack modal preview content | FE-ONLY | `final.html:435-436` static Block-Kit preview; no backend | FRONTEND-ONLY OK |
| "Add Emily to WhatsApp" — get number/QR | PARTIAL | WHATSAPP_PHONE_ID env var exists (`main.py:16589`); FE hardcodes `+1 555 160 9462` and a generated QR SVG (`final.html:440`). No `GET /whatsapp/status` or `GET /whatsapp/number` endpoint; claim flow is sender-initiated (bot sends link after first WA message). No endpoint for the frontend to fetch the current WA number or generate a QR dynamically | FILE ISSUE |
| WhatsApp sender claim/bind | BUILT | `main.py:16714` `POST /whatsapp/bindings/claim` + `_whatsapp_create_claim` internal; claim URL posted back to WA sender via `_whatsapp_claim_url` | — |
| "Install Workeros in your agent" — MCP config | BUILT | `main.py:17762` `GET /mcp` + `POST /mcp` MCP server endpoints; `npx @floomhq/workeros mcp` path; `final.html:445` references `Settings → Developer → MCP` | — |
| MCP per-user token mint | BUILT | `main.py:21261` `POST /auth/tokens` creates PAT (`wos_` prefix); `GET /auth/tokens` lists them. Design shows "Token + full config in Settings → Developer → MCP" (`final.html:445`) | — |
| Developer settings — Token tab (reveal/rotate) | PARTIAL | `GET /auth/tokens` lists; `POST /auth/tokens` creates; `DELETE /auth/tokens/{id}` deletes. No `POST /auth/tokens/{id}/rotate` endpoint (design shows Rotate button, `final.html:631`); workaround is delete + create | FILE ISSUE |
| Email channel — "Connect email" | MISSING | `final.html:449` shows email row in Channels page (Slack connected, WhatsApp not connected, Email shown as connected). No inbound email webhook, no email channel endpoint, no email-sender-binding in `main.py`. Only email-related backend is outbound alert emails for run notifications | FILE ISSUE |
| **NEW WORKER** | | | |
| "+ New worker" → Emily create mode | BUILT (FE bridge only) | `final.html:375` `newWorker()` sets `emode='create'`; FE full-screen Emily input; routes to `POST /workers/new/from-prompt` or `POST /workers/draft-and-create` as above | — |
| Direct POST /workers (yml/py/skill create) | BUILT | `main.py:9252` `POST /workers` accepts `WorkerDetail` payload; also `POST /workers/from-bundle` | — |
| Webhook trigger URL provisioning | BUILT | `main.py:6493-6543` webhook_url built via `webhook_service.build_webhook_url` and returned in `WorkerSummary`; `PATCH /workers/{id}` with `webhook_secret_rotate:true` rotates secret (`main.py:7355`) | — |
| Worker from template/example — list | BUILT | `GET /workers` returns `is_example` field on each `WorkerSummary`; stock workers on filesystem auto-discovered and exposed | — |
| Worker from example — instantiate / fork | BUILT | `main.py:10214` worker PUT/update clears `is_example` flag; `POST /workers/import-from-share` (`main.py:6846`) supports workspace template import; forking flow uses `_set_worker_yml_is_example(yml, False)` | — |
| "Recent chats" popover in Emily header (hydrated) | MISSING | FE design renders static mock entries (`final.html:502`); backend has `GET /conversations` but FE popover does not call it — static hardcoded list | FILE ISSUE (same as "View all chats") |

---

## FRONTEND-ADJUST items

| Item | What to do |
|---|---|
| WhatsApp number in modal | Replace hardcoded `+1 555 160 9462` with env/config fetch; add `GET /whatsapp/status` endpoint that returns configured phone number |
| Email channel row in Channels | Remove "Connected" mock state; show as "Not available" or hide until email channel is built |
| Export chat button | Disable/hide until export endpoint is built; or implement as client-side markdown export of rendered messages |
| "Recent chats" popover | Wire to `GET /conversations?limit=5`; replace static mock |
| Developer Token rotate button | Wire to delete-then-create flow until a dedicated rotate endpoint is added |

---

## Dedup notes (issues NOT filed — already covered)

- Slack events webhook, OAuth install, Block Kit approvals: BUILT (cited above)
- WhatsApp webhook + sender binding + send: BUILT (cited above)
- Approvals-over-WhatsApp: Area B handles
- Per-Slack-user identity gap (#762 covers shared Emily/Slack channel routing)
- Issues #765–#773: unrelated to Area C
