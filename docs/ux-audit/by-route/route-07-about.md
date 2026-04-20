# Per-route UX audit — `/about` (`AboutPage`)

**Date:** 2026-04-20  
**Route:** `/about`  
**Component:** `apps/web/src/pages/AboutPage.tsx`  
**Shell:** `PageShell` (no `requireAuth`; signed-out users can read)  
**ICP (from `docs/PRODUCT.md`):** Non-developer AI engineer with a localhost prototype who needs **paste repo → hosted** and the **three surfaces** (web form `/p/:slug`, MCP `/mcp/...`, HTTP `/api/:slug/run`) without infra vocabulary.  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Live snapshot:** `curl -sS "https://floom.dev/about"` (first ~12KB HTML) — used for head/meta verification; no Playwright captures in this session.

---

## Summary

| Level | Count | Notes |
|------:|------:|------|
| **S1** Critical | 0 | No blocker for reading or primary CTA |
| **S2** Major | 2 | Share/preview metadata + narrative tension with global JSON-LD |
| **S3** Minor | 5 | Jargon, ICP vocabulary, hero CTA depth, three-surfaces discoverability |
| **S4** Cosmetic | 2 | Repeated inline `<style>` in `Triad`, density of borders |

---

## S2 — Major

### M1 — Open Graph / Twitter cards do not match `/about` story (live HTML)

- **Severity:** S2  
- **Category:** Content / discoverability / sharing  
- **What:** On `https://floom.dev/about`, the document `<title>` and `<link rel="canonical" href="https://floom.dev/about">` align with the About narrative, but `og:url` is `/`, and `og:title` / `og:description` / Twitter fields remain the **homepage** “Ship AI apps fast…” bundle. Anyone sharing `/about` gets a preview that does not reflect “Get that thing off localhost fast” or the page’s positioning.  
- **Why it matters:** This route is explicitly **trust and positioning** for creators and business readers; wrong social previews undermine “finished” feel and confuse the story at the exact moment someone shares it.  
- **Fix (product + eng):** Per-route meta (or SSR-injected OG tags) for `/about`: `og:url` absolute `/about`, title/description matching the hero or a one-line About summary, image unchanged or a dedicated asset if desired.  
- **Evidence:** Live HTML from `curl` (title + canonical vs `og:*` / `twitter:*`).  
- **Files:** Not in `AboutPage.tsx` alone — typically app shell, `index.html`, or server HTML injection for Floom web.

### M2 — Global JSON-LD describes a “chat interface”; About promises “not a chat UI”

- **Severity:** S2 (consistency / credibility)  
- **Category:** Content / product truth  
- **What:** The embedded `application/ld+json` on the fetched page still describes Floom with a **chat interface** in the same breath as Claude tool / page / CLI. The About page body runs a full section (“What Floom isn’t”) that leads with **“Not a chat UI.”**  
- **Why it matters:** `docs/PRODUCT.md` stresses a single story; structured data + hero copy that emphasize “chat” work against the About page’s differentiation and can confuse the ICP (“is this ChatGPT-in-a-box or not?”).  
- **Fix:** Align JSON-LD (and any marketing snippets) with **three surfaces** language (web form, MCP, HTTP) and the About negations, or scope JSON-LD to the homepage only if route-specific data is not possible yet.  
- **Evidence:** Live HTML `script[type="application/ld+json"]` vs `AboutPage` “Not a chat UI” / “Why headless” sections.  
- **Files:** HTML shell / SEO pipeline (not `AboutPage.tsx` only).

---

## S3 — Minor

### m1 — “Why headless” is insider vocabulary

- **Severity:** S3  
- **Checklist:** Section 5 (Content & Copy) — jargon  
- **What:** Section eyebrow **“Why headless”** assumes familiarity with “headless” as a product term. The body copy underneath is clear; the label is the friction.  
- **Fix:** Eyebrow in plain language (e.g. “Why not a chat app” or “Why inputs and outputs, not a chat box”) while keeping the H2.  
- **File:** `AboutPage.tsx`

### m2 — “Vibecoders” is branded; not all ICP users self-identify

- **Severity:** S3  
- **What:** The first audience card tag is **Vibecoders**. It is memorable but optional; some readers may not map “vibecoder” to “I build with Cursor/Lovable/ChatGPT.”  
- **Fix:** Subtitle already carries the concrete tools; consider a more literal tag (“Builders” / “Creators”) or one-line gloss in the card.  
- **File:** `AboutPage.tsx`

### m3 — Primary commercial action sits below the fold

- **Severity:** S3  
- **Checklist:** Section 1 — primary action obvious  
- **What:** The hero states mission clearly; the **Paste your thing → Studio** CTA appears in the **footer band** after long-form sections. Users who only scan the top may miss the fastest path to `/studio/build`.  
- **Fix:** Optional secondary button or text link in the hero (“Paste a repo → Studio”) alongside mission, matching the SPA fallback links pattern.  
- **File:** `AboutPage.tsx`

### m4 — Three surfaces (web / MCP / HTTP) are not named on this page

- **Severity:** S3  
- **ICP:** `docs/PRODUCT.md` says all paths produce the same three surfaces.  
- **What:** The page explains headless inputs/outputs and links to `/protocol`, but it does not **enumerate** form + MCP + HTTP in one scannable line. Readers learn “not chat” more than “here are the three ways to use an app.”  
- **Fix:** One short paragraph or bullet list under “Why headless” or near the CTA, aligned with protocol wording.  
- **File:** `AboutPage.tsx`

### m5 — CTA band lists “OpenAPI spec or a GitHub repo”

