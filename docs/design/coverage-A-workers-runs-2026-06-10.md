# UI↔Backend Coverage Audit — Area A: Overview, Workers, Runs
**Date:** 2026-06-10  
**Sources:** `docs/design/final.html` (wireframe LoT) · `apps/api/main.py` · `apps/api/models.py`  
**Established facts not re-audited:** #765–773; visibility enum; HMAC share links; workspace duplicate/share; timeseries; import-from-share; versions+rollback; PUT /workers/{id}/files.

---

## OVERVIEW PAGE

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Tile 1: Runs completed 7d** (count) | BUILT | `GET /system/overview` → `OverviewStats.work_shipped_7d` (main.py:18859) | none |
| **Tile 2: Runs today** (ok / failed split) | BUILT | `OverviewStats.completed_today` + `failed_today` (main.py:18862-63, :18528-29) | none |
| **Tile 3: Workers active + paused count** | BUILT | `OverviewStats.active_workers_count` + `paused_workers_count` (main.py:18855-56) | none |
| **Tile 4: Coming up today count + next time** | BUILT | `OverviewStats.scheduled_24h_count` + `next_scheduled_at` (main.py:18866-67) | none |
| **Per-day sparkline hover values** (7d bucket totals) | BUILT | `OverviewStats.runs_7d_sparkline` → `List[OverviewSparklineBucket]` with `total`+`failed` per bucket (models.py:17870-74). NOTE: overview sparkline is 28-bucket/7d, not per-hour. Tile 1 sparkline hover data is not a separate endpoint — front-end must derive hover values from `/system/overview` sparkline array. | FRONTEND-ADJUST: use `runs_7d_sparkline` array; per-tile hourly sparkline hover not separately fetchable |
| **Worker activity list** (recent runs feed) | BUILT | `OverviewResponse.recent_runs` → `List[OverviewRunItem]` (main.py:18927) | none |
| **Coming up today list** (scheduled items) | BUILT | `OverviewResponse.scheduled_today` → `List[OverviewScheduledItem]` with `next_fire_at`, `trigger_label`, `paused` (main.py:18928, models.py:17894-17900) | none |
| **Needs-attention items** | BUILT | `OverviewResponse.needs_attention` → `List[OverviewAttentionItem]` (main.py:18929) | none |

---

## WORKERS PAGE

### List + filters

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Worker list** (name, description, tools, last run, status) | BUILT | `GET /workers` → `List[WorkerSummary]` (main.py:5961). Includes `tags`, `status`, `last_run`, `triggers`, `connections`. | none |
| **Search** (text filter on worker name/description) | MISSING | `GET /workers` has no `?q=` or `?search=` param (main.py:5962-5967). Filtering is FE-only today. | issue |
| **Tag filter: "starred"** | MISSING | No `starred`/`favorite` field on workers anywhere in models.py or DB schema. `WorkerSummary`/`WorkerDetail` have no star flag. | issue |
| **Tag filter: "recent"** | PARTIAL | No `?sort=recent` or `recently_used` field. `WorkerSummary.last_run` exists but there is no `recent` flag or dedicated recent-workers endpoint. FE can sort by `last_run.created_at` client-side. | FRONTEND-ADJUST: derive recent order from `last_run.created_at` |
| **Tag filter: "archived"** | BUILT | `GET /workers?include_archived=true` (main.py:5963-5990). `WorkerSummary.archived` flag included. | none |
| **Tag filter: "running"** | BUILT | `WorkerStatus.RUNNING` not in enum (enum has healthy/ready/needs_attention/missing_secret/error). Running workers show via `last_run.status == running`. FE can derive. | FRONTEND-ADJUST: use `last_run.status == running` to identify running workers |
| **Tag filter: "needs-attention"** | BUILT | `WorkerStatus.NEEDS_ATTENTION = "needs_attention"` (models.py:221). `WorkerSummary.status` carries it. | none |
| **Tag filter: content categories** (e.g. prod/personal/client-acme) | PARTIAL | `WorkerSummary.tags: List[str]` exists (models.py:1805). Tags are free-form strings on the worker's manifest. No taxonomy or client-side category filtering backend. FE tag filters work against the `tags` array. | FRONTEND-ADJUST: filter on `tags` array; no server-side category filter |
| **Counts: total workers / needs attention** | BUILT | Count derivable from list; `WorkspaceStats` at `GET /stats` gives `total_workers` + `active_workers` (main.py:2437). Needs-attention count not in `/stats` but derivable from list. | none |
| **Grid/list toggle** | BUILT (FE only) | Pure front-end layout toggle. `GET /workers?shape=list` returns a trimmed payload for list view (main.py:5970-73). | none |
| **Visibility (private/workspace) access filter** | PARTIAL | `WorkerSummary.visibility` returned per worker (models.py:1827). No `?visibility=` filter param on GET /workers. Issue #771 already filed. | skip (dupe #771) |

