# Workeros Audit Lane B: UI/UX and Asset Preview Verification

Date: 2026-06-01  
Lane: B, live UI/UX and asset previews  
Scope: OSS `/tmp/workeros-ui-round2`, Cloud `/root/workeros-cloud`  
Live targets: `https://workers.floom.dev`, `https://workeros.floom.dev/app`  
Constraint: audit only; no application code edits.

## Executive Summary

Score for this lane: 58 / 100.

The OSS web UI is deployed and navigable, and several recent UI concepts are present in code: the left-nav Brain item exists, worker detail has Brain and Versions tabs, Agent has a Versions tab, and MCP import support exists. The implementation is incomplete across the exact areas Federico flagged:

- Asset previews are not production-ready. XLSX 404s, PDF is blocked by CSP, large videos never render, and HTML only partially works.
- Brain attachment UI on worker detail is visually present but conceptually confusing: it states `0 brain resources attached` while immediately showing attachable packs in the same section.
- Versioning exists in backend code for workers, brain packs, and workspace instructions, but live API proxy calls for versions currently return `404`.
- Agent instructions are editable by default, with no explicit Edit mode.
- MCP server add still opens a raw form first; import exists but is not the primary command/config-centered flow Federico asked for.
- Dark mode and chip/button consistency remain partially unverified on authenticated Cloud because this lane had no Federico interaction and Cloud redirects anonymous browser sessions to login.

## Environment Evidence

Repos inspected:

- OSS HEAD: `7d820b1` (`fix overview viewport sizing`)
- Cloud HEAD: `d635005` (`validate cloud session cookie`)
- Cloud engine submodule: `7d820b1`

Recent relevant commits found:

- OSS `dd112b6` by Vivek: `feat(versioning): workspace instructions snapshots and rollback`
- OSS `afefd27` by Vivek: `feat(security): route worker DELETE requests through HITL approval`
- Cloud `dc04b38` by Vivek: `fix(web): sync dashboard from engine dd112b6 (agent versions, approvals HITL, api client)`
- Cloud `38eda4d` by Vivek: `chore(engine): bump to dd112b6 (workspace instructions versioning)`

Live access:

- `https://workers.floom.dev/brain` loaded and rendered.
- `https://workeros.floom.dev/app/brain` redirected to `https://workeros.floom.dev/login?next=%2Fapp%2Fbrain`; no authenticated Cloud UI testing was performed in this lane.
- Direct server-side curl to `https://workers-api.floom.dev/contexts` and `/healthz` returned Cloudflare `403`, while same-origin frontend proxy calls from `workers.floom.dev` loaded core UI data.

Screenshots captured:

- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-xlsx-direct-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-pdf-direct-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-video-direct-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-html-direct-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-weekly-update-brain-tab-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-agent-instructions-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-workers-mcp-add-form-2048.png`
- `/root/workeros-cloud/docs/launch-readiness/agent-runs/screenshots/lane-b-cloud-app-brain-login-2048.png`

## Findings

### P0: XLSX Preview Fails With 404

Status: reproduced live.  
Route: `https://workers.floom.dev/brain?pack=rocketlist-seo-reports&file=AggregateAnalytics_Federico%2520De%2520Ponte_2025-05-29_2026-05-28-2.xlsx`  
Screenshot: `lane-b-workers-brain-xlsx-direct-2048.png`

Live UI showed:

```text
Spreadsheet preview unavailable: Download failed (404)
```

Network evidence:

```text
GET /api/proxy/contexts/rocketlist-seo-reports/files/AggregateAnalytics_Federico%2520De%2520Ponte_2025-05-29_2026-05-28-2.xlsx -> 404
```

API detail returns the file path as a literal percent-encoded name:

```json
"path": "AggregateAnalytics_Federico%20De%20Ponte_2025-05-29_2026-05-28-2.xlsx"
```

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1432` defines `SpreadsheetPreview`.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1444` imports `jszip` and fetches `fileUrl`.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1448` throws `Download failed (${response.status})`.
- `/tmp/workeros-ui-round2/apps/web/lib/api.ts:335` builds file URLs by splitting and `encodeURIComponent`-encoding each path segment.

Likely root cause, verified by code plus live response: the backend returns a filename already containing `%20`; the frontend encodes `%` into `%25`, and the API cannot resolve the file. This is an asset-path normalization bug, not a spreadsheet-rendering-library problem.

Fix plan:

1. Normalize uploaded brain file names to decoded display paths at ingest time, or return a separate opaque file id/download path from the API.
2. Avoid treating returned display paths as raw URL path segments when they contain `%`.
3. Add regression test with a brain file whose stored name includes spaces and another whose literal filename includes `%20`.
4. Keep the existing `jszip` table preview after download works.

### P0: PDF Preview Is Blocked by CSP

Status: reproduced live.  
Route: `https://workers.floom.dev/brain?pack=rocketlist-seo-reports&file=Organizational%20Board%20Action%20in%20Lieu%20of%20First%20Meeting%20Consent%20(1).pdf`  
Screenshot: `lane-b-workers-brain-pdf-direct-2048.png`