- **Severity:** S3  
- **What:** Ordering puts OpenAPI first; `PRODUCT.md` prioritizes **repo → hosted** first, OpenAPI third. This is subtle but can reinforce the wrong default mental model for the ICP.  
- **Fix:** Swap or phrase as “GitHub repo or OpenAPI spec” if parity with product priority matters.  
- **File:** `AboutPage.tsx`

---

## S4 — Cosmetic

### c1 — `Triad` renders a `<style>` block per row

- **Severity:** S4  
- **What:** Three `Triad` instances each inject the same media-query CSS for `.about-triad`. Redundant DOM and slightly noisy DevTools.  
- **Fix:** Single `<style>` at section level or shared class in a stylesheet.  
- **File:** `AboutPage.tsx`

### c2 — Visual rhythm: dashed borders + cards + section borders

- **Severity:** S4  
- **What:** The page is coherent with `var(--line)` / `var(--card)`, but stacked patterns (section top border, triad dashed top, not-row cards) are dense on long scroll.  
- **Fix:** Optional spacing tweak or one fewer visual separator class between sections.  
- **File:** `AboutPage.tsx`

---

## Checklist walkthrough (`ux-review-checklist.md`)

### 1. First impressions (5-second test)

- **Purpose:** Clear — “About Floom,” H1 “Get that thing off localhost fast,” mission line.  
- **Primary action:** Studio CTA is clear **once** the user reaches the bottom band; weaker at hero (see m3).  
- **Attention:** H1 and serif treatment dominate appropriately.  
- **Finished vs WIP:** Reads as a deliberate marketing page, not a stub.

### 2. Information hierarchy

- **Hero → audience → rationale → boundaries → founder → CTA** is a logical story arc.  
- **H2s** match section intent; eyebrow labels (`About Floom`, `Who Floom is for`, …) aid scanning.

### 3. Navigation & wayfinding

- **Where am I:** `PageShell` + browser title after hydration; TopBar/Footer provide global escape hatches (shared with rest of site).  
- **Back / home:** Footer and global chrome; no page-specific breadcrumb (acceptable for a flat marketing page).

### 4. Interaction design

- **CTA:** `Link` to `/studio/build` looks like a primary button (accent background, padding).  
- **External:** GitHub, Discord, LinkedIn open in new tabs where applicable; internal `Link` for `/protocol` and `/`.  
- **No forms** on this page — N/A for validation.

### 5. Content & Copy

- **Strength:** Plain-language negations (“not a chat UI,” “not a low-code builder,” “not an agent orchestrator”) match `PRODUCT.md` tension points.  
- **Friction:** “Headless” eyebrow (m1); “Vibecoders” (m2).

### 6. Visual design

- **Typography:** DM Serif for H1/H2, mono eyebrows, readable body sizes (17–19px).  
- **Spacing:** `maxWidth` 820–960, consistent padding; centered hero.

### 7. Mobile experience

- **Responsive grids:** `.about-who-cards` → 1 column ≤720px; `.about-triad` → 1 column ≤640px.  
- **Touch:** Footer CTA has generous padding; verify ~44px tap height on real devices (not measured here).

### 8. Edge cases & error states

- **No async data** — no loading/error states on this page.  
- **Long content:** Single column; no pagination needed.

### 9. Accessibility basics

- **Headings:** Single H1; H2s for sections — good.  
- **Landmarks:** Relies on `PageShell` `main` + `TopBar`/`Footer` (verify `main` id in shell).  
- **Links:** Founder name and pill links have visible text.  
- **SPA fallback (live):** Hidden `display:none` fallback in `<div id="root">` — text exists for some crawlers but is not visible pre-hydration; `noscript` duplicates readable content for no-JS users. Screen readers may behave differently depending on hydration timing (not exhaustively tested here).

### 10. Performance perception

- **Static content** — no client-side data fetching in `AboutPage`.  
- **Inline styles:** Large but acceptable for a single route; no obvious layout-shift source in component.

---

## Cross-screen consistency (brief)

- **Tone:** Aligns with landing’s “your thing” / production language if landing uses similar voice (verify `/` in a separate audit).  
- **SEO layer:** Global head fragments vs About-specific copy (M1, M2) are the main cross-route **inconsistency** for this path.

---

## Scoring (checklist weights)

Assumptions: flaws above are addressed only as far as **this route’s** code and shell allow; S2 items are mostly **head/SEO**, not React layout.

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|-------|
| Clarity | 25% | 8 | Story is clear; eyebrow “headless” and audience labels slightly narrow |
| Efficiency | 20% | 7 | Strong read; CTA deep in page |
| Consistency | 15% | 6 | Page vs JSON-LD / OG tags (M1, M2) |
| Error handling | 15% | 9 | N/A for static page |
| Mobile | 15% | 8 | Grids collapse; not measured on device |
| Delight | 10% | 7 | Honest founder block + pills feel human |

**Weighted overall (approx.):** **7.5 / 10**

---

## File references

| Path | Role |
|------|------|
| `apps/web/src/pages/AboutPage.tsx` | Page content, layout, CTAs, responsive grids |
| `apps/web/src/components/PageShell.tsx` | Title via `useEffect`, `TopBar`/`Footer`, padding |
| `apps/web/index.html` | Baseline meta (repo may differ from deployed per-route injection) |

---

## Appendix — live HTML observations (curl)

- `<title>About Floom · Get that thing off localhost fast</title>`  
- `<link rel="canonical" href="https://floom.dev/about">`  
- `og:url` / `og:title` / Twitter titles still **homepage-oriented** (see M1).  
- SPA fallback inside `#root` uses About-specific H1/paragraphs and links to `/studio/build` and `/` (matches page intent).  
- JSON-LD still includes **chat interface** (see M2).
