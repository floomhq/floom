# Per-route UX audit: `/studio` (Studio home)

**Date:** 2026-04-20  
**Route:** `/studio`  
**Primary components:** `apps/web/src/pages/StudioHomePage.tsx`, `apps/web/src/components/studio/StudioLayout.tsx`, `apps/web/src/components/studio/StudioSignedOutState.tsx`, `StudioSidebar` (via layout)  
**ICP reference:** `docs/PRODUCT.md` — non-developer AI engineer; primary journey is **paste repo → hosted** with **web form, MCP, HTTP** surfaces.  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Method:** Code-path review (no app changes; no live capture in this pass).

---

## 1. Route purpose & entry behavior

Within a few seconds, a signed-in creator should read this as **“my published apps, health at a glance, and a path to ship or open one.”** The hero, stat row, and app cards reinforce **inventory + runs**, which matches the product’s hosting-centric creator story.

**Auth / shell (`StudioLayout`):**

- **Cloud, not signed in:** `useSession` yields `cloud_mode && user.is_local` (synthetic “local” user). `StudioLayout` normally treats that as **must log in** and `navigate`s to `/login?next=…` **unless** `allowSignedOutShell` is true.  
- **`StudioHomePage` is the only route** observed passing `allowSignedOutShell={signedOutPreview}` (when `signedOutPreview` is true). That means **signed-out visitors on cloud can see `/studio` as a marketing-style preview** (`StudioSignedOutState`) instead of an instant redirect—addressing the “thin context / dead-end” risk called out in the launch audit (M5) for Studio, at least for the **home** URL.  
- **All other `/studio/*` pages** use the default `allowSignedOutShell={false}` → **redirect to login** with return path. This is a clear **soft gate on home, hard gate elsewhere**, which is coherent if the goal is to tease the workspace without exposing app data.  
- **Session pending:** `sessionPending` shows `TopBar` + `RouteLoading` (embed) only—no sidebar yet.  
- **OSS / non–`cloud_mode`:** `signedOutCloud` is false when `cloud_mode` is false, so the **login redirect effect does not run** for that branch; behavior depends on how the host exposes “mine” apps (out of scope here, but not a cloud-style gate).

**Verdict:** First impression for **cloud signed-out** is improved vs a bare redirect. Signed-in users get a **dense but legible** dashboard. **Gap:** deep links to other `/studio/*` routes while signed out still **bounce to login** without the rich preview—expected, but the mental model is “Studio needs auth” except the landing tile.

---

## 2. Checklist walkthrough (screen-specific)

### 1) First impressions

| Question | Assessment |
|----------|------------|
| What is this page for? | **Strong** for signed-in: owned apps, run stats, create/open. Signed-out: explainer + sign-in CTA. |
| Primary action | **“+ New app”** (top right) and sidebar **“New app”** are both obvious; empty state pushes **“Start publishing”** to `/studio/build`. |
| What grabs attention first? | Large **serif H1** and **ink CTA**—appropriate for a hub. |
| Confusing? | **“Ship your first app in 2 minutes”** (empty state) can **overpromise** relative to a full `BuildPage` flow—already flagged at product level in `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` (C2). |
| Feels finished? | **Yes** for layout, cards, stats, and empty state; **preview mode** is explicitly labeled “Signed-out preview.” |

### 2) Information hierarchy

- **Hero + stat row** (total runs, 7d, success rate, last activity) support **scan-first** understanding before drilling into cards.  
- **Per-app cards:** title → slug path → description → **7d sparkline** → totals/last run → actions. **Good** top-to-bottom priority.  
- **Status pill (`ACTIVE` / `IDLE`):** derived from 7d histogram, not a server `status` field—**honest in code comments**; users might still read “ACTIVE” as “deployed live” rather than “had runs this week.”

### 3) Navigation & wayfinding

