# Per-route UX audit — `/studio/:slug/runs`

**Date:** 2026-04-20  
**Route:** `/studio/:slug/runs`  
**Component:** `StudioAppRunsPage` (`apps/web/src/pages/StudioAppRunsPage.tsx`)  
**Shell:** `StudioLayout` (`apps/web/src/components/studio/StudioLayout.tsx`); **header:** `AppHeader` from `MeAppPage.tsx`  
**ICP (from `docs/PRODUCT.md`):** Non-developer AI engineer with a localhost prototype who needs production hosting without learning Docker, reverse proxies, or infra plumbing. Success is **paste repo → hosted** with the **three surfaces** (web form `/p/:slug`, MCP, HTTP).  
**Checklist applied:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md` (code-first; no automated captures in this pass).

---

## Summary

| Level | Count | Notes |
|------:|------:|------|
| **S1** Critical | 0 | Core list + navigation path is coherent for owners. |
| **S2** Major | 1 | Failed **runs** fetch is indistinguishable from a true **empty** list. |
| **S3** Minor | 5 | Initial blank main, 404 redirect parity, row → `/me` context switch, table ergonomics on narrow viewports, touch target height. |
| **S4** Cosmetic | 1 | Raw `status` / `action` strings vs humanized labels. |

**Product alignment:** The page is the **“see all”** complement to the Studio Overview **recent runs** slice (source comment: overview shows the latest few; this page lists up to **100**). It reinforces the **permalink form** as the driver of runs (`/p/:slug`), consistent with the web surface in `docs/PRODUCT.md`. It does **not** implement hosting plumbing UI (appropriate for the ICP story).

---

## What this screen does (code-verified)

- **Document title:** `Runs · Studio` until `getApp` resolves, then `` `${app.name} · Runs · Studio` ``.
- **Auth / access:** `StudioLayout` redirects unsigned-in cloud “local” users to `/login?next=…`. `getApp` **403** → `navigate` to `/p/:slug` (not owner). **404** → `/studio` without the query-string notice used on `StudioAppPage` (see Cross-screen).
- **Data:** Parallel `getApp(slug)` and `getAppRuns(slug, 100)`. Runs request **on failure** sets `runs` to `[]` (no error surface).
- **UI blocks:** Global `error` banner for `getApp` failure; `AppHeader` + **All runs** heading; loading line for runs; empty state with `data-testid="studio-app-runs-empty"`; grid “table” with `data-testid="studio-app-runs-list"`.
- **Row interaction:** Each run is a `<Link to={/me/runs/${r.id}}>` — full row navigates to **Me** run detail, not a Studio-scoped URL.

---

## Checklist walkthrough

### 1. First impressions (5-second test)

- **Purpose:** Once `AppHeader` is visible, the **All runs** heading and column labels (**Started / Action / Status / Time**) communicate a **run log** for this app. Before `app` loads, the main column can appear **empty** (no skeleton), so the first 5 seconds may be **only Studio chrome** — weaker than the overview route which uses a loading skeleton (`StudioAppPage`).
- **Primary action:** **Open a run** (implicit: click a row). There is no primary **button**; the affordance is “pick a run.” That matches a log view but does not restate *where* the user goes (**Me**), which can surprise (**S3**).
- **Attention:** App name (from `AppHeader`) and the bordered list draw focus appropriately when populated.
- **WIP feel:** Styling (tokens, card, dashed empty state) reads **finished** for a utilitarian list — not a stub.

### 2. Information hierarchy

- **App** identity dominates via `AppHeader` (H1 = app name, description muted).
- **Section** “All runs” (14px bold) is secondary — correct.
- **Table header** is small-caps, muted — appropriate de-emphasis vs body rows.
- **Empty state** explains *how to get data* (share permalink) — aligns with ICP and **web form** surface.

### 3. Navigation & wayfinding

- **Where am I:** `activeSubsection="runs"` + `activeAppSlug={slug}` on `StudioLayout` should highlight **Runs** in `StudioSidebar`’s per-app sub-nav.
- **Back / escape:** Studio sidebar, `/studio` link, and TopBar behavior match other Studio routes. **No breadcrumbs** in-page (consistent with `StudioLayout` pattern).
- **Mental model:** Sidebar says **Studio**; row targets **`/me/runs/:id`**. A creator may not distinguish **Studio** (manage app) from **Me** (personal run history) without thinking — the jump is **logically valid** (run detail) but **spatially** inconsistent (**S3**).
- **Jargon:** Column **Action** shows the raw `r.action` string (often fine; can be internal identifiers on some apps) (**S4**).

### 4. Interaction design

- **Clickable rows:** Entire row is a link, `textDecoration: 'none'`, `color: 'var(--ink)'` — reads as tappable/clickable, especially with card chrome.
- **Loading:** `getApp` failure → red banner. **`runs` null** after `app` is set → “Loading…”. **Gap:** If `getApp` is slow, **no** main placeholder until the app object arrives.
- **Destructive:** N/A on this page.
- **Success/error for runs list:** **Errors are silent** — user may see **No runs yet** when the API actually failed (**S2**).

### 5. Content & copy

- **Empty state:** Instructs sharing **`/p/{app.slug}`** — clear, ICP-friendly, matches `docs/PRODUCT.md` public form surface. Edge case: **private** apps still show the same line; visibility nuance is not explained (owner may need “only you can open the form” — out of scope unless `AppHeader`’s private pill is enough).
- **Started column:** `formatTime` — relative for recent runs, `toLocaleDateString` for older. Comment in `time.ts` documents clock-skew handling — good for trust.
- **Time column:** Duration in **ms** (or **-**). Long runs in ms are **readable** but not as scannable as seconds for very large values (minor).
- **Status:** Raw `r.status` — if enums surface as `succeeded`, OK; if technical strings appear, ICP may stumble (**S4**).

### 6. Visual design

- **Tokens** (`--line`, `--card`, `--ink`, `--muted`, `--bg`) keep the list consistent with Studio.
- **Error banner** uses the same **fixed red** treatment as other Studio app pages (matches `StudioAppPage` error block).
- **Monospace** on **Action** aids scan for technical slugs; slightly “engineer” for the broad ICP but common in creator dashboards.
- **Grid** `1.5fr 1fr 1fr 80px` is clean on desktop; narrow widths may **compress** or wrap long action names (no `minWidth: 0` / overflow strategy on cells in source).

### 7. Mobile experience

- **Studio** hides `<900px` sidebar; **StudioLayout** exposes a **44×44** fixed **hamburger** (`aria-label="Open Studio menu"`). **Main** padding tightens at `max-width: 900px` in `globals.css` — not a “squeezed desktop” shell only.
- **Table:** Four columns in one grid on a narrow viewport can feel **tight** or force multi-line rows — **horizontal scroll** is not provided; risk of **overflow** or uneven row height (**S3**).
- **Touch:** Vertical padding per row is **12px** + line height — total row height may sit **under ~44px** target; worth validating (**S3**).

### 8. Edge cases & error states

- **No runs, truthfully:** Dashed **No runs yet** + helpful copy — **strong**.
- **No runs, falsely (API error):** Same as above — **bad** (**S2**).
- **100 runs, no “load more”:** Hard cap; older runs are **invisible** without a different view — acceptable for v1, worth noting for power users.
- **Offline:** Unhandled in-page (generic fetch behavior).

### 9. Accessibility basics

- **Headings:** `AppHeader` uses **h1** for app name; this page adds **h2** “All runs” — order is sound **when** `AppHeader` renders. Until then, the document may lack a visible **h1** in main (title tag still updates late).
- **List semantics:** “Table” is **div + CSS grid**, not `<table>` — screen readers get links without row/column header association. **S3** for screen-reader table ergonomics.
- **Links:** One link per row with meaningful text (time + action + status + duration text nodes) — acceptable, though verbose.

### 10. Performance perception

- **Double fetch** on load is parallel — good. **No skeleton** for app shell — main feels **empty** briefly. **100 rows** are static markup — expect fine unless runs are huge objects (they are not rendered in full).

---

## Cross-screen consistency (brief)

- **vs `StudioAppPage` (overview):** Same `AppHeader`, same `getApp` / `getAppRuns` pattern; overview uses **10** runs, this page **100** — expected. **404** handling differs: overview uses `/studio?notice=…&slug=…`, runs page uses **plain** `/studio` — **S3** inconsistency for “app missing” affordance.
- **vs `MeRunDetailPage` target:** List lives in **Studio**; detail in **`/me/runs/:id`** — functionally connected, **nav** story split (**S3**).

---

## Scoring (after flaws)

Weighted dimensions from checklist:

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|--------|
| Clarity | 25% | **7** | Good when rendered; first paint and /me handoff add friction. |
| Efficiency | 20% | **8** | Fast scan, one click to detail, sensible empty guidance. |
| Consistency | 15% | **6** | Studio vs Me URL + 404 redirect vs overview. |
| Error handling | 15% | **4** | App errors OK; **runs** failure path is misleading. |
| Mobile | 15% | **6** | Studio drawer OK; table density and row height are risks. |
| Delight | 10% | **5** | Utilitarian; empty copy is the strongest “human” moment. |

**Approximate overall (weighted): ~6.4 / 10**

---

## Prioritized follow-ups (this route only)

1. **S2 —** Surface **`getAppRuns` failure** separately from an empty list (message, retry, or non-destructive empty) so users do not conflate “no activity” with “could not load.”
2. **S3 —** Add a **lightweight loading state** for the main column when `app` is null (match `StudioAppPage`’s `LoadingSkeleton` pattern) to reduce blank first paint.
3. **S3 —** Align **404** redirect with `StudioAppPage` (query `notice` + `slug`) for consistent “app not found” education.
4. **S3 —** Validate **mobile** table layout (min widths, optional horizontal scroll, or row stacking) and **44px** row tap comfort.
5. **S3 —** Consider **copy or subtle hint** that row opens **run details** (and lives under the account **Me** area), or a Studio-consistent URL if product strategy allows.
6. **S4 —** **Humanize** or badge **status** (and long **action** strings) if raw API strings leak to the UI.

---

## Files referenced

- `apps/web/src/pages/StudioAppRunsPage.tsx`
- `apps/web/src/components/studio/StudioLayout.tsx`
- `apps/web/src/components/studio/StudioSidebar.tsx`
- `apps/web/src/pages/MeAppPage.tsx` (`AppHeader`)
- `apps/web/src/lib/time.ts` (`formatTime`)
- `apps/web/src/api/client.ts` (`getApp`, `getAppRuns`)
- `apps/web/src/styles/globals.css` (Studio mobile breakpoints)
- `docs/PRODUCT.md`
