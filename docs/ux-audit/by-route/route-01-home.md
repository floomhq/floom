# Per-route UX audit — `/` (home)

**Scope:** `CreatorHeroPage` and the child sections it composes on this route only. **ICP:** `docs/PRODUCT.md` (non-developer AI engineer; primary journey *paste repo → hosted*; three surfaces: web form, MCP, HTTP). **Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`.

## Summary (this route only)

| Level | Count |
|------|------:|
| **S1** Critical | 0 |
| **S2** Major | 2 |
| **S3** Minor | 4 |
| **S4** Cosmetic | 2 |

---

## Findings

### F1 — S2 — Hero affordance reads “OpenAPI on GitHub,” not “any repo”

- **What:** The hero field placeholder is `github.com/you/api`, `aria-label` mentions “OpenAPI,” GitHub detection loops raw OpenAPI URLs under common paths (`openapi.yaml`, etc.), and `LayersGrid` explicitly frames ingest as “A public GitHub repo with OpenAPI, or a direct OpenAPI link.” There is no above-the-fold line stating the broader **repo → hosted** path from `docs/PRODUCT.md`.
- **Why it matters for ICP:** The ICP’s mental model is “I have a prototype repo—paste it.” If their repo is not OpenAPI-first, they may bounce before discovering Floom can still be relevant, or they mis-set expectations and blame the product.
- **Fix:** Add one plain sentence in the hero (or accent line) that states the **default** repo-ingest story without requiring the user to know OpenAPI; keep OpenAPI as the *how* in secondary copy or progressive disclosure. If repo-without-spec is supported elsewhere, link or tease it from the hero empty state.
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx`, `apps/web/src/components/home/LayersGrid.tsx`

### F2 — S2 — Static shell / no-JS “Publish an app” points at `/build` while the app canonical is `/studio/build`

- **What:** Live `https://floom.dev/` HTML (and `apps/web/index.html`) exposes `Try an app` → `/apps` and `Publish an app` → `/build` in the hidden SPA fallback and `<noscript>`. In the SPA, `/build` is a client `Navigate` to `/studio/build` (`apps/web/src/main.tsx`). Users and agents without a executing client router never see that redirect.
- **Why it matters for ICP:** Anyone landing without JS (rare but real: aggressive blockers, bots, broken bundles) gets a **publish** CTA that may not match the canonical creator URL your team documents; it also diverges from in-app copy that centers `/studio/build`.
- **Fix:** Point fallback and noscript links directly at `/studio/build` (or whatever URL is guaranteed by static hosting without JS), **or** enforce the same redirect at the **edge** for `/build` so HTML and SPA agree.
- **Files:** `apps/web/index.html`, `apps/web/src/main.tsx` (for parity with client redirect behavior)

### F3 — S3 — Self-host mock terminal hardcodes “14 apps ready”

- **What:** The self-host block renders a fake boot line: `Floom is up. 14 apps ready. Claude integration live.` That number is not tied to `hubCount` or any live metric.
- **Why it matters for ICP:** Immediately above/below this fold you work hard on **live** proof (`ProofRow`, hub-backed tiles). A static number that drifts reads as marketing filler and weakens trust for detail-oriented visitors.
- **Fix:** Remove the numeric brag, replace with neutral copy (“Hub connected” / “Ready for runs”), or interpolate the same `hubCount` used elsewhere (with a graceful fallback when null).
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx`

### F4 — S3 — Sub-headline is abstract (“protocol + runtime for agentic work”)

- **What:** The hero sub-line after the accent is conceptual product vocabulary, while the meta description / OG text on the live site is more concrete (paste link → Claude tool, page, URL, etc.).
- **Why it matters for ICP:** Checklist §5 (content): avoid jargon. “Protocol” and “agentic” skew toward builders already inside your narrative; the ICP benefits from **outcome-first** language in the first screen.
- **Fix:** Reuse or shorten the concrete promise from SEO/meta into the visible hero (one clause), and move “protocol + runtime” to a lower section or `/protocol`.
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx` (and optionally align `document.title` / marketing meta in the HTML shell for consistency)

### F5 — S3 — Hub directory fetch fails silently; proof row can sit on placeholders

- **What:** `useEffect` → `api.getHub()` on failure only `.catch(() => { /* Keep the static roster */ })`. `hubCount` stays `null`, so `ProofRow` shows an em dash for “apps live,” while stripes stay on enriched fallbacks—**without** an explicit “couldn’t reach directory” message.
- **Why it matters for ICP:** A transient API blip looks like “no apps / broken counter” instead of “retry,” which undercuts the quantified trust strip you just promoted out of the hero.
- **Fix:** Set a lightweight error or retry affordance (inline text under `ProofRow`, or automatic retry with backoff); distinguish **loading**, **error**, and **empty hub** states in copy.
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx`, `apps/web/src/components/home/ProofRow.tsx`

### F6 — S3 — Primary hero `aria-label` encodes “OpenAPI” vocabulary

- **What:** Input `aria-label` is “Public GitHub repo with OpenAPI, or direct OpenAPI link”—accurate for engineers, heavy for the stated ICP.
- **Why it matters for ICP:** Assistive-tech users still deserve the same plain-language mental model as sighted users; “OpenAPI” may read as a gate.
- **Fix:** Lead with “Paste your public GitHub repo or API spec link,” append OpenAPI in parentheses only if you must disambiguate.
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx`

### F7 — S4 — “See every live app →” uses a raw `<a href="/apps">` instead of router `Link`

- **What:** Featured-apps header uses an anchor to `/apps` while the sibling browse CTA uses `<Link to="/apps">`.
- **Why it matters for ICP:** Minor—full reload vs client navigation; small consistency hit for checklist §3 (wayfinding consistency).
- **Fix:** Swap to `Link` for SPA navigation and identical focus/hover styling patterns.
- **Files:** `apps/web/src/pages/CreatorHeroPage.tsx`

### F8 — S4 — `HeroAppTiles` uses JS hover mutations instead of declarative styles

- **What:** Tiles toggle border/transform in `onMouseEnter` / `onMouseLeave` imperative style updates.
- **Why it matters for ICP:** Low user impact, but checklist §4/§9: harder to keep **keyboard focus-visible** parity with pointer hover unless duplicated; CSS `:hover` / `:focus-visible` is easier to audit.
- **Fix:** Move hover/focus presentation to CSS classes on the `Link` tiles.
- **Files:** `apps/web/src/components/home/HeroAppTiles.tsx`