- **Document title:** `Studio · Floom` via `StudioLayout` `title` prop.  
- **Sidebar:** “Studio” brand links to `/studio`; active app list when signed in. On **signed-out preview**, sidebar shows **hints** and **Publish an app** → `/signup?next=/studio/build` (different from main CTA which uses `/login?next=%2Fstudio` in `StudioSignedOutState`)—**two valid paths**; slight **consistency** question (login vs signup emphasis).  
- **Breadcrumbs:** Relies on **TopBar** studio mode (see `StudioLayout` comment + `TopBar`); not re-audited here in full.

### 4) Interaction design

- **CTAs** use clear button/link styles (`btn-ink`, ink/destructive borders).  
- **Card row:** inline `onMouseEnter` / `onMouseLeave` for border/shadow—**hover-only** affordance; **no problem for desktop**, **no feedback on touch** until tap.  
- **Delete:** **type slug to confirm** + disabled primary until match—**strong** destructive pattern. **Gap:** `handleDelete` uses **`alert()`** on failure—blocks the UI, **not** inline error, and **poor for a11y** vs a banner.  
- **Delete overlay:** `role="dialog"`, `aria-modal`, **backdrop click closes**; **no** `aria-labelledby` / focus trap visible in this file—**modal a11y** is partial.  
- **Loading:** list area shows “Loading…”; per-app sparkline shows **skeleton bars** until runs load—**good** progressive disclosure.

### 5) Content & copy

- **Microcopy** is mostly plain (“Publish, manage, and monitor every app you own”).  
- **Jargon:** **MCP** appears in `StudioSignedOutState` feature cards—**ICP** may know it; **peripheral** visitors might not—acceptable in **creator** context.  
- **“(no description)”** on cards is **clear** but slightly cold—optional polish.  
- **Numbers:** `toLocaleString()` for counts; **relative times** via `formatTime` (with clock-skew guard in `formatTime` implementation).

### 6) Visual design

- **Typographic system:** DM Serif (hero) + JetBrains Mono (labels, stats, paths)—**distinctive** and consistent with Studio comments.  
- **Semantic color:** error banner and delete button use **red** consistently.  
- **Stat pills** and cards use **shared** `--card`, `--line`, `--ink` tokens—**coherent** with the shell.

### 7) Mobile experience

- **Layout:** header row uses `flexWrap`; app grid is `auto-fill` / `minmax(300px, 1fr)`—on **narrow** screens the **+ New app** CTA **wraps** under the hero—**acceptable**.  
- **StudioLayout** exposes a **fixed bottom-left** `studio-mobile-toggle` (hidden by CSS until breakpoint—see `globals.css` reference in repo) to open the **drawer** sidebar—**thumb-adjacent**; main content **padding** `28px 40px` may feel tight on small phones—**verify in device**.  
- **Touch targets:** card actions are **~12px font** padding—**borderline** vs 44px guideline; **primary CTA** in header is `btn-ink`—**likely OK**; **Delete** as text button may be small.

### 8) Edge cases & error states

| State | Behavior | Gap |
|-------|----------|-----|
| **No apps** | Centered empty state + CTA to `/studio/build` | **Strong** |
| **Load error** (from `useMyApps`) | Red inline banner | **No retry** button — user must refresh |
| **Signed-out preview** | `StudioSignedOutState`; apps list not fetched for “real” data in main area | **By design** |
| **Per-app run fetch fail** | Sparkline falls back to **empty baseline**; page stays up | **Good** degradation |
| **Many apps** | N parallel `getAppRuns` calls (capped sample)—**could** slow on **dozens** of apps; **not** paginated |
| **Stats accuracy** | Hero metrics derived from **same 50-run samples** as sparklines—**not** a full history pass; **success rate** only counts finished runs in that sample—**good for direction**, not accounting-grade |

### 9) Accessibility basics

- **Sparkline** container is largely **`aria-hidden`**—**screen reader users** miss the trend; **no** text alternative summarizing 7d trend.  
- **Delete dialog:** confirm **input** has `data-testid` but **no** associated `<label>`—**placeholder of slug** is the instruction; **rely on** paragraph + `code` — **improvable** with `aria-describedby`.  
- **Focus:** delete dialog **autoFocus** on input—**good**; **restoration** on close not handled in snippet.  
- **Keyboard:** card **Delete** is a **button**; **Open/View** are links—**good**; modal **Escape** to close **not** shown in code.

