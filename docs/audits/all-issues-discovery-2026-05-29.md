# Workeros — Exhaustive Every-Click UI Defect Inventory (2026-05-29)

**Target:** https://workers.floom.dev (prod, single-tenant OS view, signed in as Local user)
**Method:** self-hosted server Browser Broker live drive (pool-a, CDP 9223). Every interactive surface walked desktop (~1265px) AND mobile (375×812 via CDP device emulation). Every tab/filter/link/button clicked; every documented state exercised. Backend reads via `/api/proxy/*` with `.deploy-secret`. Console + network captured via CDP.
**Methodology:** comprehensive-ui-test-matrix (8-check per interactive element).
**Screenshots:** `docs/audits/shots-2026-05-29/` (file refs per defect below).
**Scope note:** DISCOVERY ONLY — no code changes. This is the punch-list to drive to zero.

---

## Summary by severity

| Severity | Count |
|----------|------:|
| **P0 (broken)** | 2 |
| **P1 (bad UX / data-correctness / leak)** | 11 |
| **P2 (polish / consistency)** | 14 |
| **Total** | **27** |

**Verified-FIXED since prior audits (no longer defects):** run-detail H1 now shows worker display name (was slug `research_brief`); Settings no longer has 4-6s "Loading..." flash; Settings CLI/MCP/API picker works (and per-target sub-picker Claude/Cursor/VS Code/Windsurf/Generic); token input is `type=password` masked; Connections shows real account identities + real scopes + Reconnect (PR #233); context file-switch via tree no longer shows a full-page skeleton (in-place swap works on click); worker-detail tabs scroll horizontally on mobile.

**FIXED + VERIFIED LIVE by batch (drive-to-zero progress):**
- **Batch A** (PR #244): P0-1, P1-1, P1-2, P1-3, P1-4, P2-1, P2-2, P2-3, P2-4, P2-5.
- **Batch B** (PR #243): P1-5, P1-6, P1-10, P1-11, P2-13, P2-14.
- **Batch C** (PR #245): P1-7, P1-8, P1-9, P2-6, P2-7, P2-8, P2-9, P2-10, P2-12. Details + per-item live evidence in `ISSUES.md` → "Batch C". Screenshots in `docs/audits/shots-batchC-2026-05-29/`.
- **Batch D** (PR #242): P0-2, P2-11. Details in `ISSUES.md` → "Batch D".

---

## Ranked master list (P0 → P2)

### P0 — Broken

**P0-1 — Worker Source/Code tab shows "No files found" for EVERY worker (regression).**
Surface: `/workers/<id>` → Source tab (hash `#code`). Tested csv_enricher and weekly_update — both show "No files found for this worker." The prior 2026-05-27 audit explicitly verified this tab rendered run.py / worker.yml / SKILL.md with syntax highlighting on csv_enricher. It is now empty across workers.
Root cause (confirmed): the worker-detail API (`/api/proxy/workers/<id>`) returns `files: []` (empty), but populates the flat legacy fields `manifest_yaml`, `run_py`, `run_py_content`, `skill_md_content`. Frontend `apps/web/app/workers/[id]/page.tsx:721` renders `files={worker.files || []}` → `FilesEditor` (`apps/web/components/worker-form/FilesEditor.tsx:154`) shows "No files found" on empty. The content exists server-side but is in the wrong field.
Evidence: `10-worker-csv-source.png`; API `files type: list len: 0` while `run_py_content` etc. populated.
Severity rationale: a core operator capability (inspect what a worker does) is dead for all workers.

**P0-2 — Context file viewer renders NO content on direct navigation / page refresh / shared link.**
Surface: `/contexts/<pack>/files/<path>`. Opening a file URL directly (e.g. `/contexts/worker-author-style/files/ANTI-PATTERNS.md`) shows the breadcrumb, file tree, "Markdown · 3.8 KB", and the Preview/Raw toggle — but the content pane is **completely empty in BOTH Preview AND Raw**. No console error, no 4xx (verified via CDP: 0 errors, 0 network failures).
Root cause (confirmed): `apps/web/app/contexts/[name]/files/[...path]/page.tsx`. `selectedFile` is `detail?.files.find(f => f.path === selectedPath)`. On first load `detail` is null (async), so `selectedFile` is null; the text-load effect (line ~105) early-returns `if (!selectedFile ...)` and apparently never re-fires for the URL-seeded file → `text` stays "". Clicking a *different* file in the tree works (see `15-context-file-switch-schema.png`), proving the fetch path is fine — only the initial URL-seeded file fails to load.
User impact: the "Copy link to this file" feature produces URLs that open blank. Refreshing a file view shows blank. Server returns the file fine (`curl /api/proxy/contexts/.../ANTI-PATTERNS.md` → 200 text/markdown, full body).
Evidence: `14-context-file-view.png` (blank Preview), bodyText snapshot ends at "Preview Raw" with zero content, `15-...` (content appears after a tree click).

---

### P1 — Bad UX / data-correctness / leak

**P1-1 — Worker detail flaky load: "Couldn't load worker — Something went wrong fetching this worker. Retry" on deep-link.**
Surface: `/workers/<id>` (e.g. `/workers/weekly_update#code` opened directly). First load showed the full error state; clicking **Retry** recovered it (so a transient/race fetch failure, not a permanent 404). User-facing error screen on a valid worker.
Evidence: snapshot bodyText "Couldn't load worker… Retry"; recovered after Retry.

**P1-2 — Run "completed" but PDF/DOCX export silently failed, shown as bare `false`.**
Surface: `/runs/<id>` → Result/Output. OpenDraft run `run_192471d3a456` is STATUS completed, but the Output table shows `PDF EXPORT SUCCESS: false` and `DOCX EXPORT SUCCESS: false` rendered as raw boolean strings. An operator sees a "completed" run whose two headline exports actually failed, communicated only by the word `false`. No warning/error treatment.
Evidence: `12-run-detail-opendraft.png`.

**P1-3 — Internal infra telemetry leaks into the operator-facing Logs view.**
Surface: `/runs/<id>` → Logs tab. Log lines expose: `Executing worker ([redacted-metadata], [redacted-metadata])` (literal unsubstituted "[redacted-metadata]" placeholders ×2), `[e2b] Spawning sandbox for run [redacted-id]` (leaks the infra provider name "e2b" + unsubstituted "[redacted-id]"), and an `[e2b]` prefix on every "Uploaded <file>" line. These are system/audit internals, not operator-meaningful logs.
Evidence: `13-run-detail-logs.png`.

**P1-4 — Raw internal error codes leak into operator views (multiple surfaces).**
Machine error prefixes with colons appear verbatim to the user:
- `/runs` list + `/runs` mobile: failed GitHub Digest row shows `missing_connection: github`.
- `/workers/<id>` History tab: failed run shows `output_validation_failed: enriched_csv file is too small (82 bytes, minimum 100)`.
These should be humanized ("Missing connection: GitHub", "Output too small").
Evidence: `11-runs-list.png`, `08-worker-csv-history.png`, `M03-runs-mobile.png`.

**P1-5 — Overview alerts: duplicated label "Missing secret: Missing secrets: …".**
Surface: `/overview` alerts bell dropdown. Each failing-worker alert reads `… · Missing secret: Missing secrets: SLACK_BOT_TOKEN, …` — a label prefix ("Missing secret:") concatenated with a message that already carries its own prefix ("Missing secrets:").
Evidence: `01-overview-alerts-dropdown.png`.

**P1-6 — Workers list tag expander "+25 more" does nothing (carried regression).**
Surface: `/workers`. Clicking "+25 more" does not expand the tag list — same set stays, "+25 more" remains. Reproduced desktop and mobile. (Flagged in the 2026-05-27 audit as "Show all (24)" broken; still broken.)
Evidence: `03-workers-tags-expanded.png` (identical to pre-click `02-...`).

**P1-7 — Connections "Status" column has no positive state for active connections (parity).**
Surface: `/connections` → Connected. Expired connections get an "Expired" pill, but GitHub, Gmail, LinkedIn (active, with real scopes/accounts) show a **blank** Status cell — no "Connected"/"Active" indicator. Status reads as "either Expired or nothing", so a healthy connection looks state-less.
Evidence: `16-connections-connected.png`.

**P1-8 — Infrastructure env vars are listed as deletable "Secrets".**
Surface: `/connections` → Secrets. `FLOOM_DB`, `FLOOM_WORKERS_DIR`, `FLOOM_ARTIFACTS_DIR` appear in the user Secrets list with Test / Update / **Delete** actions, alongside real API keys. These are system config, not user secrets; deleting `FLOOM_DB` from the UI could break the running system. Also inconsistent: API keys show "Used by: <worker>", these system vars show nothing.
Evidence: `19-connections-secrets.png`.

**P1-9 — Approvals "Go to platform" link: near-invisible (low contrast) + ambiguous in a single-tenant OS.**
Surface: `/approvals`. Two "Go to platform" links — the top-right one is extremely low-contrast grey-on-light (accessibility/legibility fail). "platform" is confusing copy in the OS (implies the separate Cloud product); destination unclear.
Evidence: `20-approvals.png`.

**P1-10 — Internal "smoke-test" worker exposed in the operator worker catalog.**
Surface: `/workers?folder=Operations`. "Node Smoke Test" — described as "Tiny Node worker that installs one npm dep (nanoid)… Proves the Node runtime + npm install pipeline" — is a developer runtime-proof artifact sitting in the operator-facing Operations folder as if it were a business worker.
Evidence: snapshot of `?folder=Operations` (`02-...` flow).

**P1-11 — "Coming up today" feed renders scheduled worker names with strikethrough.**
Surface: `/overview` "Coming up today". A customer's Bug Intake, A customer's Meeting Pipeline, and LinkedIn Post Engagements are rendered with **strikethrough** text (GitHub Digest Sender is not). Strikethrough in an "upcoming" list reads as cancelled/done — misleading for items that are about to run (likely keyed off paused/failing state, but the visual says "crossed off").
Evidence: `00-overview-desktop.png` (and `01-...`).

---

### P2 — Polish / consistency

**P2-1 — Run-detail stat labels are raw uppercased JSON keys.** `/runs/<id>` Output table shows `WORD COUNT`, `DURATION SECONDS`, `PDF EXPORT SUCCESS`, `DOCX EXPORT SUCCESS` — derived from output JSON keys, not human labels. (`12-run-detail-opendraft.png`)

**P2-2 — Worker Run tab "Enrichment instruction" is a single-line text input.** Long instructions truncate with no wrap; should be a textarea. (`06b-worker-csv-run-filled-retry.png`)

**P2-3 — Worker-detail tab hash naming is inconsistent.** About=`#about`, Run=`#run`, but History→`#runs`, Apps→`#connections`, Source→`#code`. Labels and hashes diverge. (snapshots of each tab)

**P2-4 — History tab: completed runs have no status pill, only failed ones do.** Parity gap — a "completed" pill should mirror the "failed" pill. (`08-worker-csv-history.png`)

**P2-5 — Triggers tab always shows Save/Discard chrome even with no unsaved change.** Editing affordances render unconditionally on a view-like tab. (`07-worker-csv-triggers.png`)

**P2-6 — Connections: expired rows show "— ↻" — a dangling refresh glyph next to a dash** in Scopes/Last-used columns, looking like a stuck loader; active rows show real values. Visual inconsistency. (`16-connections-connected.png`)

**P2-7 — Connections identity display is inconsistent.** Gmail/GitHub/LinkedIn show the real email/handle; Google Calendar (×2), Google Drive, Notion show opaque "account …849fe7" hash suffixes. Two expired Google Calendar accounts both labelled by hash. (`16-connections-connected.png`, `M05-connections-mobile.png`)

**P2-8 — Browse cards show a redundant lowercase internal slug under the human name** ("Gmail / gmail", "GitHub / github", "Google Calen… / googlecalendar"). The slug is the Composio toolkit id — dev-facing. Also the title truncates ("Google Calen…") while the slug shows fully. (`17-connections-browse.png`)

**P2-9 — Connections tab URLs are inconsistent.** Connected stays `/connections`, Browse → `/connections/browse`, MCP → `/connections/mcp` (and clicking from Browse landed `/connections/browse` while MCP tab content rendered) — mixed query-state vs path-state tab routing. (URLs across `16–19`)

**P2-10 — Settings package name vs binary name mismatch.** CLI install shows `npm i -g @floomhq/workeros` then `floom login` (binary "floom", package "workeros"). Potentially confusing; verify intentional. (`21-settings.png`)

**P2-11 — Context-file Preview code blocks render very low-contrast** (faint grey code on light background) inside the markdown preview; readability suffers. (`15-context-file-switch-schema.png`)

**P2-12 — Approvals empty-state card is half-width while the page is full-width** — container width inconsistent with Runs/Connections. (`20-approvals.png`)

**P2-13 — Overview "PDF/DOCX export false" + cross-view run-status staleness.** Overview showed OpenDraft as "Running" while `/runs` showed the same run "Completed 31m 11s" — stale cached status between views. (`00-overview-desktop.png` vs `11-runs-list.png`)

**P2-14 — Mobile: theme-toggle button rendered as an oversized outlined circle** next to the search/hamburger icons in the top bar — visually inconsistent sizing. (`M01-overview-mobile.png`)

---

## Index — by surface

| Surface | Defects |
|---------|---------|
| `/overview` (+ alerts bell) | P1-5, P1-11, P2-13, P2-14 (mobile) |
| `/workers` (list, filters, tags) | P1-6, P1-10 |
| `/workers/<id>` (tabs) | P0-1 (Source), P1-1 (flaky load), P2-2 (Run input), P2-3 (hashes), P2-4 (History pill), P2-5 (Triggers chrome) |
| `/workers/new` | (no defects found — describe flow + Generate enable verified) |
| `/runs` + `/runs/<id>` | P1-2 (export false), P1-3 (e2b/redacted leak), P1-4 (error codes) |
| `/contexts` + file view | P0-2 (blank content on direct nav), P2-11 (code contrast) |
| `/connections` (Connected/Browse/MCP/Secrets) | P1-7 (no active status), P1-8 (system vars deletable), P2-6, P2-7, P2-8, P2-9 |
| `/approvals` | P1-9 (low-contrast "Go to platform"), P2-12 (card width) |
| `/settings` (API/System/Appearance/Danger) | P2-10 (pkg vs bin name). Token mask, picker, danger-zone confirm all OK. |
| Mobile (375) | No layout breakage / horizontal scroll found; all P0/P1 reproduce on mobile too. P2-14 toggle sizing. |

## Index — by recurring class

| Recurring class (task-flagged) | Defects |
|--------------------------------|---------|
| Empty/placeholder where real data exists (wrong-field read) | **P0-1** (Source reads empty `files[]`), **P0-2** (file content not loaded), P1-7 (blank status) |
| Raw error JSON / internal IDs / system/audit telemetry leaking to operator | **P1-3** (e2b, [redacted-metadata], [redacted-id]), **P1-4** (missing_connection:/output_validation_failed:), P1-2 (bare `false`), P2-1 (uppercased JSON keys), P2-8 (internal slugs) |
| Filter/control does nothing on click | **P1-6** ("+25 more") |
| Dead / ambiguous link | P1-9 ("Go to platform"), P1-10 (smoke-test worker as product) |
| Inconsistent state/identity display | P1-7, P2-4, P2-6, P2-7, P2-9 |
| Confusing/duplicated copy | P1-5 ("Missing secret: Missing secrets:"), P1-11 (strikethrough upcoming), P2-3/P2-10 (naming) |
| Container/width/contrast polish | P2-11, P2-12, P2-14 |
| Full-page skeleton flash on in-place nav | NOT reproduced (file-switch via tree now swaps in place — fixed). The contexts bug is now worse-but-different: P0-2 (no content at all on direct nav). |
| Layout jump on filter/hover; size-change on hover; internal link → new tab | NOT reproduced (folder/tag filters reflow cleanly; no new-tab opens observed) |
| Console errors / 4xx-5xx | NONE found across overview/worker/contexts/run (CDP-verified clean) |

---

## Tooling note (for whoever re-runs this)
Broker `browser_screenshot` returns a stale/previous frame immediately after a click/navigate; a ~2000ms `browser_wait` before screenshot is required for an accurate capture. The DOM `browser_snapshot` is always current. Mobile (375) captured via direct CDP `Emulation.setDeviceMetricsOverride` on port 9223 (`/tmp/cdp_mobile.py`) since the broker exposes no resize tool.
