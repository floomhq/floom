# UX audit: `/p/:slug` (AppPermalinkPage)

**Surface:** Public app permalink — the **web form** leg of Floom’s three surfaces (`docs/PRODUCT.md`: same app is also MCP + HTTP). **ICP:** non-developer AI engineer who needs production hosting without infra vocabulary; this page is where they (and their users) **run** the hosted app.

**Primary code:** `apps/web/src/pages/AppPermalinkPage.tsx`  
**Run shell (shared):** `apps/web/src/components/runner/RunSurface.tsx` (+ `OutputPanel`, `JobProgress`, `StreamingTerminal`, `InputField`, `InputCard`, `globals.css` `.run-surface-*`)  
**Errors / copy helpers:** `apps/web/src/lib/publicPermalinks.ts` (`classifyPermalinkLoadError`, `getPermalinkLoadErrorMessage`, `getRunStartErrorMessage`, `buildPublicRunPath`)  
**Chrome:** `TopBar` (`compact` when a run is in context), `Footer`, `FeedbackButton`  
**Optional live check:** `curl -sS "https://floom.dev/p/hash" | head -c 12000` — HTML shell shows correct **per-app** `<title>`, canonical, OG/Twitter, and JSON-LD in `<head>`; `<body>` is SPA + generic noscript (expected for CSR).

---

## 1. First impressions (5-second test)

| Checklist item | Assessment |
|----------------|-------------|
| What is this page for? | **Strong.** Hero shows app icon, name, version line, description (markdown), and primary “Run {name}”. Default **Run** tab keeps the form above the fold without scrolling past marketing. |
| Primary action | **Clear.** Run CTA in hero (`#run` anchor) + dominant **Run** tab + `RunSurface` primary button. |
| Visual focus | **Good.** Accent Run button and tab underline read as primary; meta card is clearly secondary. |
| Confusing / WIP | **Low.** “Source” tab is explicitly “Coming soon” with a real escape hatch (`/api/hub/{slug}/openapi.json`). Install tab is honest (Claude live, others waitlist). |
| Feels finished | **Yes** for core path; marketing + execution are integrated rather than bolted on. |

---

## 2. Information hierarchy

- **Hero + meta card:** Three-column grid (`icon | story | meta`) collapses to **single column** at `max-width: 900px` (`.permalink-hero-grid` in `globals.css`). Meta card follows story on narrow screens — sensible order.
- **Active run / shared run:** `TopBar` compacts and hero can collapse to a thin strip so **output** gets priority — aligns hierarchy with task phase.
- **Ratings:** Reserved `minHeight` in hero to avoid CTA jump when reviews load — good hierarchy stability.
- **About tab:** Long descriptions repeat in About; short copy is deduped — reduces noise.

---

## 3. Navigation & wayfinding

- **Where am I:** Breadcrumb `floom > store > [category] > {app name}` + document title; collapsed shared-run state still exposes `<h1>` with app name (a11y fix noted in code).
- **Back paths:** 404/retryable states link to **Back to all apps** (`/apps`). Breadcrumb links to `/apps`.
- **Tabs:** Run / About / Install / Source sync to `?tab=` (default Run omits param). **Gap:** `role="tablist"` on page tabs without paired **`role="tabpanel"`** / `id` + `aria-controls` / `aria-labelledby` — screen reader model is weaker than visual tabs (`ux-review-checklist.md` §9).
- **Creator-only:** “Open in Studio” and “Schedule” only when `sessionUserId === app.author` — avoids promising creator tools to visitors.

---

## 4. Interaction design

- **Clickable affordances:** Buttons and links are visually distinct; tab buttons have clear active state.
- **Hover:** Mostly inline styles; primary CTAs have transition on hero Run link — acceptable.
- **Forms:** Delegated to `RunSurface` / `InputField`: labels, optional-field disclosure, URL coercion, `aria-busy` on Run button — **strong**.
- **Loading:** Full-page skeleton mirrors hero + tabs + run card height (`aria-busy` on main) — addresses CLS called out in comments. Shared-run path shows **“Loading shared run…”** before mounting `RunSurface`.
- **Destructive:** No destructive actions on this page surface beyond dismissing celebration — appropriate.
- **Share:** Toast **“Link copied”**; when sharing a run, `shareRun` opt-in avoids 404 links for recipients — thoughtful.

---

## 5. Content & copy