### Worker detail header + actions

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Status pill** (ok/running/failed/needs-attention/paused) | PARTIAL | Backend status enum: `healthy`, `ready`, `needs_attention`, `missing_secret`, `error` (models.py:213-223). No `paused` status value — paused = `enabled=false` + worker is not archived. Wire frame shows "paused" pill; backend surfaces it via `WorkerDetail.enabled=false`. | FRONTEND-ADJUST: map `enabled=false` → show "paused" pill; no separate `paused` status enum value |
| **Run now button + inputs modal** | BUILT | `POST /workers/{id}/runs` with `RunCreate.inputs` (main.py:10445). `GET /workers/{id}/sample-input` for default values (main.py:7260). | none |
| **Edit modal** (name, description, trigger manual/schedule/webhook, visibility) | PARTIAL | `PATCH /workers/{id}` handles trigger_type, cron_expr, cron_timezone (main.py:7306, models.py:1621-1629). Name/description changes require `PUT /workers/{id}` with full YAML payload (main.py:10027). No single PATCH field for name or description only. | issue |
| **Pause / Resume** | PARTIAL | No dedicated `POST /workers/{id}/pause` or `/resume` endpoint. `enabled` column is in the DB `allowed` set (db/sqlite.py:646) but no API endpoint exposes it directly to toggle. Pause is done via modifying the `enabled` field in the worker manifest (write worker.yml). | issue |
| **Delete** | BUILT | `DELETE /workers/{id}` (main.py:7566) | none |
| **Duplicate** | BUILT | Workspace duplicate at `/workspaces/{id}/duplicate`; per-worker duplicate via import-from-share path. | none |
| **Star** | MISSING | No `starred` field on workers. No `POST /workers/{id}/star` or `PATCH` endpoint with star flag. | issue (same as star filter above) |
| **Archive / Restore** | BUILT | `POST /workers/{id}/archive` (main.py:7136) + `POST /workers/{id}/restore` (main.py:7094). `WorkerSummary.archive_reason` included. | none |

### Worker detail — History tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Recent runs filtered by worker** | BUILT | `GET /runs?worker_id={id}` (main.py:10608-10612). `WorkerDetail.recent_runs` also included in detail payload. | none |

### Worker detail — Source tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Files list + file editor** | BUILT | `WorkerDetail.files: List[WorkerFile]` (models.py:1869). `PUT /workers/{id}/files` for edits (main.py:10229). Clone-on-edit for stock workers. | none |

### Worker detail — Config tab / Tools sub-tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Tools list per worker** | BUILT | `WorkerSummary.connections: List[str]` (Composio app slugs, models.py:1815). `WorkerConfig.connections` holds full spec. `GET /integrations/catalog` for catalog (main.py:13358). | none |
| **Add tool button** | PARTIAL | No `POST /workers/{id}/tools` endpoint. Adding a tool requires editing `worker.yml` via `PUT /workers/{id}` with updated YAML payload. | FRONTEND-ADJUST: tool add = edit YAML; wire through PUT /workers/{id} |
| **Tool "Edit" action** | PARTIAL | Same as add — no standalone PATCH for individual tool. | FRONTEND-ADJUST |

### Worker detail — Config tab / Brain sub-tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Brain folders attached (list with read/write access level)** | BUILT | `WorkerConfig.contexts: List[WorkerContextMountSpec]` (models.py:828). `WorkerContextMount.writeable: bool` carries read-only vs read-write permission (models.py:753-755). | none |
| **"+ Attach folder" button** | PARTIAL | No `POST /workers/{id}/contexts` endpoint. Attaching a context requires editing worker.yml contexts list via `PUT /workers/{id}`. No atomic attach/detach. | issue |

### Worker detail — Config tab / Triggers sub-tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Trigger type toggle (manual/schedule/webhook)** | BUILT | `PATCH /workers/{id}` with `trigger_type` (main.py:7338-7340). | none |
| **Cron expression + timezone** | BUILT | `PATCH /workers/{id}` with `cron_expr` + `cron_timezone` (main.py:7342-7346). | none |
| **Webhook URL display** | BUILT | `WorkerDetail.webhook_url` (models.py:1868). | none |

### Worker detail — Config tab / Limits sub-tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Max output tokens** | BUILT | `WorkerLimits.max_output_tokens` (models.py:956). Read from `WorkerDetail.config.runtime.limits`. Editable via full YAML edit (PUT /workers/{id}). | none |
| **Timeout** | BUILT | `WorkerLimits.timeout_seconds` (models.py:958). Same path. | none |
| **Approval policy** | BUILT | `WorkerConfig.approvals: WorkerApprovals` (models.py:831). Includes policy setting. | none |
| **Monthly spend cap** | MISSING | No `spend_cap`, `monthly_budget`, or cost-limit field anywhere in `WorkerConfig`, `WorkerLimits`, or any DB schema. | issue |

---

## RUNS PAGE