The PDF file downloads successfully through the proxy:

```text
HTTP 200
content-type: application/pdf
content-disposition: attachment; filename="Organizational Board Action in Lieu of First Meeting Consent (1).pdf"
size: 71131 bytes
```

Browser console error:

```text
Loading plugin data from '/api/proxy/contexts/...pdf' violates Content Security Policy directive: "object-src 'none'".
```

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1391` renders PDF with `<embed>`.
- `/tmp/workeros-ui-round2/apps/web/next.config.ts:29` sets `object-src 'none'`.

Fix plan:

1. Replace `<embed>` with a renderer compatible with the deployed CSP, for example `pdf.js`/`react-pdf`, or render PDF pages server-side to safe image/canvas previews.
2. Keep download as fallback.
3. Add a browser test that opens a live/local PDF brain file and asserts visible PDF text/page canvas, not only HTTP 200.

### P1: Video Preview Path Exists but Large Videos Are Blocked Before Renderer

Status: reproduced live.  
Route: `https://workers.floom.dev/brain?pack=rocketlist-seo-reports&file=openbrowser-teaser.mp4`  
Screenshot: `lane-b-workers-brain-video-direct-2048.png`

Live UI showed:

```text
File is too large to preview inline (272.5 KB).
```

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:85` includes `video` in `FileKind`.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:95` classifies video MIME/path.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1282` blocks all files over `TEXT_PREVIEW_LIMIT` except image and PDF.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1395` has a `<video>` renderer, but the large-file guard runs first.

Fix plan:

1. Exclude `video` and `spreadsheet` from the generic text-size guard.
2. Use media metadata and streaming-friendly `<video controls preload="metadata">`.
3. Add a preview test with an MP4 larger than `TEXT_PREVIEW_LIMIT`.

### P1: HTML Preview Partially Works but Scripted HTML Is Blocked

Status: reproduced live.  
Route: `https://workers.floom.dev/brain?pack=rocketlist-seo-reports&file=floom-1st-connections.html`  
Screenshot: `lane-b-workers-brain-html-direct-2048.png`

HTML rendered in the iframe. Browser console logged:

```text
Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.
```

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1334` renders HTML preview.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1347` uses `sandbox=""`.

Assessment: blocking scripts is defensible for safety, but the UI currently labels this as plain `Preview` without explaining that interactive/scripted HTML is intentionally inert. This makes “HTML preview does not work” reports hard to debug.

Fix plan:

1. Keep script execution blocked by default.
2. Add an explicit “Safe preview: scripts disabled” state and an “Open isolated preview” option only if a separate sandbox origin is available.
3. Add raw mode as the reliable fallback for scripted files.

### P2: CSV Preview Exists in Code, No Live CSV Sample Was Present

Status: code-inspected, not live-tested.  
Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:92` classifies `.csv` and `.tsv` as `table`.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1359` renders table preview.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1416` parses delimited files with Papa Parse.

Fix plan:

1. Add a small CSV fixture to a non-production test pack.
2. Verify rendered and raw modes in browser.
3. Add Playwright coverage for CSV with long columns and >100 rows.

### P1: Brain Page Alignment and Header Clipping

Status: reproduced live.  
Routes:

- `https://workers.floom.dev/brain`
- Direct file routes listed above.

Symptoms:

- When a file is open, the main Brain container has three columns: pack list, file list, preview. Header heights line up at 82px, but the compressed left column makes pack names nearly unreadable.
- Selected file title truncates aggressively and loses the meaningful suffix/extension on long names.
- Preview failures occupy a huge blank pane with a single small error line.
- The top-level page has large unused left whitespace because the content is centered while the actual working surface is narrower than the viewport.

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:470` compresses pack pane to `lg:w-[10%] lg:min-w-[140px]` once a file is open.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:512` creates one unified bordered container.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:519` sets pack header height.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1002` sets file-list header height.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1192` sets file-pane header height.
- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx:1203` truncates the file title.

Fix plan:

1. Replace the 10% compressed pack list with icon-only or a stable minimum width that keeps selected pack names readable.
2. Use middle-truncation for file names so extension and end of title remain visible.
3. Add structured empty/error panels for preview failures with retry/download/raw actions.
4. Constrain the Brain working surface by viewport width rather than centering a narrow app inside unused whitespace.

### P1: Worker Detail Brain Attachment UI Is Confusing

Status: reproduced live.  
Route: `https://workers.floom.dev/workers/weekly_update#brain`  
Screenshot: `lane-b-workers-weekly-update-brain-tab-2048.png`

