# 03 — Vercel / Next.js Templates to Lift From

Workeros = Background Worker OS. Surfaces: `/workers` (list + sparklines), `/workers/<id>` (tabs), `/workers/<id>/runs/<run_id>` (long transcript), `/workers/new`, `/runs`, `/connections`, `/settings`. Need: dashboard chrome + chat-style run viewer + analytics cards + tabbed settings.

## Candidates

| Project | License | Fit | Lift | Surface |
|---|---|---|---|---|
| **prompt-kit** (ibelick) MIT, 2.8k★ | MIT | High — already in `/root/openchat-v2/components/prompt-kit/` | `<PromptInput>` (textarea+actions+attach, 206 LoC) for spec textarea; `<Message>`+`<Markdown>`+`<CodeBlock>`+`<Loader>` for streaming run transcript; `<FileUpload>` for artifacts | `/workers/new`, run viewer |
| **Vercel AI Chatbot** (vercel/chatbot) | Apache-2.0 | High — proven streaming UI w/ auth, history, artifacts | Artifact pane (split-view chat↔preview) → adapt as run transcript↔logs/artifacts tabs; resumable streams via AI SDK; sidebar history grouping | run detail, `/runs` |
| **Kiranism dashboard-starter** ~5.9k★ | MIT | High — Next.js 16 + shadcn + tables + parallel routes | Sidebar+header shell; TanStack DataTable w/ nuqs URL-state filters → `/runs`; parallel-route flyout (`@modal/(.)runs/[id]`); feature-folder layout | global chrome, `/runs`, `/workers` |
| **arhamkhnz next-shadcn-admin** ~1.5k★ | MIT | Medium — cleanest aesthetic, official Vercel template | Theme presets + collapsible sidebar variants → matte palette | global chrome, `/settings` |
| **Tremor** (Vercel-owned) | Apache-2.0 | High — copy-paste, now free | `<SparkAreaChart>` per row + `<Tracker>` (segment dots) for last-N runs strip; `<BarList>` for top-failing; KPI cards w/ delta% | `/workers` list, analytics |
| **dub.co** (@dub/ui) | AGPL-3.0 | Medium — AGPL viral, lift patterns not source | Time-series w/ 24h/7d/30d + hourly/daily granularity; zero-fill gaps; public-share dashboard w/ password | `/workers/<id>` analytics |
| **Cal.com** | AGPL-3.0 | Medium — reference only | Settings IA: nested `/settings/{profile,security,developer,billing,integrations}` w/ left sub-nav; API tokens screen + danger zone | `/settings`, `/connections` |
| **shadcn/ui examples** | MIT | High — primitives baseline | `<Sidebar>` collapsible, `<Command>` ⌘K palette, `<DataTable>`, `<Sheet>` flyout | global chrome |

Honorable mention: **satnaing/shadcn-admin** (11k★, Vite) has best ⌘K + RBAC reference — port patterns, not code.

## Top 3 Ranked Recommendations

### 1. prompt-kit (already in tree) — run viewer + `/workers/new`
Cost: **zero**. Files at `/root/openchat-v2/components/prompt-kit/`. Port to `/root/workeros/components/prompt-kit/`:
- `prompt-input.tsx` → `/workers/new` spec textarea (auto-resize, slash-commands, attach slot)
- `message.tsx` + `markdown.tsx` + `code-block.tsx` + `loader.tsx` + `scroll-button.tsx` → `/workers/<id>/runs/<run_id>` streaming transcript
- `file-upload.tsx` → artifact upload on run detail

Matte palette already partially aligned w/ openchat-v2.

### 2. Kiranism dashboard-starter — global chrome + `/runs`
Clone for shell only. Lift from `github.com/Kiranism/next-shadcn-dashboard-starter`:
- `src/components/layout/{app-sidebar,header,user-nav}.tsx` → Workeros chrome
- `src/features/<x>/components/<x>-table.tsx` (TanStack + nuqs) → `/runs` history w/ filters (status, worker_id, time)
- Parallel-route pattern → run detail flyout from `/runs`
- Strip Clerk, kanban, chat; keep shell, table, theme, sidebar.

### 3. Tremor blocks — `/workers` list + analytics
Copy-paste only what's needed:
- `SparkAreaChart` per worker row (last 30 runs)
- `Tracker` (segment dots) for at-a-glance worker health
- `BarList` on `/runs` for top-N failing workers
- KPI cards w/ delta% (total runs 7d, success rate, p95 duration)

## Cuts (don't bother)
- **Vercel commerce / nextjs-subscription-payments** — wrong domain (storefront/billing).
- **shadcnstore / Qualiora / TailAdmin** — strictly worse than Kiranism for our shape.
- **dub.co / cal.com source** — AGPL contagion; reference UX, don't copy code.

## Start order
1. Port `/root/openchat-v2/components/prompt-kit/*` → `/root/workeros/components/prompt-kit/` (1 commit).
2. `npx shadcn@latest add sidebar command sheet data-table` + lift Kiranism `app-sidebar` + `header` (1 PR).
3. `npx @tremor/cli add spark-area-chart tracker bar-list` → wire `/workers` row chart + `/runs` BarList (1 PR).
4. Build `/workers/<id>/runs/<run_id>` as prompt-kit chat-shape: `<Message>` per step, `<CodeBlock>` for logs, `<FileUpload>` artifact tab.
