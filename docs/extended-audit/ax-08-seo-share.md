# ax-08 — SEO and social share

**Scope:** `document.title` usage in `apps/web`, baked meta in `apps/web/index.html`, dynamic OG at `apps/server/src/routes/og.ts`, SSR head rewriting in `apps/server/src/index.ts` (static SPA path), `apps/web/public/sitemap.xml` and `robots.txt`. Key routes: `/`, `/apps`, `/p/:slug`, `/protocol`. **No code changes** — audit only.

**ICP lens:** Many users discover Floom via a pasted link in Slack/LinkedIn or a search snippet. They do not run crawlers locally; they need **correct previews without JavaScript** and **stable absolute URLs** on the canonical deployment. Self-hosters need predictable behavior when `PUBLIC_URL` / `PUBLIC_ORIGIN` and optional `FLOOM_AUTH_TOKEN` differ from floom.dev.

**Related:** `docs/PRODUCT.md` (public `/p/:slug` gallery, three surfaces); `docs/extended-audit/INDEX.md` row 08.

---

## Trace summary (where truth lives)

| Concern | Primary source | Crawler-visible without JS? |
|--------|----------------|------------------------------|
| Default `<title>`, meta description, OG/Twitter, JSON-LD | `apps/web/index.html` | Yes (from HTML) |
| Per-route `<title>`, canonical, `/p/:slug` OG/Twitter | `apps/server/src/index.ts` (`rewriteHeadForPath`, `rewriteHeadForSlug`, `rewriteHeadForLanding`) | Yes, **only when** `webDist` exists and the `/*` static middleware runs (unified server + built web) |
| Per-app OG **image** asset | `GET /og/:slug.svg` in `apps/server/src/routes/og.ts` | Yes (image URL in meta; fetch is separate) |
| Client-only title + meta + JSON-LD for `/p/:slug` | `apps/web/src/pages/AppPermalinkPage.tsx` (`useEffect`) | No — bots that execute JS may see this; classic crawlers do not |
| Client `document.title` for `/apps`, `/`, `/protocol` | `AppsDirectoryPage.tsx`, `CreatorHeroPage.tsx`, `ProtocolPage.tsx` | No for meta; title only after JS |
| Sitemap / robots | `apps/web/public/sitemap.xml`, `robots.txt` (copied to dist with Vite `public/`) | Yes when served as static files |

---

## Checklist (expected behaviors)

### Global

- [x] **Unique canonical per URL** — Implemented for SSR HTML via `rewriteCanonical` / `rewriteHeadForLanding` when `PUBLIC_ORIGIN` (or fallback chain) is set (`apps/server/src/index.ts` ~652–661, 755–758, 816–823).
- [x] **`/p/:slug` social preview** — OG/Twitter image/title/description/url rewritten from DB when slug matches (`rewriteHeadForSlug` ~751–801).
- [x] **Dynamic OG card** — `/og/:slug.svg` and `/og/main.svg` with cache headers (`og.ts` ~117–173).
- [x] **Sitemap + robots present in static** — `apps/web/public/sitemap.xml`, `robots.txt`.
- [ ] **Absolute OG/Twitter image URLs everywhere** — Landing SSR rewrites to `${publicOrigin}/og-image.png`; baked `index.html` uses **relative** `/og-main.png` until SSR runs (pure static or misconfigured origin = weak).
- [ ] **Committed raster OG assets** — No `*.png` under `apps/web` in repo; `index.html` references `/og-main.png`; SSR uses `/og-image.png`. Pipeline/docs gap unless assets are injected outside git.
- [ ] **Per-route OG copy for non-`/p` marketing pages** — `/apps`, `/protocol`, etc. still ship **landing** `og:title` / `og:description` / `og:image` from `index.html` unless extended (only `<title>` + canonical rewritten today).

### By path