### List + filters

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Runs list** (worker, trigger, duration, status, started) | BUILT | `GET /runs` → `List[RunSummary]` with `trigger_source`, `duration_ms`, `status`, `started_at` (main.py:10608, models.py:1651). | none |
| **Runs grouped by day** | MISSING | `GET /runs` returns a flat list with optional `since`/`until` filters (main.py:10609-10615). No server-side day-grouping. FE must group by date from `created_at`. | FRONTEND-ADJUST: group by date(created_at) on FE |
| **Counts: failed, running** | BUILT | Derivable from list. `GET /system/overview` gives `running_now` + `failed_today`. No dedicated counts endpoint for runs page. | FRONTEND-ADJUST: derive from list or use /system/overview |
| **Status filter tags** (running/queued/completed/failed) | BUILT | `GET /runs?status=<value>` (main.py:10609). `_resolve_run_status_filters` handles multi-value (main.py:2020-2044). | none |
| **Trigger filter tag** | BUILT | `GET /runs?trigger_source=<value>` or FE filter on `trigger_source` field. Not an explicit query param but `trigger_source` is in `RunSummary`. | FRONTEND-ADJUST: FE filter on `trigger_source` |
| **Content category tag filter** | PARTIAL | Tags not on runs — they belong to workers. FE can filter runs by worker tag, but no direct run-level tag. | FRONTEND-ADJUST: filter runs by joining to worker tags |
| **"Export" button (run list)** | MISSING | No `GET /runs/export` or CSV/XLSX endpoint. Only per-run download: `GET /runs/{id}/download` returns a ZIP for a single run (main.py:11627). No bulk export. | issue |

### Run detail — Output tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Result text** | BUILT | `RunDetail.output` + `RunDetail.output_schema` typed fields (models.py:1721-1723). | none |
| **Output files list (artifacts)** | BUILT | `RunDetail.artifacts: List[Artifact]` (models.py:1725). Each `Artifact` has `id`, `name`, `size_bytes`, `path`. | none |
| **Artifact download** | BUILT | `GET /runs/{run_id}/artifacts/{artifact_id}/download` (main.py:11725). | none |

### Run detail — Trace tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Steps with durations** | PARTIAL | `RunDetail.transcript: List[Dict]` (models.py:1726) and `RunDetail.tool_calls: List[ToolCallEntry]` (models.py:1727). No structured per-step duration field; durations are embedded in transcript rows. | FRONTEND-ADJUST: derive step durations from transcript timestamps |
| **Logs** | BUILT | `RunDetail.logs: List[LogEntry]` (models.py:1724). Also `GET /runs/{id}/logs` (main.py:12720). | none |

### Run detail — Inputs tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Input key-value display** | BUILT | `RunDetail.input: Dict[str, Any]` (models.py:1720). | none |

### Run detail — Raw JSON tab

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Raw run JSON** | BUILT | `GET /runs/{run_id}` returns full `RunDetail` including `error_raw` (models.py:1732). | none |

### Run detail — Actions

| UI Element | Backend Status | Evidence | Action |
|---|---|---|---|
| **Replay** | BUILT | `POST /workers/{worker_id}/runs/{run_id}/replay` (main.py:10575). Re-runs with same inputs. `RunDetail.can_replay` flag signals eligibility (models.py:1729). | none |
| **Export (single run ZIP)** | BUILT | `GET /runs/{run_id}/download` returns ZIP with metadata + outputs + artifacts (main.py:11627-11694). | none |
| **Share run link** | MISSING | Issue #765 already filed. | skip (dupe #765) |
| **Open worker link** | BUILT | FE navigation to `/workers/{worker_id}` using `RunDetail.worker_id`. | none |

---

## SUMMARY: ITEMS NEEDING ISSUES

| # | Element | Type | New Issue? |
|---|---|---|---|
| 1 | Worker search (server-side `?q=` filter) | MISSING | yes |
| 2 | Worker star/favorite flag + toggle endpoint | MISSING | yes |
| 3 | PATCH /workers/{id} for name/description only | MISSING | yes |
| 4 | Pause/resume endpoint (toggle `enabled`) | MISSING | yes |
| 5 | Brain folder attach/detach without full YAML rewrite | MISSING | yes |
| 6 | Monthly spend cap field on worker limits | MISSING | yes |
| 7 | Bulk run list export (CSV/ZIP) | MISSING | yes |

## FRONTEND-ADJUST ITEMS (wireframe should adapt to backend model)

| Element | Adjustment |
|---|---|
| Tile sparkline hover values | Use `runs_7d_sparkline` buckets from `/system/overview`; no separate per-tile hourly data |
| "Paused" worker status pill | Map `WorkerDetail.enabled=false` to a "paused" visual pill; no backend `paused` enum value |
| "Recent" worker filter tab | Sort by `last_run.created_at` descending on FE |
| "Running" worker filter tab | Filter where `last_run.status == "running"` on FE |
| Content category tags | Free-form `WorkerSummary.tags` array; no taxonomy from backend |
| Tool add/edit in Config | Route through `PUT /workers/{id}` YAML edit; no atomic tool endpoint |
| Runs grouped by day | Group by `date(created_at)` on FE; backend returns flat list |
| Trigger tag filter on runs | Filter on `trigger_source` field on FE |
| Per-step trace durations | Derive from transcript row timestamps |
