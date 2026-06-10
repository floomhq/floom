# UI ↔ Backend full coverage — master matrix (2026-06-10)

Every surface of the wireframe (`docs/design/final.html`) audited against the real engine (`apps/api/`). Four area matrices hold the per-element evidence; this doc is the index + verdicts + issue ledger.

**Area matrices:**
- A — Overview / Workers / Runs: `coverage-A-workers-runs-2026-06-10.md`
- B — Brain / Connections / Approvals: `coverage-B-brain-connections-approvals-2026-06-10.md`
- C — Emily / Channels / New-worker: `coverage-C-emily-channels-2026-06-10.md`
- D — Settings / Nav / Roles: `coverage-D-settings-nav-roles-2026-06-10.md`
- Sharing/versioning pre-pass: `frontend-backend-divergence-2026-06-10.md`

## Per-area verdict

| Area | Mostly BUILT | Key gaps (issues) |
|---|---|---|
| Overview | All 4 tiles, sparklines, activity, coming-up (`GET /system/overview`) | — |
| Workers | List, run-now, archive, duplicate, versions+rollback, source edit, config (tools/brain/triggers/limits) | search #779, star #782, PATCH name/desc #785, pause/resume #788, brain attach/detach #790, spend cap #793 |
| Runs | Detail (output/artifacts/inputs/raw), replay, single-run ZIP | bulk export #796, share run #765, structured trace durations (derive from transcript) |
| Brain | Folder CRUD, multi-file upload, file edit/download, used-by, versions | sqlite viewer #777, tags #780, nested tree #783, move/rename #770 |
| Connections | OAuth catalog+flow, health sweep, activity, scopes post-connect, test/reconnect/remove | secrets unified #786, MCP live tools #789, last-used #802 |
| Approvals | Pending+count, approve/reject, reject reason+annotations, share link, standalone page, Slack buttons | type-aware preview #792, cost-so-far #795, TTL #798, WhatsApp yes/no #800, approve comment #769 |
| Emily | SSE chat `POST /chat`, conversations persisted+listable, create-worker `POST /workers/new/from-prompt` | recent-chats wiring #775, export #776, attachments #778 |
| Channels | Slack install+status, WhatsApp claim/bind, MCP install + PAT mint | whatsapp status #781/#801, email channel doesn't exist #787/#799 |
| Settings | Assistant (base/workspace/final prompt + versions), Members (invite/role/remove/transfer), export, Developer (PAT/CLI/MCP/API) | ws rename/region/tz #791, behaviour toggles #794, model defaults+limits+spend cap #797, delete workspace #805, per-user appearance #773 |
| Nav / roles | Approvals badge count, `GET /me`, logout, workspaces list/create/duplicate/share, role checks on most admin ops | ⌘K search #806, request-edit-access #807, **SECURITY: PUT /workspace[/base] unguarded for members #804** |
| Sharing | Visibility private/workspace/specific_people, HMAC links, workspace share/duplicate, import-from-share | link toggle #766, grants #767, access list #768, visibility filter #771, changelog #772 |

## Issue ledger (all `frontend-parity:` unless noted)

Pre-pass: #765 run share · #766 link toggle · #767 specific-people grants · #768 people-with-access · #769 approve comment · #770 brain move/rename · #771 visibility filter · #772 combined changelog · #773 per-user settings
Area A: #779 · #782 · #785 · #788 · #790 · #793 · #796
Area B: #777 · #780 · #783 · #786 · #789 · #792 · #795 · #798 · #800 · #802
Area C: #775 · #776 · #778 · #781 · #784 · #787
Area D: #791 · #794 · #797 · #799 · #801 · #804 (security) · #805 · #806 · #807
Pre-existing referenced: #731 feedback · #733 WhatsApp install · #762 Slack per-user identity

## Frontend adjustments applied to the wireframe (2026-06-10)

1. Email channel row: was mock-"Connected" — backend has no email channel (#787/#799) → now "Not connected".
2. Approval expiry copy removed (detail + standalone): approvals never expire today (#798).
3. OAuth modal: scopes can't be shown pre-consent (Composio) → copy now defers to the provider's consent screen.

## Implementation notes (no API change needed)

- "Paused" status = `enabled=false` (no separate enum value).
- Tile hover data = 28-bucket `runs_7d_sparkline` from `/system/overview`; per-worker `GET /workers/{id}/runs/timeseries`.
- Day-grouping + trigger filter on Runs are client-side over `trigger_source`/`created_at`.
- Tools add/edit and brain attach today route through full worker-YAML `PUT /workers/{id}/files` (until #790).
- Markdown file rendering is client-side; backend returns raw bytes.
- Trace step durations derived from transcript timestamps.
- Workspace switcher must branch OSS (multi-workspace routes) vs Cloud (no cross-workspace list).
- Recent-chats popover ← `GET /conversations?limit=5`; export chat can be client-side JSON download of `GET /conversations/{id}` until #776.
