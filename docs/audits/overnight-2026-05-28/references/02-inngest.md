# Inngest dev-server UI — Workeros reference

## License + scrape-OK?
**SSPL v1.0 → Apache 2.0 future** (stricter than GPL). Source public, studyable. **Verbatim copy OFF-LIMITS:** SSPL § 13 force-opens the entire stack of any service using SSPL code. **Patterns only.**

## Surface-by-surface map

| Inngest | Workeros | Patterns to lift (re-implement) |
|---|---|---|
| `/functions` (FunctionsTable) | `/workers` | Sortable table, status-pill, per-row volume sparkline, app-grouping filter, blank-state card |
| `/functions/<slug>` (FunctionConfiguration) | `/workers/<id>` | Left tabs (Config/Runs/Triggers); config = `Category>Section>Block>Table` label-value rows + info popovers; right-rail Invoke CTA |
| `/runs/<id>` (RunDetailsV3) | `/workers/<id>/runs/<run_id>` | **Resizable split-pane**: left = nested Trace tree (depth-indented spans + timing bars), right = IO/output/logs tabs. `TopInfo` strip. Inline per-step expand. `Waiting.tsx` pulse on in-progress spans |
| `/runs` (RunsPage) | `/runs` | Sticky filter bar (time-field + date + status + app + function + CEL Beta). Infinite scroll. Inline expandable rows → embedded RunDetails. "Back to top" + "Refresh runs" on poll >1s |
| onboarding (`_onboarding/`) | `/workers/new` | Step-by-step subroute, AppCard preview |
| `/apps` | `/connections` | Card grid + status dot, AppDetailsCard, DescriptionListItem, EmptyCard |
| Global chrome | sidebar + theme | `Layout/` + `Navigation/`; layout-route via `__root.tsx + _dashboard.tsx` |

## Top 3 wholesale ports (ranked impact)

1. **RunDetailsV3 split-pane + Trace tree** — fixes "shit when in-progress" directly. Resizable 20–80% left, depth-indented spans, `Waiting` pulse on live steps, right tabs for IO/output/error.
2. **RunsPage filter-bar + infinite-scroll + inline-expand** — global `/runs` needs CEL search, multi-filter, no-pagination scroll, poll-aware refresh.
3. **FunctionConfiguration tabbed detail** — `Category > Section > Block` + hover popovers makes dense worker config legible.

## Files to study (DO NOT copy)

- `ui/packages/components/src/RunDetailsV3/` — Trace.tsx, Timeline.tsx, Span.tsx, GroupSpan.tsx, Waiting.tsx, IO.tsx, StepInfo.tsx, Tabs.tsx
- `ui/packages/components/src/RunsPage/` — RunsPage.tsx, RunsTable.tsx, RunsStatusFilter.tsx, columns.tsx
- `ui/packages/components/src/Functions/` — FunctionsTable.tsx, columns.tsx, useFunctionVolume.ts
- `ui/packages/components/src/FunctionConfiguration/` — Configuration{Category,Section,Block,Table}.tsx
- `ui/packages/components/src/Apps/` — AppCard.tsx, AppDetailsCard.tsx, EmptyCard.tsx
- `ui/apps/dev-server-ui/src/routes/_dashboard/` — route layout pattern

## Do NOT copy

- TanStack Router setup (Workeros = Next.js app-router)
- Inngest design tokens / brand Tailwind
- Any `*.tsx` content verbatim — SSPL contagion risk
- `RerunButton{,V2}.tsx` — coupled to Inngest backend
- Dual `RunDetailsV3 / V4` feature-flag complexity — pick one

## License note
SSPL is stricter than GPL for SaaS. Code into Workeros (closed, hosted) triggers § 13. Treat repo as **UX spec, not code source**.
