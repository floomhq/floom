# ax-09 — i18n readiness (gap analysis)

**Scope:** `apps/web/src` plus static shell `apps/web/index.html` (SPA root, crawler/noscript fallback).  
**Goal:** Describe current state for **v1 English-first** vs **v1+ locale-aware UI** (no framework mandate).  
**Method:** ripgrep for `lang`, `toLocale*`, `Intl`, representative page reads, CSS directional patterns.

**Related:** `docs/PRODUCT.md` (ICP, three surfaces); legal/compliance copy already bilingual on select routes (see below).

---

## Executive summary

The web client is **effectively monolingual (English)** at the document and product-UI level. **`html lang` is fixed to `en`** in the Vite shell. There is **no RTL story** (`dir` unset; many physical `left`/`right` and `text-align: left` choices). **Dates and numbers** are split between **hard-coded `en-US`** formatting, **browser-default** `toLocale*` (empty locale argument), and **hand-rolled English relative time** strings. **Privacy** and **Cookies** implement a **manual DE/EN toggle** inside the page; that is the main precedent for “real” i18n today, not a global string layer.

**Verdict for v1:** Acceptable if the ship target remains English-speaking users, with the existing legal-language pattern for EU-facing pages. **Verdict for v1+ (EU growth, RTL markets, or locale-matched numeric UX):** Plan a **central locale + message catalog** and a **directional CSS pass**; treat output renderers and downloadable HTML as a separate surface.

---

## 1. Document language (`<html lang>`)

| Location | Finding |
|----------|---------|
| `apps/web/index.html` | `<html lang="en">` (line 2). All meta title/description/OG/schema copy is English. |
| SPA | No evidence of runtime updates to `document.documentElement.lang` from React. Titles are set via `document.title` in several pages and `BaseLayout` when `title` is passed. |
| `apps/web/src/lib/output-downloads.ts` | Generated download/print HTML wraps with `<html lang="en">` (line 118). |

**Gap:** User or account locale cannot align with `lang` for assistive tech, hyphenation, or embedded browser behaviors. Crawlers see English-only shell copy.

---

## 2. Hardcoded English — major surfaces (sample)

The codebase uses inline English strings extensively in TSX. Below is a **non-exhaustive** sample of high-traffic or high-trust surfaces; the pattern repeats across `pages/*` and `components/*`.

| Area | Examples / notes |
|------|------------------|
| **Marketing / landing** | `CreatorHeroPage.tsx` sets `document.title` to English; hero and CTAs are inline English. `index.html` noscript + `data-spa-fallback` duplicate English marketing lines. |
| **Auth** | `LoginPage.tsx`: tabs, labels, buttons, banners — English. `lib/authErrors.ts`: intentional English map from Better Auth codes; comments note server `message` is raw English (lines 4–7, 31+). |
| **Build / publish** | `BuildPage.tsx`: ramp labels, errors, steps — English (file is large; pattern is consistent). |
| **Me / Studio** | `MePage.tsx`, `StudioHomePage.tsx`, sidebars, settings — English labels and empty states. |
| **Run / permalink** | `AppPermalinkPage.tsx`, `RunSurface`, runner components — English chrome and controls. |
| **Errors** | `NotFoundPage.tsx`: headline “404 · not found”, body copy, pill labels “Back to home”, “Browse apps” — all English. |
| **Studio triggers** | `StudioTriggersTab.tsx`: “Last fired”, “Next”, “never”, “Disable”, “Enable”, “Delete” — English. |

**Partial exception (legal):**

- `PrivacyPage.tsx` / `CookiesPage.tsx`: `LegalLangToggle` + conditional DE/EN body (`PrivacyPage.tsx` uses `lang === 'de' ? … : …`).
- `TermsPage.tsx`, `ImprintPage.tsx`: headers use `lang="en"` on `LegalPageHeader` (grep); not the same toggle pattern as Privacy — confirm product intent if DE parity is required for all legal routes.

**Gap:** No shared message IDs, no fallback chain, no extraction tooling. Any new language is a **page-by-page rewrite** unless a catalog is introduced.

---

## 3. Date, time, and number formatting

### 3.1 Hard-coded `en-US` (numbers)

These force US grouping/decimal rules regardless of user locale:

- `apps/web/src/components/output/ScalarBig.tsx` — `toLocaleString('en-US')` (lines 15, 18).
- `apps/web/src/components/output/RowTable.tsx` — `toLocaleString('en-US')` (line 39).
- `apps/web/src/components/output/KeyValueTable.tsx` — `toLocaleString('en-US')` (line 30).
- `apps/web/src/components/output/rendererCascade.tsx` — `toLocaleString('en-US')` (line 295).
- `apps/web/src/components/home/ProofRow.tsx` — `toLocaleString('en-US')` (line 89).

**Implication:** App output tables and big-number displays will **not** match European number formatting without code changes.

### 3.2 Browser default locale (empty `[]` or no locale)

Uses the **visitor’s** locale, which is good for casual international users but **inconsistent** with forced `en-US` elsewhere on the same screen:

- `apps/web/src/lib/thread.ts` — `threadTimeLabel`: `toLocaleTimeString` / `toLocaleDateString` with `[]` and English bucket labels **“Yesterday”** (lines 66–72, 68).
- `apps/web/src/components/runner/OutputPanel.tsx` — `toLocaleDateString()` / `toLocaleTimeString([], …)` (lines 252–253).
- `apps/web/src/components/AppReviews.tsx` — `toLocaleDateString()` (line 151).
- `apps/web/src/pages/MeAppSecretsPage.tsx`, `components/runner/RunSurface.tsx` — `toLocaleDateString()` without locale.
- `apps/web/src/pages/StudioHomePage.tsx` — `aggregate.*.toLocaleString()` without locale (lines 232–233, 580); labels like `Runs · total` remain English.

