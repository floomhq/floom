# Trigger.dev — UI/UX Reference for Workeros

**License:** Apache 2.0 on `apps/webapp/` (verified in repo `LICENSE`) — port wholesale with attribution.

## Surface-by-surface

| Trigger.dev | Workeros target | Patterns to lift |
|---|---|---|
| `runs._index` + `TaskRunsTable` | `/runs`, `/workers/<id>` runs tab | Status pill via `runStatusClassNameColor` (semantic tokens `text-success`/`text-error`/`text-pending`/`text-amber-500`); `RunFilters` chips + `AppliedFilter`; `LiveTimer` ticking duration cell. |
| `runs.$runParam/route.tsx` (1880 LoC) | `/workers/<id>/runs/<run_id>` | `ResizablePanelGroup` split-pane (event tree left, span detail right); `RunTimeline` vertical status timeline; sticky header with status pill + Replay/Cancel/Reschedule dialogs. |
| `LogDetailView` + `LogsTable` | Run detail logs tab | Live-tail with `LogsLevelFilter`, per-line expand, `SpanEvents` for transcript-style output. |
| `runs.$runParam.stream/route.tsx` | Live run streaming | SSE route pattern for in-progress runs — exact shape we need. |
| `SideMenu.tsx` (1335 LoC) | Global chrome | Org/project header, grouped `SideMenuSection`/`SideMenuItem` with badge slots; `EnvironmentSelector` reusable as worker env pill. |
| `settings/*` routes | `/settings` | `MainHorizontallyCenteredContainer` + `Fieldset` + `FormButtons` for consistent settings layout. |
| `agents/` + `AgentView.tsx` | `/workers/new` | Worker-as-agent metaphor; lift config-tab + env-tab structure. |

## Top 3 wholesale ports (impact-ranked)

1. **Run detail page** — `runs.$runParam/route.tsx` + `RunTimeline.tsx` + `TaskRunStatus.tsx`. Directly fixes the "shit when in-progress" complaint. Split-pane + live timeline + status-driven icons is the single biggest UX delta.
2. **Runs list** — `runs._index/route.tsx` + `TaskRunsTable.tsx` + `RunFilters.tsx`. Production-grade filter+table covers `/runs` and the worker runs tab in one port.
3. **SideMenu + AppLayout** — `navigation/SideMenu.tsx` + `layout/AppLayout.tsx`. Sets the shell quality bar with sectioned nav, env selector, account menu, help popover, notifications.

## Files to reference when porting

- `apps/webapp/app/components/runs/v3/TaskRunStatus.tsx` — pills, icons, color tokens
- `apps/webapp/app/components/runs/v3/TaskRunsTable.tsx` — table, hover, selection
- `apps/webapp/app/components/runs/v3/RunFilters.tsx`, `SharedFilters.tsx` — filter chips
- `apps/webapp/app/components/run/RunTimeline.tsx` — vertical event timeline
- `apps/webapp/app/components/logs/LogDetailView.tsx`, `LogsTable.tsx` — live logs
- `apps/webapp/app/components/navigation/SideMenu.tsx` — sidebar
- `apps/webapp/app/components/primitives/` — Badge, Buttons, Dialog, Resizable, Tabs, DateTime, PrettyDuration, ClipboardField (copy wholesale)
- `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/route.tsx` — split-pane composition
- `apps/webapp/tailwind.css` — color tokens (`charcoal-*`, `success`, `error`, `pending`)

## Do NOT copy

- **TRQL dashboards / metrics charts** — overkill for v0, no telemetry pipeline yet.
- **Bulk actions** — premature; single-run actions cover MVP.
- **Deployments / branches / alerts / Slack-connect** — Trigger.dev-specific infra.
- **`SpanHorizontalTimeline` waterfall** — assumes OpenTelemetry spans; we have flat logs. Stick to vertical `RunTimeline`.
- **Org/project/env URL nesting** — Workeros is flat `/workers/<id>`; do not import the slug hierarchy.
