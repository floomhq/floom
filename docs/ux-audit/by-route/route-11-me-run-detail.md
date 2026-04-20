# Per-route UX audit — `/me/runs/:runId`

**Date:** 2026-04-20  
**Component:** `MeRunDetailPage` (`apps/web/src/pages/MeRunDetailPage.tsx`)  
**Method:** Code-first audit against `docs/PRODUCT.md` and `~/.claude/skills/ui-audit/references/ux-review-checklist.md`.  
**Note:** This route is **auth-gated (cloud)**; no live `curl` against production for a private run id.

---

## ICP lens (`docs/PRODUCT.md`)

The ICP needs **trust** that Floom “ran their thing” and produced **usable** results across **web form, MCP, and HTTP**—without reading raw JSON for every answer. This page is a **creator-side diagnostic** view: inputs, outputs, logs, and status. It is load-bearing for **transparency** after a run, but it is **not** the primary “paste repo → hosted” surface; it must still feel coherent with the **permalink / run** experience (`/p/:slug`, public run pages) and Studio links that land here.

---

## Summary

| Level | Count | Notes |
|------|------:|------|
| **S1** Critical | 0 | No ICP-breaking dead ends in code path; auth and 404 copy are handled. |
| **S2** Major | 3 | Stale data on run id change; output parity vs runner UI; weak recovery CTAs. |
| **S3** Minor | 4 | Duration copy, discoverability from `/me`, a11y/polish on code blocks. |
| **S4** Cosmetic | 2 | Visual alignment with design tokens vs hard-coded error reds. |

---

## Checklist highlights (per `ux-review-checklist.md`)

### First impressions & hierarchy

- **Clear purpose:** Yes — app name, action, status pill, inputs/output/logs match the file header intent (“single-run detail”).
- **Primary action:** Weak — after reading a failed run, there is **no** “Run again”, “Open app”, or “Fix secrets” path; only “Back to dashboard”.
- **WIP signal:** Inline styles and “W4-minimal” comment read as **internal / transitional** versus Studio polish.

### Navigation & wayfinding

- **Back:** “Back to dashboard” → `/me` is correct for mental model.
- **Where am I:** Browser title is `Run detail | Floom` — generic; no run short id or app slug in title.
- **Entry inconsistency:** `/me` run rows call `onOpen` → `navigate(\`/p/${slug}?run=...\`)` (`MePage.tsx`), **not** `/me/runs/:id`. Users arriving from **Studio** (`StudioAppRunsPage`, `StudioAppPage` link to `/me/runs/${r.id}`) get a **different** drill-down than from the hub dashboard — easy to think “I can’t find that JSON view again.”

### Interaction & feedback

- **Loading:** Plain “Loading…” — acceptable but no skeleton; no explicit **in-flight** cancel if user leaves.
- **Errors:** Fetch errors get a styled box; 404 gets a friendlier sentence. Run-level `run.error` is shown with `error_type` headline — good.
- **Stale UI risk:** On `runId` change, `run` / `error` are **not** reset before the new fetch; the previous run can remain visible until the new promise resolves (S2).

### Content & copy

- **“Started … · Nms”:** Raw milliseconds beside relative “Started X ago” is **engineer-first**; long runs are harder to scan than humanized duration (e.g. the pattern used in `OutputPanel` for duration).
- **404 message:** Human and privacy-preserving — aligns with scoped API behavior described in the page comment.

### Mobile & a11y

- **Touch:** Back control is a text `Link` without enlarged hit area — likely under common 44px touch-target guidance (S3).
- **Code blocks:** `<pre>` for JSON/logs has no **copy** affordance (contrast: `OutputPanel` uses `CopyButton` for strings).
- **Headings:** Single `<h1>`; section titles are styled `<div>`s, not heading elements — screen reader outline is flatter than ideal (S3).
- **Status pill:** Uppercase internal `status` string is shown raw — fine for creators, slightly jargon for ICP edge cases (`pending` vs `running`).

### Edge cases

- **Empty output/input:** Renders `{}` via `?? {}` / stringify — clear but not explained.
- **Missing `runId`:** Effect no-ops; user sees perpetual loading with no explanation (unlikely route config, but unchecked) (S3).
- **Huge JSON/logs:** `maxHeight` + scroll on JSON (320px) and logs (400px) — good; no “expand full” or download (S4).

---

## Runner / output components — what this page uses vs the rest of the app

`MeRunDetailPage` does **not** import the shared runner output stack (`OutputPanel`, `JsonRaw`, renderer cascade, `Markdown`, `ScalarBig`, `CustomRendererHost`, etc.). It implements:

| UI fragment | Role |
|-------------|------|
| Local `JsonBlock` | `JSON.stringify(value, null, 2)` inside a themed `<pre>`. |
| Local `StatusPill` | Ad-hoc color map per `status` string. |
| Inline `<pre>` | Dark terminal styling for `run.logs`. |