### 10) Performance perception

- **Staggered load:** apps first, then **parallel** run fetches—**perceived** progress via sparkline skeletons.  
- **No** obvious layout jump on cards once runs resolve (bar heights animate).

---

## 3. Cross-screen consistency (brief)

- **Creator hub** is **aligned** with `docs/PRODUCT.md` emphasis on **owning** apps and **three surfaces** (preview copy mentions web, MCP, HTTP).  
- **Tension** remains between **“2 minutes”** marketing and **long publish path** (product-level, not only this file).  
- **StudioLayout** loading shell vs **full** shell: **same** `TopBar` + `RouteLoading` pattern as other studio routes for **session resolution**—**consistent**.

---

## 4. Findings summary (severity)

| ID | Severity | Topic | Notes |
|----|----------|-------|--------|
| H1 | **S2** | Copy / expectations | Empty state “2 minutes” vs actual `BuildPage` depth (see launch C2). |
| H2 | **S2** | Error UX | `alert()` on delete failure; no **retry** on `useMyApps` error. |
| H3 | **S3** | A11y | Delete modal and sparkline lack **full** a11y (labels, summary, Escape). |
| H4 | **S3** | Status semantics | **ACTIVE/IDLE** = activity-based; could be misread as **deployment** state. |
| H5 | **S3** | Mobile | **Hover-only** card chrome; **touch target** sizes on secondary actions. |
| H6 | **S3** | Stats fidelity | **Sample-based** success rate and 7d stats—fine for **owner glance**, not **audit**-grade. |

**Strengths worth keeping:** real run data for sparklines and aggregates (no lorem), **type-to-confirm** delete, **signed-out preview** on `/studio` only, **clear** empty state and **primary** publish path.

---

## 5. Suggested validation (non-blocking)

- Manual: **cloud signed-out** visit `/studio` → preview + sign-in; **signed-out** visit `/studio/build` or `/studio/foo` → **login** with `next=`.  
- Mobile: open **hamburger**, confirm **no horizontal scroll** on long app names.  
- Optional: Playwright **testid** map already present (`studio-home`, `studio-stats-row`, `studio-app-card-*`, etc.) for smoke automation.

---

## 6. Weighted score (per checklist; **code-first**)

*Flaws above considered before scoring. Numbers are **judgment** from static review, not user tests.*

| Dimension | Weight | Score (1–10) | Note |
|-----------|--------|-------------|------|
| Clarity | 25% | **8** | Clear hub; status labels + “2 min” copy slightly noisy. |
| Efficiency | 20% | **8** | Fast scan; N+1 run fetches may lag on huge inventories. |
| Consistency | 15% | **8** | Matches Studio shell; preview vs other routes is **intentional** split. |
| Error handling | 15% | **6** | Banners OK; `alert` and **no** retry on list load. |
| Mobile | 15% | **6** | Layout responsive; hovers and **small** controls need device pass. |
| Delight | 10% | **7** | Sparkline + typographic system feel **intentional**. |

**Approximate overall:** **7.3 / 10** (static).

---

## 7. Code index (read for this audit)

- `apps/web/src/pages/StudioHomePage.tsx` — page body, stats, cards, delete modal, `signedOutPreview` + `allowSignedOutShell`  
- `apps/web/src/components/studio/StudioLayout.tsx` — **auth gate**, loading shell, **mobile drawer** toggle, `document.title`  
- `apps/web/src/components/studio/StudioSignedOutState.tsx` — **signed-out preview** content  
- `apps/web/src/components/studio/StudioSidebar.tsx` — **signed-out** link variants, app list, **New app** CTA  
- `apps/web/src/hooks/useSession.ts` — `cloud_mode` + `is_local` semantics  
- `apps/web/src/hooks/useMyApps.ts` — app list + cache  
- `apps/web/src/lib/time.ts` — **relative** timestamps for “last” labels  
- `apps/web/src/main.tsx` — **route** registration for `/studio`