- **404:** Plain language + literal path in `<code>` — clear.
- **Retryable load:** “App temporarily unavailable” + `getPermalinkLoadErrorMessage('app')` + **Try again** — explains and offers next step.
- **Dead shared run:** Amber “This run isn’t available” card with **Try this app →** — explains *and* recovers (`P2 #147` intent met).
- **Jargon:** “MCP”, “UUID format”, OpenAPI path — **Install** / **Source** skew technical; acceptable for “Add to your tools” and developer footnote, but ICP skimming Install may still feel dense.
- **Internal / dead UI:** `ComingSoonModal` + `comingSoon` state are wired for close, but **nothing sets `comingSoon` to non-null`** in current tree — dead branch (harmless, slight maintenance smell).

---

## 6. Visual design

- Tokens (`--card`, `--line`, `--accent`, `--muted`) used consistently with rest of app.
- Typography: large hero `h1`, tab strip 13px semibold — hierarchy reads.
- **Stars** in hero use fixed gold — consistent semantic “rating”.
- **Share toast:** Fixed bottom center — visible; safe-area not explicitly padded (minor on notched phones).

---

## 7. Mobile experience

| Checklist item | Assessment |
|----------------|------------|
| Not squeezed-only | Hero stacks ≤900px; **RunSurface** stacks at **≤1023px** (input above output) — real mobile layout. |
| Touch targets | Run surface primary button **44px** min height — good. Some permalink controls (breadcrumb chevrons, ghost Share) are smaller — **watch tab strip + “View details”** on small phones. |
| Horizontal scroll | Tab strips use `overflowX: auto` — acceptable pattern; avoid nested wide content in About. |
| Thumb reach | Primary run is mid-page after hero/tabs — **not** bottom-sticky; acceptable for web app, not optimal for one-thumb reach. |
| Modals | `ComingSoonModal` (if ever opened) is full-screen overlay with padding — likely OK. |
| Keyboard vs input | Not deeply audited here; `RunSurface` owns fields. |
| Body text | Generally ≥13px; hero description uses markdown component — readable. |

---

## 8. Edge cases & error states

| Case | Behavior |
|------|----------|
| Missing slug | Treated as not found path. |
| App load 404 | 404 screen + back to apps. |
| App load non-404 | Retryable message + reload + back to apps. |
| `?run=` wrong app | `run` param stripped; empty form — **silent**; acceptable security/product choice. |
| `?run=` 404 | Inline amber card + reset — **good.** |
| `?run=` 401 / network | Falls through to empty form — **intentional** per comments; user may not know why shared output vanished (tradeoff: don’t leak private existence). |
| `?run=` non-terminal status | Not hydrated; user sees fresh form — documented gap in code. |
| Reviews fetch fail | Summary `{ count: 0, avg: 0 }` — no scary error. |
| After success | Confetti (once per slug in LS) + inline **CelebrationCard** — clear success beat. |

---

## 9. Accessibility basics

- **Loading:** `aria-busy="true"` on loading main.
- **Run output:** `aria-live="polite"` on output region in `RunSurface`.
- **Tabs:** Page-level tabs missing full ARIA tab pattern (see §3). **RunSurface** action tabs same pattern.
- **Focus:** No skip-link audit in this pass; hash link `#run` moves focus depending on browser — minor.
- **Stars / icons:** Decorative SVGs use `aria-hidden` where applied in page-level components.

---

## 10. Performance perception

- Skeleton layout matches loaded layout — **low CLS** (explicitly motivated in code comments).
- `RunSurface` `minHeight` on run section reduces footer jump.
- Live `curl` shows font preconnect + single CSS/JS chunk — typical SPA; above-the-fold content depends on JS for interactive run UI (expected).

---

## Cross-surface consistency

- **Same mental model as MCP/HTTP:** Install tab surfaces MCP URL; hero/run path is the “human” execution surface — aligned with `PRODUCT.md`.
- **Studio bridge** only for owner — consistent permission story with share/run privacy behavior.

---

## Flaws before scoring (severity)

1. **Medium — Tab semantics:** Page (and multi-action) tablists without `tabpanel` wiring — checklist §9.  
2. **Low — Dead `ComingSoon` state:** Modal never opened from this page.  
3. **Low — Private / 401 shared run:** Silent empty form is correct for privacy but can feel “broken” to a naive recipient — consider ultra-generic hint if product accepts the tradeoff.  
4. **Low — Install `ConnectorCard`:** Card is an `<a>` wrapping a **Copy** `<button>` — valid pattern with `stopPropagation`; keyboard order may feel odd (minor).  
5. **Low — JSON-LD URL** hardcodes `https://floom.dev/p/...` in client effect while `og:url` uses `window.location.origin` — inconsistency for alternate deployments (edge case).

---

## Weighted scorecard

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|--------------|-------|
| Clarity | 25% | **8.5** | Run-first tab + hero; Install/Source labeled honestly. |
| Efficiency | 20% | **8.0** | Few clicks to run; collapsed chrome when output matters. |
| Consistency | 15% | **7.5** | Strong tokens; tab ARIA incomplete; rare dead modal branch. |
| Error handling | 15% | **8.5** | Retryable app load + dead run card + share fallbacks. |
| Mobile | 15% | **7.5** | Responsive grids; many hero actions; mid-page primary run. |
| Delight | 10% | **8.0** | Confetti + celebration + compact modes feel considered. |

**Overall (weighted): ~8.1 / 10**

---

## Suggested verification (manual)

1. `/p/{slug}` cold load: skeleton → hero, no layout jump.  
2. `/p/{slug}?run={finished}`: compact top bar, shared banner, output visible; **Try yourself** clears URL.  
3. `/p/{slug}?run=dead-id`: amber card + reset.  
4. `/p/{slug}?tab=install` deep link + **Add to your tools** from hero.  
5. **≤900px** and **≤1024px**: hero stack + run surface stack, no horizontal bleed.  
6. Keyboard: tab through page tabs and Run form, ensure focus visible on theme.
