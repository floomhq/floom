# Per-route UX audit — `/protocol` (`ProtocolPage`)

**Date:** 2026-04-20  
**Sources:** `apps/web/src/pages/ProtocolPage.tsx`, `apps/web/src/assets/protocol.md`, `apps/web/src/styles/globals.css` (protocol media queries), `docs/PRODUCT.md`, `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`, checklist `~/.claude/skills/ui-audit/references/ux-review-checklist.md`, optional `curl -sS "https://floom.dev/protocol" | head -c 15000` (shell HTML).

---

## Route summary

| Field | Value |
|--------|--------|
| **URL** | `/protocol` |
| **Component** | `ProtocolPage` (`apps/web/src/pages/ProtocolPage.tsx`) |
| **Primary content** | `FlowDiagram` + `ProxiedVsHosted` + `ReactMarkdown` over bundled `protocol.md` (~100 lines of prose + fenced blocks) + GitHub CTA, example manifest links, Docker one-liner |
| **Chrome** | `TopBar`, `Footer`, `FeedbackButton` |
| **ICP (from `docs/PRODUCT.md`)** | Non-developer AI engineer with a localhost prototype who needs production hosting without Docker/OAuth/infra fluency; **default journey is paste repo → hosted**; OpenAPI wrapping is an **advanced** path. |

---

## Length & structure

- **Reading depth:** Medium-long for ICP: multiple YAML blocks, a raw API/MCP path listing, and product roadmap bullets (“Coming soon”) in one scroll. The sticky **Contents** nav (built from `#`–`###` in `protocol.md`) helps scanning on desktop.
- **Duplication:** Proxied vs hosted YAML appears in the **comparison cards** and again in the markdown body. That reinforces the split for readers who skim diagrams first, but doubles cognitive load for linear readers.
- **Order of attention:** Above the markdown `h1`, users see **“How it works”** (flow) and **“Two deployment modes”** before the titled spec narrative. The document’s semantic `h1` (“The Floom Protocol”) is **not** the first heading in the article, which weakens the 5-second “what is this page” test for assistive tech and outline order (checklist §1, §9 heading hierarchy nuance).

---

## Anchors & navigation

- **TOC:** `extractToc()` parses `h1`–`h3` lines from `protocol.md`; rendered headings use matching `id={slugify(text)}` and `scrollMarginTop: 72` for sticky top bar clearance. Hash links in the sidebar should align with in-page anchors unless slug collisions occur (unlikely with current headings).
- **Mobile:** Below 768px, desktop TOC is hidden; **Show contents / Hide contents** toggles an inline nav (`globals.css`). Good wayfinding fallback.
- **Exit ramps:** “View on GitHub”, “Browse apps” (`/apps`), and external example `floom.yaml` links give clear next steps; there is **no** prominent in-page link to **`/build` or `/studio/build`**, which is where the ICP’s primary story lives per `PRODUCT.md`.

---

## Jargon vs ICP

Dense, engineer-assumed vocabulary appears early and often: **OpenAPI**, **MCP**, **SSE**, **JSON-RPC**, **openapi-generator**, **uvicorn**, **YAML keys** (`openapi_spec_url`, `type: proxied|hosted`), **manifest**, **slug**, **Docker / ghcr**. That is appropriate for a **protocol spec** audience but misaligned if this route is meant as **first-stop onboarding** for the ICP (launch audit already flags “dense for ICP”; see `LAUNCH-UX-AUDIT-2026-04-20.md` S3).

**Narrative emphasis vs product truth:** The flow diagram’s **input** box reads “OpenAPI spec + floom.yaml”. `PRODUCT.md` positions **repo URL → hosted** as path 1 and OpenAPI→proxied as path 3. A non-integrator ICP may infer OpenAPI is the **only** front door.

**“Three surfaces” framing:** Product promises **web form** (`/p/:slug`), **MCP**, **HTTP**. The diagram’s outputs include **MCP server**, **HTTP API**, **Web**, and **CLI** — an extra surface not named in the three-surface model, which can confuse checklist §3 (mental model match).

---

## Live HTML note (`curl`)

Initial HTML uses global marketing meta (canonical `https://floom.dev/protocol` is set; title references the protocol). The static body still centers the **generic home** SPA fallback / noscript copy, not protocol prose. Real page content arrives with the client bundle — expected for an SPA, but crawlers and no-JS users do not get the spec (checklist §8 long content / §10 perception for “instant meaning”).

---

## Checklist-driven findings

### First impressions & hierarchy

- **Clear eventually, not instantaneously:** Purpose is clear after reading the title block and diagram; above-the-fold is diagram-first, not a one-line “for creators who…” summary.
- **Primary action unclear:** No single primary CTA for the ICP (“Host my repo” / “Publish an app”). Secondary actions (GitHub, Browse apps) are clear.