**Implication:** The same run may look **rich and interpreted** on `/p/:slug` or inside `RunSurface` / `OutputPanel` (renderer cascade, copy buttons, error taxonomy UX), but **flat JSON** here. For the ICP, that is a **cognitive split**: “What Floom showed me” vs “what Floom stored.”

Reference: `apps/web/src/components/runner/OutputPanel.tsx` (duration formatting, cascade, copy, retry hooks, links layered on errors).

---

## Findings (prioritized)

### S2 — Major

**M1 — Stale run body when `runId` changes**  
- **What:** `useEffect` depends on `runId` but does not clear `run` / `error` at the start of a new fetch. Navigating `/me/runs/A` → `/me/runs/B` can briefly show **A**’s inputs/output under **B**’s URL.  
- **Why it matters:** Misleading diagnostics; trust in logs/output for debugging.  
- **Files:** `apps/web/src/pages/MeRunDetailPage.tsx` (`useEffect` + state).

**M2 — Output / error experience diverges from primary runner UI**  
- **What:** No renderer cascade, no structured error recovery (e.g. Secrets link, retry, plain-language `auth_error` guidance called out in launch audit for `OutputPanel`).  
- **Why it matters:** ICP who fixed something in Studio still reads **raw JSON** and generic `error_type` here; parity with `OutputPanel` would reduce “two products” feeling.  
- **Files:** `MeRunDetailPage.tsx` vs `apps/web/src/components/runner/OutputPanel.tsx` (+ related output components under `apps/web/src/components/output/`).

**M3 — No forward path after inspection**  
- **What:** No links to `/me/apps/:slug/run`, `/studio/:slug`, `/p/:slug`, or secrets — only back to `/me`.  
- **Why it matters:** Creator flow after a bad run is “iterate”; this page is a **dead end** for action.  
- **Files:** `MeRunDetailPage.tsx`.

### S3 — Minor

**m1 — Discoverability**  
Hub dashboard opens the **permalink** with `?run=`, not this page (`MePage.tsx` `navigate`). Deep link to `/me/runs/:id` is mostly **Studio-originated** — document for product or add a consistent “Open technical detail” from `/me` if this view is first-class.

**m2 — Duration presentation**  
`run.duration_ms` appended as raw `ms` next to relative `formatTime` — less scannable than humanized duration elsewhere.

**m3 — `app_icon` unused**  
`MeRunDetail` includes `app_icon` (via `MeRunSummary`); header shows text only — missed chance for quick visual anchoring consistent with run rows on `/me`.

**m4 — Accessibility**  
Section labels are not headings; back link hit area; no copy-to-clipboard for JSON/logs.

### S4 — Cosmetic

- Error alert colors are **hard-coded hex** while body uses `var(--*)` — minor inconsistency.  
- Browser tab title could include short run id or slug for multi-tab debugging.

---

## Cross-screen consistency (short)

| Dimension | Assessment |
|-----------|------------|
| **vs `/me`** | Same `formatTime` and similar status semantics as run rows, but **different navigation target** from the hub list (permalink vs this route). |
| **vs runner surfaces** | **Weaker** output treatment than `OutputPanel` / custom renderer path documented as load-bearing in `docs/PRODUCT.md`. |
| **Auth** | `PageShell requireAuth="cloud"` matches other hub pages; session pending uses embedded `RouteLoading` (`PageShell.tsx`). |

---

## Weighted scoring (after flaws)

| Dimension | Weight | Score (1–10) | Comment |
|-----------|--------|--------------|---------|
| Clarity | 25% | 7 | Purpose clear; raw JSON is honest but not ICP-friendly. |
| Efficiency | 20% | 5 | Little help to act on findings; stale-state risk hurts trust. |
| Consistency | 15% | 5 | Diverges from `OutputPanel` and from `/me` open behavior. |
| Error handling | 15% | 7 | Good 404 copy and run error box; fetch errors generic. |
| Mobile | 15% | 6 | Scroll regions ok; back link / density could improve. |
| Delight | 10% | 4 | Functional diagnostic, not polished. |

**Overall (weighted): ~6.0 / 10**

---

## Files referenced

- `apps/web/src/pages/MeRunDetailPage.tsx` — page under audit.  
- `apps/web/src/components/PageShell.tsx` — auth gate + chrome.  
- `apps/web/src/api/client.ts` — `getMyRun` → `GET /api/me/runs/:id`.  
- `apps/web/src/lib/types.ts` — `MeRunDetail`, `MeRunSummary`.  
- `apps/web/src/lib/time.ts` — `formatTime`.  
- `apps/web/src/pages/MePage.tsx` — run row navigation (permalink vs `/me/runs`).  
- `apps/web/src/pages/StudioAppRunsPage.tsx`, `StudioAppPage.tsx` — links to `/me/runs/:id`.  
- `apps/web/src/components/runner/OutputPanel.tsx` — shared runner output patterns **not** reused here.  
- `docs/PRODUCT.md` — ICP and load-bearing runner/renderer context.