| Path | SSR `<title>` (`titleForPath` / slug) | SSR OG beyond landing? | Client `document.title` | Notes |
|------|----------------------------------------|-------------------------|-------------------------|--------|
| `/` | `Ship AI apps fast · Floom` + landing head rewrite | Yes — `rewriteHeadForLanding` forces default OG image + `og:url` | `CreatorHeroPage` aligns | JSON-LD `url` rewritten on `/` when origin set (~705–720). |
| `/apps` | `Apps · Floom` | **No** — landing OG tags remain | `Apps · Floom` | Social share of `/apps` likely shows **home** OG title/description/image. |
| `/p/:slug` | `{name} · Floom` or `App · Floom` if missing | **Yes** — image `/og/{slug}.svg`, titles, description, `og:url` | `{name} \| Floom` + meta + extra JSON-LD | SSR uses `·` in `<title>` but `\|` in `og:title` (~770–775) vs client uses `\|` everywhere — minor inconsistency. |
| `/protocol` | `The Floom Protocol · Floom` | **No** — landing OG | `The Floom Protocol` (no suffix) | Title suffix mismatch SSR vs client; OG still “Ship AI apps fast”. |

---

## `apps/web/index.html` (baked head)

- **Strengths:** Full description, `og:type`, `og:site_name`, dimensions + `og:image:alt`, Twitter `summary_large_image`, SoftwareApplication JSON-LD, `lang="en"`, icons, theme-color, SPA/noscript fallback copy for `/`.
- **Risks:** `og:url`, `twitter:*` image, and canonical are **root-relative** (`/`, `/og-main.png`) — fine behind the unified server with `PUBLIC_ORIGIN`, fragile for **static-only** hosting or wrong origin. JSON-LD `"url": "/"` is relative until landing rewrite runs.

---

## `apps/server/src/routes/og.ts`

- **Routes:** `GET /og/main.svg`, `GET /og/:slug.svg` (Hono param `slugPng` matches `*.svg`).
- **Behavior:** DB join for author display; 200 + generic “Floom” card if slug missing (avoids broken-image previews).
- **Format:** SVG deliberately (no raster deps); comment documents that **many** previewers accept SVG; **not all** networks historically accept SVG for `og:image` (treat as residual compatibility risk).

---

## `apps/server/src/index.ts` (SSR static middleware)

- **Trigger:** Block runs when `webDist` resolves (~615+); otherwise “backend-only mode” JSON on `/` — **no HTML meta story** for API-only processes.
- **`/p/:slug`:** Regex `^/p/([a-z0-9][a-z0-9-]*)/?$` (~633) — trailing slash optional; slug rules aligned with OG route slug charset.
- **Landing:** `defaultOgImage = \`${publicOrigin}/og-image.png\`` (~635) — **different filename** from `index.html`’s `/og-main.png`; verify deployment actually serves `og-image.png`.
- **`titleForPath`:** Covers `/`, `/apps`, `/protocol`, legal, `/me`, `/docs`, `/studio`, `/about` (with dedicated fallback H1 swap), etc. (~667–695). Branch `pathname.startsWith('/protocol#')` is **dead** for normal HTTP requests (fragment not sent to server) — harmless noise.
- **`/spec` → `/protocol`:** 308 redirect (~826–839) — good for old links; SEO-relevant.
- **`FLOOM_AUTH_TOKEN`:** `globalAuthMiddleware` applies to `/p/*` (~145). Unauthenticated GETs to `/p/:slug` return **401 JSON**, not HTML (~54–70 `apps/server/src/lib/auth.ts`). **Social crawlers cannot show previews** for permalink pages on token-gated installs unless exempted or passed `?access_token=` (unlikely for link previews).

---

## `apps/web/public/sitemap.xml` and `robots.txt`

- **Location:** Vite `public/` → copied to site root in production.
- **sitemap.xml:** Hard-coded `https://floom.dev/...` URLs only. Omits many `/p/*` apps that exist in the hub; includes a **curated** subset of `/p/...` entries. **Self-host / preview** domains will advertise wrong `loc` unless regenerated per deploy.
- **robots.txt:** `Allow: /` and `Sitemap: https://floom.dev/sitemap.xml` — same domain coupling.

---

## Client `document.title` (JS)