### Navigation & wayfinding

- **Where am I:** Document title in browser is set to `The Floom Protocol` in `useEffect`; TopBar provides global nav (consistent with rest of site).
- **Gap:** Missing obvious bridge to **creator onboarding** (`/build`, `/studio/build`) from the top of the article.

### Interaction & copy

- **Copy buttons** on code blocks and comparison YAML: useful; clipboard failures are silently ignored (minor — checklist §4 feedback).
- **External links** open in new tabs with `rel="noreferrer"` — good.

### Content consistency (trust)

- **Self-host Docker mismatch:** In `protocol.md`, Docker uses `ghcr.io/floomhq/floom:latest`, host port **3000**, and optional `OPENAI_API_KEY`. The fixed one-liner at the bottom of `ProtocolPage` uses **`ghcr.io/floomhq/floom-monorepo:latest`**, port **3051**, and no env hint. An ICP or operator comparing the two will see **conflicting** instructions — high severity for a “protocol” page (checklist §5 clarity + §8 edge truth).

### Mobile (`globals.css`)

- Comparison grid stacks to one column under 900px; main grid collapses under 768px; horizontal scroll is mitigated for `pre`/`code` inside `[data-testid="protocol-page"]`. Flow diagram shows a **scroll hint** under 640px. Generally aligned with checklist §7, though small **Copy** controls may fall under 44px touch targets.

### Accessibility basics

- Diagram “scroll” hint is `aria-hidden="true"` (decorative).
- **Copy** buttons lack descriptive `aria-label`s (screen reader hears unlabeled “button”).
- Markdown renders real `h1`→`h3` in the article after custom blocks; not a skipped-level bug inside the markdown tree, but **visual** order vs **DOM** heading order is worth a future pass if strict WCAG outline order is a goal.

### Performance / SEO

- Markdown is bundled at build time (`?raw`) — good for no-runtime fetch.
- Public HTML does not contain protocol text — limits shareability and no-JS readability.

---

## Severity table (this route only)

| ID | Severity | Topic | Notes |
|----|-----------|--------|--------|
| P1 | **S2** | Self-host instructions conflict (`protocol.md` vs page one-liner: image name, port, env) | Undermines trust for anyone acting on the page |
| P2 | **S2** | Story ordering vs ICP | OpenAPI-first diagram + spec copy underweights **paste repo → hosted** as the default promise in `PRODUCT.md` |
| P3 | **S3** | No “start here” / publish CTA | Echoes launch audit: add a short ICP-oriented lead and link to `/studio/build` or `/build` |
| P4 | **S3** | “CLI” vs three-surface product language | Align diagram labels with `PRODUCT.md` or explain CLI as optional |
| P5 | **S3** | Static HTML / noscript | Protocol body not in first paint; consider content parity for crawlers if SEO matters for this URL |
| P6 | **S4** | Silent clipboard failure; tiny copy buttons | Polish accessibility and feedback |

---

## Weighted scorecard (checklist weights)

Assumptions: scored **for the stated ICP** if they landed on `/protocol` as an explainer, not for an integrator who sought OpenAPI details.

| Dimension | Weight | Score (1–10) | Comment |
|-----------|--------|----------------|--------|
| Clarity | 25% | **6** | Clear for technical readers; heavy jargon and repo story not foregrounded |
| Efficiency | 20% | **7** | TOC + copy buttons help scanning; long for a quick answer |
| Consistency | 15% | **5** | Docker/ghcr/port drift inside the same page hurts |
| Error handling | 15% | **8** | Mostly static; few runtime errors; clipboard edge case |
| Mobile | 15% | **7** | Responsive rules present; touch targets on small controls uncertain |
| Delight | 10% | **7** | Diagram + side-by-side modes are strong visual anchors |

**Approximate overall:** **6.5 / 10** (dominated by clarity/consistency weights for the ICP).

---

## Recommended backlog (ordered)

1. **Unify self-host copy** — one canonical image, port, and env story across `protocol.md`, the page one-liner, and any install docs (fixes P1).  
2. **Add a 2–3 sentence ICP lead** above the flow diagram: default = repo/hosted; OpenAPI/proxied = optional; link **Publish** / **Studio** (fixes P2, P3).  
3. **Reconcile outputs row** with the three surfaces + optional CLI note (fixes P4).  
4. **Optional:** server-render or expand noscript/fallback for `/protocol` if organic discovery of the spec matters (P5).  
5. **Optional:** `aria-label` on copy controls and non-fatal toast on clipboard deny (P6).

---

## Files touched by this audit (read-only)

- `apps/web/src/pages/ProtocolPage.tsx`
- `apps/web/src/assets/protocol.md`
- `apps/web/src/styles/globals.css` (protocol-related blocks)

No application code was modified in producing this document.