Live UI shows:

```text
Brain resources
0 brain resources attached to this worker.
```

Then immediately lists three brain packs with `Attach` buttons. This mixes “attached” and “available to attach” in one undifferentiated panel.

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2454` heading.
- `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2456` attached-count copy.
- `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2443` sorts attached packs first, then unattached packs.
- `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2517` renders all packs in one list.

Fix plan:

1. Split into `Attached brain packs` and `Available brain packs`.
2. If attached count is zero, render a focused empty state above the available list.
3. Rename button to `Attach pack` and provide a per-pack read/write selector before attach.
4. Display the YAML mount name and write mode after attachment.

### P1: Asset Versioning Backend Exists, Live Version Routes Return 404 Through Proxy

Status: code-inspected and live-verified.  

Code evidence:

- `/tmp/workeros-ui-round2/apps/api/db/_legacy_sqlite.py:1020` migration 44 creates `asset_versions`.
- `/tmp/workeros-ui-round2/apps/api/main.py:1974` defines `GET /workers/{worker_id}/versions`.
- `/tmp/workeros-ui-round2/apps/api/main.py:2113` defines `GET /contexts/{name}/versions`.
- `/tmp/workeros-ui-round2/apps/api/main.py:12008` defines `GET /workspace/versions`.
- `/root/workeros-cloud/tests/test_workspace_agent_migration.py:10` verifies Cloud `0013_asset_versions.sql`.
- `/root/workeros-cloud/apps/api/db/supabase_repos.py:2130` implements `asset_versions` access.

Live proxy checks:

```text
GET https://workers.floom.dev/api/proxy/workers/weekly_update/versions -> 404
GET https://workers.floom.dev/api/proxy/contexts/rocketlist-seo-reports/versions -> 404
GET https://workers.floom.dev/api/proxy/workspace/versions -> 404
```

UI state:

- Worker detail has a visible `Versions` tab.
- Agent page has a visible `Versions` tab in code and live UI.
- Brain page has no Versions tab in UI.

Assessment: the codebase has a versioning system, but the live OSS API behind `workers.floom.dev` is not serving the version routes through the current frontend proxy. Brain version UI is also missing.

Fix plan:

1. Deploy/restart the API that contains the version routes, or point the frontend proxy at the updated API.
2. Add `api.contexts.listVersions` and `api.contexts.rollback` to the frontend API client.
3. Add a Brain `Versions` tab/panel per pack.
4. Add browser tests covering all three version surfaces: worker, brain pack, workspace instructions.

### P1: Agent Instructions Are Editable by Default

Status: reproduced live.  
Route: `https://workers.floom.dev/assistant#instructions`  
Screenshot: `lane-b-workers-agent-instructions-2048.png`

Browser DOM check:

```json
{"hasTextarea":true,"readOnly":false,"disabled":false}
```

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:172` stores editable instructions state.
- `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:294` renders Save.
- `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:299` renders the textarea with no read-only/edit-mode gate.
- `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:381` renders the Versions tab.

Fix plan:

1. Default to read-only rendering for instructions.
2. Add explicit `Edit`, `Cancel`, and `Save` actions matching worker source edit behavior.
3. Keep dirty-state protection and version creation on save.
4. Rename `Final prompt` copy to clarify it is the resolved runtime system prompt, not a second editable instruction source.

### P1: MCP Add Flow Still Prioritizes Raw Form

Status: reproduced live.  
Route: `https://workers.floom.dev/connections/mcp`  
Screenshot: `lane-b-workers-mcp-add-form-2048.png`

Live UI after `Add MCP server` shows fields:

- Label
- Auth secret
- URL
- Allowed tools

Import exists, but it is secondary. The requested command/config UX is not the primary flow.

Relevant code:

- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:42` parses client config JSON.
- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:253` renders `Import config`.
- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:263` renders `Add MCP server`.
- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:274` renders the raw add form.
- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:336` renders import form.

Additional observation: the auth secret selector exposes secret names in the UI. It does not expose values, but the list of available secret names is visible.

Fix plan:

1. Make `Import config` / `Paste command` the primary empty-state path.
2. Support common MCP command snippets and client configs from Claude, Cursor, VS Code, Windsurf, Codex, and Generic.
3. Move raw URL form under `Advanced`.
4. Parse command/config locally, show detected server, auth method, and allowed tools before save.
5. Keep secret values server-side; display only labels after user confirms.

### P2: Dark Mode Consistency Not Fully Verified in This Lane

Status: partially blocked by session state.  

The live anonymous `workers.floom.dev` session in this lane rendered light mode. User-provided screenshots show dark-mode issues, and code uses many mixed tokens and ad hoc dark variants across the audited components. Examples:

- `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx` mixes `bg-white`, `bg-muted/20`, `bg-[var(--bg-card)]`, `bg-[var(--paper)]`.
- `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx` uses mixed badge/button classes and custom dark colors.
- `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:294` uses `bg-paper` in a raw `<select>`.

Fix plan:

1. Run a dedicated dark-mode browser pass with stable theme state.
2. Replace raw select/form controls with the project’s design-system components.
3. Standardize chips and buttons across Agent, Brain, worker detail, and MCP pages.

## Cross-Repo Sync Notes

The Cloud web copy contains the same audited files as OSS for these surfaces:

- `/root/workeros-cloud/web/app/contexts/page.tsx`
- `/root/workeros-cloud/web/app/workers/[id]/page.tsx`
- `/root/workeros-cloud/web/app/assistant/page.tsx`
- `/root/workeros-cloud/web/app/connections/mcp/page.tsx`

Cloud also has overlay copies for at least Agent:

- `/root/workeros-cloud/web/overlay/app/assistant/page.tsx`

Any UI fixes for these shared surfaces need to land in OSS first, then sync into Cloud without overwriting Cloud-specific auth/workspace wrapper behavior.

## Prioritized Fix Plan

1. Fix asset-preview infrastructure:
   - Normalize brain file download paths and add tests for spaces/percent signs.
   - Replace PDF `<embed>` with a CSP-compatible renderer.
   - Let video bypass the generic text preview limit.
   - Add explicit safe-mode copy for HTML previews.

2. Finish version UI:
   - Deploy/restart the updated API serving version routes.
   - Add Brain versions UI.
   - Verify Worker, Brain, and Agent version routes through `workers.floom.dev/api/proxy`.

3. Fix edit-mode semantics:
   - Agent instructions default read-only.
   - Edit/Cancel/Save mirrors worker source behavior.

4. Redesign worker Brain attachment:
   - Separate attached vs available packs.
   - Add attach-mode selector and clearer button labels.

5. Redesign MCP add:
   - Primary command/config import path.
   - Raw URL form under Advanced.
   - Add Codex/Windsurf/Generic client presets.

6. Run dark-mode visual pass:
   - Brain file viewer.
   - Worker detail Brain tab.
   - Agent tabs and versions.
   - MCP add/import.

## Verification Commands Run

```bash
git -C /tmp/workeros-ui-round2 status --short
git -C /tmp/workeros-ui-round2 rev-parse --short HEAD
git -C /root/workeros-cloud status --short
git -C /root/workeros-cloud rev-parse --short HEAD
git -C /root/workeros-cloud submodule status

curl -sS -D /tmp/workers-brain.headers -o /tmp/workers-brain.html https://workers.floom.dev/brain
curl -sS -D /tmp/workeros-cloud-app.headers -o /tmp/workeros-cloud-app.html https://workeros.floom.dev/app/brain
curl -sS -D /tmp/workers-api-contexts.headers -o /tmp/workers-api-contexts.json https://workers-api.floom.dev/contexts
curl -sS -D /tmp/workers-api-health.headers -o /tmp/workers-api-health.txt https://workers-api.floom.dev/healthz

curl -sS 'https://workers.floom.dev/api/proxy/contexts/rocketlist-seo-reports' | jq .
curl -sS -D /tmp/file-pdf.headers -o /tmp/file-pdf.bin 'https://workers.floom.dev/api/proxy/contexts/rocketlist-seo-reports/files/Organizational%20Board%20Action%20in%20Lieu%20of%20First%20Meeting%20Consent%20(1).pdf'
curl -sS -D /tmp/worker-versions.headers -o /tmp/worker-versions.body 'https://workers.floom.dev/api/proxy/workers/weekly_update/versions'
curl -sS -D /tmp/brain-versions.headers -o /tmp/brain-versions.body 'https://workers.floom.dev/api/proxy/contexts/rocketlist-seo-reports/versions'
curl -sS -D /tmp/workspace-versions.headers -o /tmp/workspace-versions.body 'https://workers.floom.dev/api/proxy/workspace/versions'
```

Browser verification used gstack browse at 2048x1152 and captured the screenshot paths listed above.

## Open Limitations

- Cloud authenticated UI was not verified because `https://workeros.floom.dev/app/brain` redirected to login in this non-interactive lane.
- CSV preview was code-inspected but not live-tested because the current live `rocketlist-seo-reports` pack has no CSV file.
- This lane did not edit app code, restart APIs, or deploy.

## Self-Audit

This report was checked against:

- Live browser screenshots for Brain default, XLSX, PDF, video, HTML, worker Brain tab, Agent instructions, MCP add form, and Cloud login redirect.
- Live network results for asset downloads and versions endpoints.
- Code references in both OSS and Cloud repositories.
- Git status and HEAD commit checks for both repos.

No application code was edited in this lane.
