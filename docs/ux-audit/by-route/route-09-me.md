# Per-route UX audit — `/me` (`MePage`)

**Date:** 2026-04-20  
**Route:** `/me`  
**Component:** `apps/web/src/pages/MePage.tsx`  
**Mode:** Code-first UX / product review  
**ICP lens:** `docs/PRODUCT.md` (non-developer AI engineer; primary path *paste repo → hosted*; three surfaces web + MCP + HTTP)  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`

---

## Summary

| Level | Count | Notes |
|------:|------:|-------|
| **S1** Critical | 0 | — |
| **S2** Major | 2 | Cross-route thread deep link + “New thread” label vs `/me` reality |
| **S3** Minor | 6 | Touch targets, copy/positioning, loading ID collision, visual tokens |
| **S4** Cosmetic | 2 | Hardcoded alert colors; run-row width limits |

**Automated screenshots:** Not run in this revision. Prefer local Playwright captures at 390×844 and 1280×720 for `data-testid="me-page"` after `session` variants (signed-in with runs, empty, signed-out preview).

---

## Scope — what is *not* on this route

`MePage` renders **`PageShell` → single centered column** (`maxWidth: 820`, `contentStyle` clears shell max-width). It does **not** import or render:

| Piece | Where it lives | On `/me`? |
|--------|----------------|-----------|
| **MeRail** | `apps/web/src/components/me/MeRail.tsx` | **No** — used on `/me/apps/:slug/*`, `/me/apps/:slug/run`, secrets, etc. |
| **Composer** | Run/chat composer patterns | **No** — not part of `MePage`. |
| **Thread list UI** | `MeRail` (`threads` prop → Today / Yesterday / Earlier) | **No** — `MePage` implements **Recent runs** as a flat list with **Load more**, not grouped threads. |

**Cross-route implication (see S2):** `MeRail` still links **thread rows** to `/me?thread=<runId>` and labels a primary control **“New thread”** pointing at `/me`. `MePage` **does not read** `thread` from `useSearchParams()`, so those links land on the dashboard with **no thread selection or expansion**. That is a **product/IA mismatch** between rail vocabulary (chat) and `/me` vocabulary (history + shortcuts).

---

## Checklist walkthrough (`/me`)

### 1. First impressions (5-second test)

- **Purpose:** Clear — greeting + **Your apps** + **Recent runs** match the file header: *“What can I run, and what have I run?”*
- **Primary action:** For users with no history, **Browse apps** / **Try an app** is repeated in section headers and empty states; reasonable.
- **Attention:** Greeting (`h1` + avatar) dominates; aligns with identity-first dashboard feel.
- **Finished vs WIP:** Reads **finished** — structured sections, skeleton copy, dismissible banners.

### 2. Information hierarchy

- **Strong:** Section `h2`s (“Your apps”, “Recent runs”) vs greeting `h1`; curated **Try one →** row subordinate to headings.
- **Good:** Duplicate **Browse apps** link was removed from the header row (single link beside **Your apps**).
- **Risk:** Multiple stacked banners (welcome, first-run card, app-not-found, signed-out) can push **Recent runs** far down on small viewports — scan order gets noisy for first visits.

### 3. Navigation & wayfinding

- **Where am I:** Document title `Me · Floom`; TopBar treats `/me` as active (`TopBar` `isMe`). No breadcrumb — acceptable for a hub page.
- **Back / forward:** Browser back; internal links to `/apps`, `/p/:slug`, `/login?next=…`.
- **Mental model:** Comments state creator inventory moved to **`/studio`** — aligns with reduced duplication vs older `/me` shapes.

### 4. Interaction design

- **Clickable:** `ToolTile` is a full-card `Link`; run rows are `<button>`s with pointer/hover via title tooltip.
- **Loading:** Text skeletons (“Loading your apps…”, “Loading suggestions…”, `RunsSkeleton`) — no skeleton **shapes**; acceptable but plain.
- **Destructive:** None on this page; dismiss buttons on banners/notices.
- **Feedback:** `RunRow` uses `title={runRowTooltip(...)}` for full JSON on hover — power-user friendly; mobile users never see it (see S3).

### 5. Content & copy

- **Clear labels:** “Your apps”, “Recent runs”, “Load more”.
- **First-run publish card** emphasizes **OpenAPI URL** and samples — slightly **creator/API-centric** vs ICP’s primary **repo URL** story in `PRODUCT.md` (still valid as an onboarding path, but positioning is skewed toward OpenAPI wording).
- **Errors:** `AppNotFound` explains slug + dismiss; `ErrorPanel` prefixes “Couldn’t load runs.”

### 6. Visual design

- **Consistency:** Uses CSS vars (`--ink`, `--muted`, `--line`, `--card`, `--accent`) broadly; notice/error panels use **hardcoded** peach/red (see S4).
- **Typography:** `DM Serif Display` for headings vs system body — intentional brand contrast.
- **Spacing:** Regular section gaps (`marginBottom: 36` / `20`).

### 7. Mobile experience

- **Layout:** Single column, `padding: 32px 24px 96px`; grid `auto-fill minmax(170px, 1fr)` avoids horizontal scroll for the app grid.
- **Run rows:** `minHeight: 56` helps touch; app name `maxWidth: 200` may truncate aggressively on narrow screens.
- **Footer “Restart tour”:** Text `12px`, button with `padding: 0` — **small hit target** (see S3).

### 8. Edge cases & error states

- **Empty runs + not onboarded:** `FirstRunPublishCard` + auto-tour.
- **Empty runs + onboarded:** `FirstRunBrowseCard`.
- **No hub + no runs:** Fallback dashed empty with CTA.
- **Signed-out cloud preview:** `allowSignedOutShell` + banner + `EmptyRuns` variant — coherent.
- **`?notice=app_not_found`:** Good recovery path with dismiss cleans query.

### 9. Accessibility basics

- **Improved:** Greeting name is **`h1`** (page title); welcome dismiss has **`aria-label="Dismiss welcome"`**.
- **Status:** Welcome banner uses `role="status"`; app-not-found uses `role="alert"`.
- **Avatar:** Photo uses `alt=""`; initials span `aria-hidden` — name is still in `h1`.
- **Run row:** Status dot exposes `aria-label={`Status: ${status}`}`; truncated summary may still be opaque for complex inputs (tooltip not exposed to keyboard/screen reader users).

### 10. Performance perception

- **Client-side “Load more”** avoids refetch — snappy.
- **Two-phase loading** (runs then curated when empty) may cause **sequence of loading strings** (“Loading your apps…” → “Loading suggestions…”) — slight flicker risk.

---

## Findings

### S2 — Major

#### M1 — `/me?thread=` deep links from `MeRail` are ignored on `MePage`

- **Severity:** S2  
- **Category:** Navigation / consistency / dead affordance  
- **What:** `MeRail` `ThreadRow` navigates to `/me?thread=${run.id}` (`apps/web/src/components/me/MeRail.tsx`). `MePage` never reads `thread` from search params, so the URL **does not change selection, focus, or UI** on `/me`.  
- **Why it matters:** Users clicking a “thread” in the rail expect continuity; they get a generic dashboard. Breaks trust in sidebar navigation.  
- **Fix (product):** Either implement thread highlighting/open state on `/me`, **or** link threads to **`/me/runs/:runId`** (or `/p/:slug?run=`) consistently, **or** remove thread links until behavior exists.  
- **Files:** `MePage.tsx`, `MeRail.tsx`.

#### M2 — “New thread” labeling vs `/me` content

- **Severity:** S2  
- **Category:** Content / mental model  
- **What:** When `MeRail` has no `onNewThread`, **“New thread”** is a **Link to `/me`** — but `/me` is a **run history + app shortcuts** page, not a blank composer thread.  
- **Why it matters:** Chat-product vocabulary clashes with the v18 IA (comments: `/me` = user surface, not creator console).  
- **Fix:** Rename to **“Home”**, **“Dashboard”**, or **“Activity”** on routes that mount `MeRail`; reserve “New thread” for a future composer-backed behavior.  
- **Files:** `MeRail.tsx`, optionally copy review in `MePage.tsx` headers for parity.

---

### S3 — Minor

- **Tooltip-only detail on run rows:** Full input JSON is on `title`; no keyboard/non-hover access — consider disclosure pattern on `/me/runs/:runId` as canonical detail (out of scope here but affects this list).  
- **Restart tour control:** Underlined `12px` text, minimal padding — likely **below 44px** touch target; increase hit area or use a button style. (`MePage` footer.)  
- **Duplicate `data-testid`:** Both apps loading and curated loading use `data-testid="me-apps-loading"` — brittle for QA.  
- **First-run publish copy:** Lead with **repo paste** if product priority is repo→hosted (`PRODUCT.md`), or add one clause: *“or paste a GitHub repo”* beside OpenAPI.  
- **Signed-out + empty sections:** Users see **signed-out banner**, **Your apps** curated or empty, and **Recent runs** empty — repetition of “browse / sign in” — consider tightening vertical rhythm in a later pass.  
- **Tour auto-open:** Opening `Tour` from `/me` **immediately navigates to `/studio/build`** (`Tour.tsx`) — correct for anchors, but the user may perceive a “flash” of `/me` before redirect; optional polish: route tour entry from `/me` with replace navigation sooner or skeleton on `/studio/build`.

---

### S4 — Cosmetic

- **Alert styling:** `s.notice`, `ErrorPanel`, and welcome/error reds use **literal hex** (`#fdecea`, `#f4b7b1`, `#c2321f`) vs semantic tokens — minor inconsistency in dark/high-contrast theming.  
- **Run row layout:** Fixed `maxWidth: 200` on app name may feel tight; consider flex without cap on mobile.

---

## Weighted UX score

**Flaws considered:** S2 thread/deep-link gap, nomenclature; S3 polish items.

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|-------|
| Clarity | 25% | **8** | Purpose and sections are obvious; rail/thread vocabulary leaks hurt slightly. |
| Efficiency | 20% | **7** | Strong CTAs to `/apps` and `/p/:slug`; Load more is efficient; rail mismatch wastes clicks from sub-routes. |
| Consistency | 15% | **6** | In-app copy is consistent; **MeRail** vs `/me` thread model is inconsistent. |
| Error handling | 15% | **8** | Dismissible notices, run load error panel, empty states are helpful. |
| Mobile | 15% | **7** | Single column works; small footer control and truncation. |
| Delight | 10% | **7** | Greeting + curated suggestions feel human; loading strings are plain. |

**Overall (weighted): ~7.2 / 10**

---

## Cross-screen notes (holistic)

- **`/me` vs `/studio`:** Separation of consumer **history** vs creator **inventory** matches `PRODUCT.md` direction; ensure TopBar **Studio** remains discoverable for users who land from first-run publish.  
- **Three surfaces:** This page does not surface MCP/HTTP endpoints directly — acceptable for a **consumer hub**; protocol discovery remains on marketing/protocol routes.

---

## Files touched by this audit (read-only)

- `apps/web/src/pages/MePage.tsx`  
- `apps/web/src/components/me/ToolTile.tsx`  
- `apps/web/src/components/PageShell.tsx`  
- `apps/web/src/components/me/MeRail.tsx` (cross-route)  
- `apps/web/src/components/onboarding/Tour.tsx` (overlay from `/me`)
