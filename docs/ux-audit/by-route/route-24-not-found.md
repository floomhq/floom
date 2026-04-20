# Per-route UX audit — route 24: catch-all `*` (`NotFoundPage`)

**Date:** 2026-04-20  
**Route:** React Router `<Route path="*" element={<NotFoundPage />} />` (matches any path not declared above it in `apps/web/src/main.tsx`).  
**Component:** `apps/web/src/pages/NotFoundPage.tsx`  
**ICP / checklist:** `docs/PRODUCT.md`; `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Optional probe:** `curl -sS "https://floom.dev/__notfound-probe__" | head -c 8000` (initial HTML only; SPA shell)

---

## 1. What this screen is for

Users land here when the client-side router has **no matching route** (typo, removed page, bookmark to a path Floom never shipped, or a link that should have been a redirect but was not). The job is to **recover trust and momentum**: say clearly that nothing lives at this URL, then offer **obvious next steps** toward discovery (`/apps`) and home (`/`), plus the same **footer trust rails** as other public pages.

---

## 2. Implementation summary (code-first)

- **Chrome:** `TopBar` (global nav, session-aware) + centered hero block + `PublicFooter` (Docs, GitHub, Legal/Privacy/Terms/Cookies, tagline).
- **Hero:** Decorative `Logo` glow (`aria-hidden`), `h1` “404 · not found”, body copy, two pill `Link`s: “Back to home” (`/`), “Browse apps” (`/apps`).
- **Comments in file** document intentional layout (glow geometry vs. pills) and the decision to add `PublicFooter` for parity with the landing (trust links).

---

## 3. Live / non-JS reality (curl probe)

The first response is the **generic SPA `index.html`**: marketing title/description, structured data for Floom as a whole, and the hidden `data-spa-fallback` / `<noscript>` block still describes the **home** value prop—not a 404. Until the JS bundle runs, **there is no “page not found” message in the document**. That is normal for a CSR-only 404 but it matters for:

- **Bots and link checkers** that do not execute JS (they see a “200 OK” marketing page, not a semantic 404).
- **Users on very slow networks** (tab title and visible content stay “marketing home” until hydration).

This is an **architectural** tradeoff, not a bug in `NotFoundPage.tsx` alone; still worth flagging under “error states / edge cases” for the product surface.

---

## 4. Checklist walkthrough (condensed)

| Area | Assessment |
|------|------------|
| **First impressions** | Within a few seconds after load, the large “404” and pills communicate state and recovery. Primary actions are clear. |
| **Hierarchy** | Headline > subhead > CTAs reads correctly; glow is subordinate (`opacity` + `z-index`). |
| **Wayfinding** | `TopBar` answers “where am I in the product?” globally; the page itself does not show the **requested path** (users fixing typos may want that). |
| **Copy / ICP** | Subhead uses **“This path isn’t wired to anything”** — accurate for engineers, slightly **internal** for the ICP in `docs/PRODUCT.md` (“path”, “wired”). Plain language would be closer to “We don’t have a page at this address.” |
| **Consistency** | Footer + TopBar align with other public marketing surfaces; pills match the pill pattern used elsewhere. |
| **Mobile** | Large top padding (`300px` in the inner wrapper) plus `TopBar` may push primary CTAs **low on short viewports**; worth visual verification (not captured here). |
| **Accessibility** | Logical `h1`; decorative mark is `aria-hidden`. **Gap:** app-wide skip link in `main.tsx` targets `#main`, but this page’s `<main>` has **no `id="main"`**, so keyboard users may hit a **broken skip target** on this route (other pages use `id="main"` on `PageShell` / hero / permalink). |
| **Launch doc cross-check** | `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` (S3) suggested the 404 restate **search / apps / home** CTAs. **Home + browse apps** are present; there is **no search** affordance on this page (directory search lives on `/apps`, not linked as “search”). |

---

## 5. Findings (severity)

| ID | Sev | Category | What | Why it matters | Notes / direction |
|----|-----|----------|------|----------------|-------------------|
| N1 | **S2** | Accessibility | Skip link target `#main` missing on `<main>` for this page. | WCAG 2.4.1 “Bypass Blocks” / consistent keyboard flow breaks on an already disorienting state. | Align with `PageShell` / `CreatorHeroPage` pattern: `id="main"` on `<main>`. *(Doc only; no code change in this task.)* |
| N2 | **S3** | Copy / ICP | “Path isn’t **wired**” reads dev-adjacent. | ICP is not assumed to think in “routes” or “wiring.” | Softer product copy; optional one-line “Check the URL for typos.” |
| N3 | **S3** | Wayfinding | No echo of the **unknown URL** (read-only). | Helps self-service recovery when the user pasted or mistyped a slug. | `useLocation().pathname` in copy (careful with length/encoding). |
| N4 | **S3** | Parity with launch audit | No explicit “search” CTA; only `/apps`. | LAUNCH S3 called out search + apps + home. | Deep link to `/apps` with anchor/query if search exists; or adjust launch doc if `/apps` alone is the intended answer. |
| N5 | **S4** | SEO / sharing | Document title and meta stay **generic marketing** until client runs; curl shows no 404 semantics. | Low for ICP primary journey; relevant for public link hygiene and tooling. | Server `404` + minimal HTML or post-hydration `document.title` “Page not found · Floom” — product/eng decision outside this file. |

---

## 6. Scoring (checklist weights)

Flaws above counted before scoring.

| Dimension | Weight | Score (1–10) | Comment |
|-----------|--------|----------------|---------|
| Clarity | 25% | **8** | State is obvious once rendered; copy slightly jargon-y. |
| Efficiency | 20% | **8** | Two strong exits + global nav + footer links. |
| Consistency | 15% | **9** | Matches public chrome and footer trust pattern. |
| Error handling | 15% | **7** | Good emotional tone; weak on “what URL failed” and non-JS semantics. |
| Mobile | 15% | **7** | Assumed OK; vertical rhythm untested in this audit. |
| Delight | 10% | **8** | Subtle brand glow without blocking CTAs is restrained and on-brand. |

**Approximate overall:** **7.8 / 10** (rounded).

---

## 7. Files referenced

- `apps/web/src/pages/NotFoundPage.tsx`  
- `apps/web/src/main.tsx` (`path="*"`, skip link)  
- `apps/web/src/components/TopBar.tsx`  
- `apps/web/src/components/public/PublicFooter.tsx`  
- `docs/PRODUCT.md`  
- `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`  

---

## 8. Product pillar note (per `AGENTS.md`)

This route is **not** listed as load-bearing infrastructure in `docs/PRODUCT.md`; it supports **trust, recovery, and wayfinding** when the three surfaces story or marketing links do not map to a live path. Nothing here proposes deleting the catch-all.