### 3.3 Relative / compact time (English strings)

- `apps/web/src/lib/time.ts` — `formatTime`: English tokens **“just now”**, **“Xs ago”**, **“Xm ago”**, etc.; falls through to `toLocaleDateString()` **without** locale (lines 19–27).

**Implication:** Even if numeric `toLocale*` is fixed, **relative time** stays English until wrapped in a message layer or `Intl.RelativeTimeFormat`.

### 3.4 Developer-oriented raw timestamps

- `apps/web/src/pages/StudioTriggersTab.tsx` — displays `new Date(…).toISOString()` for last/next fire times (lines 285–287). ISO 8601 is locale-neutral but **not user-friendly**; it also reads as “debug UI” in a localized product.

### 3.5 Pluralization

- `apps/web/src/pages/StudioHomePage.tsx` — manual English plural: `run` vs `runs` (line 580).

**Gap:** No single `formatNumber` / `formatDate` / `formatRelative` module keyed off a resolved locale (user, workspace, or `Accept-Language`).

---

## 4. RTL (right-to-left) risks

**Current state:** No `dir="rtl"` on `html`/`body` or route wrappers. No logical-property sweep.

**High-impact patterns observed:**

| Pattern | Where / why it matters |
|---------|------------------------|
| **`text-align: left`** on links and blocks | e.g. `globals.css` (`.topbar-mobile-link`, line 233), multiple pages (`BuildPage.tsx`, `MePage.tsx`, `AppPermalinkPage.tsx`, `CreatorHeroPage.tsx`, …). In RTL, start alignment should follow `start`, not `left`. |
| **Mobile drawer anchored with physical `right: 0`** | `.topbar-mobile-menu` in `globals.css` (lines 178–192). RTL expectation is often mirroring (drawer from inline-end). |
| **`border-left` on drawer / rail** | Same file (line 185); blockquotes in `output-downloads.ts` (`border-left`, `padding-left`). |
| **Chevron via `content: '›'` + `margin-right`** | `globals.css` (line 491) — glyph direction and spacing assume LTR. |
| **Skip link positioning** | `.skip-to-content` uses `left: 0` (lines 34–37). Focus ring geometry may need `inset-inline-start` for RTL parity. |

**Lower risk:** `flexDirection: 'column'` is widespread; column layout is mostly direction-agnostic (grep hits are overwhelmingly layout, not text direction).

**Gap:** Introducing RTL is not “flip `dir`” only; it requires **logical properties**, **mirrored icons**, and **audit of absolutely positioned** marketing and runner UI.

---

## 5. Effort estimate bands (engineering weeks, rough)

Bands assume **one web engineer** familiar with the repo; exclude professional translation cost.

| Band | Scope | Order of magnitude |
|------|--------|--------------------|
| **S — hygiene** | Single module for `formatNumber` / `formatDate` / `formatRelative` taking `locale`; replace `en-US` literals in output components; replace ISO display in `StudioTriggersTab` with formatted local time; optional `document.documentElement.lang = navigator.language` (with sanity clamp). | **~0.5–1.5 weeks** |
| **M — product i18n v1** | Message catalog (e.g. JSON + thin hook) for **TopBar**, **Login**, **Build ramp**, **RunSurface** primary actions, **404**; wire `lang` + `dir` from user preference or URL prefix; keep marketing English until translated. | **~2–4 weeks** + ongoing string tax |
| **L — full surface** | All `pages/*` + `components/*`, plural/gender rules, locale-aware routing, SEO/OG per locale, legal parity review, **RTL CSS pass** (wireframe + globals + inline styles), visual QA matrix. | **~6–12+ weeks** |

Translation and legal review are **parallel** workstreams not included above.

---

## 6. Recommendations (prioritized for v1+)

1. **Decide the locale model early:** Browser default vs authenticated user preference vs URL (`/de/...`) affects routing, SEO, and caching. Mixing models without a resolver produces inconsistent `toLocale*` behavior (already visible between `en-US` and `[]`).

2. **Centralize formatting:** One small `locale.ts` (resolve locale) + `format.ts` (wrap `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`) eliminates drift between output renderers and dashboards.

3. **Unify legal language strategy:** Extend the Privacy/Cookies toggle pattern — or site-wide language picker — if Terms/Imprint must serve DE natively.

4. **Defer RTL until a target market requires it**, but for new CSS prefer **`text-align: start`**, **`margin-inline-start`**, **`border-inline-start`**, and **`inset-inline-end`** in hot paths (nav, drawers, tables) to reduce rework.

5. **Keep downloadable HTML in mind:** `output-downloads.ts` generates standalone documents; whatever locale solution ships should either pass `lang` into `wrapHtmlDocument` or keep exports explicitly English.

6. **Do not block v1 on a framework:** A minimal JSON catalog + typed keys is enough for a first non-English locale if scope is capped (e.g. DE for marketing + auth only).

---

## 7. Scan artifacts (commands used)

```bash
rg '<html|lang=' apps/web
rg 'toLocaleString|toLocaleDateString|Intl\\.' apps/web/src
rg 'dir=|text-align:\\s*left|textAlign:\\s*[\"'']left' apps/web/src
```

**Files worth bookmarking for future i18n work:** `apps/web/index.html`, `apps/web/src/lib/time.ts`, `apps/web/src/lib/thread.ts`, `apps/web/src/lib/authErrors.ts`, `apps/web/src/components/BaseLayout.tsx`, `apps/web/src/styles/globals.css`, `apps/web/src/components/LegalPageChrome.tsx` (and consumers under `pages/`).

---

*Audit completed 2026-04-20. Deliverable only — no application code changes.*