| File | Pattern |
|------|---------|
| `BaseLayout.tsx` | Sets `document.title` from `title` prop when present (~82–84). |
| `CreatorHeroPage.tsx` | `Ship AI apps fast · Floom` (~160). |
| `AppsDirectoryPage.tsx` | `Apps · Floom` (~71). |
| `ProtocolPage.tsx` | `The Floom Protocol`; cleanup restores `Floom: production layer for AI apps` (~457–461). |
| `AppPermalinkPage.tsx` | `{app.name} \| Floom`; cleanup restores `Floom: production layer for AI apps` (~243–286). |

**Copy drift:** Cleanup strings use **“Floom: production layer for AI apps”** while marketing SSR/HTML use **“Ship AI apps fast · Floom”** — users briefly navigating away from `/p` may see an outdated internal tagline in the tab.

---

## Gaps (prioritized)

### P1

1. **`FLOOM_AUTH_TOKEN` + `/p/*`:** Permalink HTML and previews are incompatible with global bearer auth as implemented — crawlers get 401. Any product story that says “paste the link in Slack” breaks on locked-down self-host unless documented or exempted for GET `text/html`.
2. **Default OG raster URL vs repo:** SSR points to `/og-image.png`; `index.html` points to `/og-main.png`; **no** committed PNGs under `apps/web`. Risk of **404** default share image on fresh builds if assets are not produced or mounted.
3. **`PUBLIC_ORIGIN` unset:** `rewriteCanonical` no-ops (~656); `rewriteHeadForLanding` still substitutes `og:url` / `og:image` with possibly empty `publicOrigin` — can emit **invalid or relative** OG URLs for production-like crawlers.

### P2

4. **`/apps`, `/protocol`, `/build`, etc.:** SSR updates `<title>` and canonical but **not** `og:title`, `og:description`, `og:image`, or `meta name="description"` — shares look like the **home** product unless the crawler executes the SPA.
5. **JSON-LD on non-landing routes:** Still the global `SoftwareApplication` for Floom with baked/landing `url` when `rewriteHeadForPath` runs — **not** page-specific; may dilute structured-data accuracy for `/apps` and similar.
6. **`<title>` vs `og:title` on `/p/:slug`:** SSR uses middle dot in `<title>` and pipe in `og:title` (~770–775); client uses pipe for both — minor inconsistency in SERP vs preview.
7. **SVG `og:image`:** Relies on consumer support; some older link expanders prefer PNG/JPEG.
8. **Static sitemap:** Fixed `floom.dev` URLs — wrong for other hosts; partial `/p` coverage — stale or under-inclusive over time.
9. **SPA fallback `display:none`:** Pre-hydration body copy exists but is hidden — acceptable for “don’t duplicate visible H1” but may be treated cautiously by some crawlers vs visible noscript (both exist).
10. **Protocol client title** vs SSR: `The Floom Protocol` vs `The Floom Protocol · Floom` — tiny branding inconsistency in tab text depending on JS.

---

## Suggested verification (manual)

1. `curl -sS https://<host>/ | head` — confirm absolute canonical and `og:image` when cloud SSR path active.
2. `curl -sS https://<host>/apps | grep -E 'og:title|title>|canonical'` — expect landing OG tags with Apps `<title>`.
3. `curl -sS https://<host>/p/<known-slug> | grep -E 'og:|twitter:|title>'` — per-app fields and `/og/<slug>.svg`.
4. `curl -I https://<host>/og-image.png` and `/og-main.png` — confirm which exists in your environment.
5. With `FLOOM_AUTH_TOKEN` set: `curl -i https://<host>/p/<slug>` without `Authorization` — expect 401; confirm this matches desired social-preview behavior.

---

## References (code)

- `apps/web/index.html` — default head (~1–58).
- `apps/server/src/routes/og.ts` — `/og/main.svg`, `/og/:slug.svg` (~1–173).
- `apps/server/src/index.ts` — `webDist`, `rewriteHeadForSlug`, `rewriteHeadForPath`, `rewriteHeadForLanding`, `titleForPath` (~615–905).
- `apps/web/src/pages/AppPermalinkPage.tsx` — client meta (~241–289).
- `apps/web/public/sitemap.xml`, `apps/web/public/robots.txt`.
- `apps/server/src/lib/auth.ts` — `globalAuthMiddleware` on `/p/*` when token set (~145 `index.ts`, ~54–70 `auth.ts`).
