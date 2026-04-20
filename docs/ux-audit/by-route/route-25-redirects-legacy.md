# Per-route UX audit — route 25: redirects, legacy surfaces, global chrome

**Date:** 2026-04-20  
**Scope:** Cross-cutting behavior declared in `apps/web/src/main.tsx`: `<Navigate>`, `ExternalRedirect`, `/_creator-legacy`, `/_creator-legacy/:slug`, `/_build-legacy`, `/p/:slug/dashboard` (inline `PSlugDashboardRedirect`), plus global `CookieBanner` mounted beside `<Routes>`. Not a full audit of destination pages.  
**ICP / checklist:** `docs/PRODUCT.md`; `~/.claude/skills/ui-audit/references/ux-review-checklist.md`

---

## 1. What this cluster is for

These paths exist to **preserve bookmarks and external deep links** after URL and information-architecture changes (Studio split, vanity aliases, wireframe URLs), to **route old marketing labels** (`/deploy`, `/browse`, `/store`) to the closest live surface, and to **offload changelog** to GitHub Releases. Separately, **`/_creator-legacy*` and `/_build-legacy`** keep older creator/build UIs reachable for tooling or regression without advertising them in primary nav. **`CookieBanner`** is first-party consent chrome that appears until the user stores a choice.

---

## 2. Implementation summary (code-first)

### 2.1 `PSlugDashboardRedirect` (defined in `main.tsx` ~L98–104)

- Uses `useParams` + `<Navigate to={/creator/:slug} replace />`.
- **Chain:** `/p/:slug/dashboard` → `/creator/:slug` (this redirect) → **`/creator/:slug` route mounts `StudioSlugRedirect`** → `/studio/:slug`. So wireframe URLs get **two client-side `replace` navigations** before the user sees the Studio app shell.

### 2.2 `MeAppRedirect` / `MeAppSecretsRedirect` / `MeAppRunRedirect`

- `/me/a/:slug*` → `/me/apps/:slug*`; run variant lands on `/me/apps/:slug/run` (`MeAppRunPage`), which is **intentionally not** folded into Studio.

### 2.3 `StudioSlugRedirect`

- `/me/apps/:slug` and `/me/apps/:slug/secrets` → `/studio/:slug` and `/studio/:slug/secrets`.
- `/creator/:slug` → `/studio/:slug`.
- Comment claims query strings “stay alive”; the `to` strings are **path-only** (no `useLocation().search` merge). Interpret as **legacy URLs still resolve**, not as a guarantee that arbitrary `?query` survives unless product explicitly appends it.

### 2.4 `ExternalRedirect`

- `window.location.replace(to)` when `window` is defined; renders `null`. Used for **`/docs/changelog` → GitHub Releases**.

### 2.5 `<Navigate replace />` aliases (non-exhaustive themes)

- **Studio funnel:** `/build`, `/creator`, `/deploy` → `/studio/build` or `/studio`.
- **Discovery:** `/browse`, `/store` → `/apps`.
- **Docs vanity:** `/docs` and several `/docs/*` → `/protocol` or section hashes; **`/docs/*` catch-all** → `/protocol`.
- **Product anchors:** `/self-host` → `/#self-host`.
- **Onboarding stub:** `/onboarding` → `/me?welcome=1`.
- **Pricing:** `/pricing` → `/`.
- **Legal aliases:** `/legal/imprint` → `/legal`; `/legal/privacy` → `/privacy`; etc.; `/impressum` → `/legal`.

### 2.6 Legacy routes (not redirects)

- `/_creator-legacy`, `/_creator-legacy/:slug` → `CreatorPage`, `CreatorAppPage`.
- `/_build-legacy` → `BuildPage`.

### 2.7 `CookieBanner` (`apps/web/src/components/CookieBanner.tsx`)

- Shown until `readChoice()` finds `essential` or `all` in **localStorage** or **`floom.cookie-consent` cookie**.
- **Mobile (&lt;640px):** collapsed bottom-left “Cookies” pill; tap expands full dialog with **Essential only** / **Accept all** and collapse control.
- **Desktop:** fixed bottom-centre dialog (`role="dialog"`, `aria-modal="true"`, `aria-labelledby` → visible copy).
- Copy: essential cookies for sign-in and preferences; link to `/cookies`.

---

## 3. Bookmark safety

| Pattern | Assessment |
|--------|--------------|
| In-app `<Navigate replace>` | **Strong:** History entry is replaced; bookmarking after load reflects the **canonical** destination (`/studio/...`, `/apps`, etc.). |
| `/p/:slug/dashboard` | **Good end state** (`/studio/:slug` after chain); **two hops** may mean brief loading flashes and double history replacement (usually invisible to users). **Edge:** `slug` missing → navigates to `/creator/` then `/studio/` with empty segment — odd and unlikely from real links. |
| `/docs/changelog` | **`location.replace` to another origin** — user’s “back” from GitHub does not return to Floom’s changelog route in the way a same-site redirect would; bookmark is effectively **GitHub**, not Floom. Intentional but **cross-domain**. |
| `/_creator-legacy*`, `/_build-legacy` | **Stable literal URLs** — no auto-forward to Studio; bookmarks **keep** legacy chrome. Fine for internal tooling; confusing if a user saves one thinking it is the “real” product. |

---

## 4. Surprise redirects and disorientation

| Path | Risk | Notes |
|------|------|--------|
| `/pricing` → `/` | **High surprise** | Label says “pricing”; landing may not answer pricing questions. ICP may feel misled. |
| `/onboarding` → `/me?welcome=1` | **Medium** | If session is missing, **auth flows** may send the user elsewhere before they see the welcome banner — wireframe expectation vs auth reality. |
| `/docs/*` catch-all → `/protocol` | **Low–medium** | Safe fallback vs 404, but a **wrong** deep link silently lands on generic protocol page **without** echoing the requested subpath. |
| Hash targets (`/protocol#…`, `/#self-host`) | **Low** | Assumes headings/anchors exist; if layout changes, hash can feel “broken.” |
| `/p/:slug/dashboard` | **Low** | Comment documents wireframe compatibility; end state is Studio management, not public permalink — could surprise someone who thought “dashboard” meant **consumer** view of `/p/:slug`. |

---

## 5. SEO, crawlers, and user confusion

- **Client-side redirects only** (except changelog hard exit): first paint is still the **SPA shell**; crawlers that execute JS follow the redirect graph; non-JS clients see marketing shell until bundle runs (same class of issue as other CSR routes; see `route-24-not-found.md`).
- **`/docs/changelog`:** Leaving the site for GitHub is **correct for changelog truth** but splits “docs” mental model between on-site `/protocol` and off-site releases.
- **Vanity paths** (`/deploy`, `/store`, `/browse`): Good for **link rot**; sitemaps should prefer **canonical** URLs (`/studio/build`, `/apps`) to avoid duplicate signals if search engines index both.
- **Underscore legacy URLs:** Unlikely to be linked from marketing; if indexed, they present **alternate** product chrome vs Studio — brand and IA **divergence**, not user-facing by default.

---

## 6. Cookie UX vs ICP

**ICP** (from `docs/PRODUCT.md`): non-developer AI engineer shipping a localhost prototype to production hosting.

| Aspect | Assessment |
|--------|------------|
| **Language** | “Essential cookies for sign-in and preferences” is **plain** and maps to real needs (session). Good for ICP. |
| **Choices** | Binary **Essential only** vs **Accept all** is simple; no granular toggles — acceptable for a young product, may be **light** if marketing analytics grow. |
| **Mobile** | Collapsed pill avoids blocking hero CTAs (documented in file comments) — **strong** fit for signup-first journeys. |
| **Policy access** | In-app `Link` to `/cookies` — clear. |
| **Trust** | Dialog on desktop is prominent but standard; `aria-modal` blocks interaction with page behind until dismissed — **expected** for consent. |
| **Polish** | Collapsed mobile control uses a **cookie emoji** in UI; repo `AGENTS.md` discourages emojis in code/product unless requested — minor **consistency** nit for a compliance-adjacent surface. |

---

## 7. Findings (severity)

| ID | Sev | Category | What | Why it matters | Notes / direction |
|----|-----|----------|------|----------------|-------------------|
| R1 | **S2** | Expectations / ICP | `/pricing` → home. | Users following old links or typing `/pricing` expect **commercial** information; home does not signal “pricing moved.” | Dedicated stub copy, or redirect to `/protocol`/`/about` section that addresses plans if any; or explicit “Pricing isn’t a separate page yet” on home. |
| R2 | **S3** | Redirect chain | `/p/:slug/dashboard` → `/creator/:slug` → `/studio/:slug`. | Two steps vs one direct `Navigate` to `/studio/:slug`; extra work on every visit from that bookmark. | Optional single-hop redirect for efficiency and clearer intent in history. |
| R3 | **S3** | Query preservation | `StudioSlugRedirect` / `PSlugDashboardRedirect` paths omit `location.search`. | UTM or deep-link query on legacy URLs may **drop** silently. | If analytics or support depend on query, merge `useLocation().search` where safe. |
| R4 | **S3** | Off-site docs | `/docs/changelog` replaces location with GitHub. | “Back” and mental model of “still in Floom docs” break. | Acceptable; optionally open in new tab would **change** semantics (not `replace`). Product choice. |
| R5 | **S3** | Onboarding | `/onboarding` → `/me?welcome=1`. | Unauthenticated users may never see intended welcome without signing in. | Align marketing links with auth gate copy or add logged-out stub. |
| R6 | **S4** | Legacy URLs | `/_creator-legacy*` reachable without redirect to Studio. | Power users or stale indexes could land on **deprecated** chrome. | Robots/noindex or server rule if leakage is a concern; keep if tooling depends on it. |
| R7 | **S4** | Cookie chrome | Emoji on mobile pill. | Tiny distraction on a consent control; clashes with repo style rules. | Remove or replace with neutral icon. |

---

## 8. Scoring (redirect + chrome cluster)

Flaws above counted before scoring. Scope is **infrastructure UX**, not destination page quality.

| Dimension | Weight | Score (1–10) | Comment |
|-----------|--------|----------------|---------|
| Clarity | 25% | **7** | Most redirects serve obvious aliases; `/pricing` and `/docs/*` fallback weaken clarity. |
| Efficiency | 20% | **8** | `replace` avoids back-button stacks; double hop on `/p/.../dashboard` is minor waste. |
| Consistency | 15% | **7** | Studio funnel is coherent; legacy underscore routes diverge from primary IA. |
| Error handling / safety | 15% | **8** | Broadly bookmark-safe; edge cases (empty slug, query drop, auth on `/onboarding`). |
| Mobile | 15% | **9** | CookieBanner mobile pattern is thoughtful for ICP hero journeys. |
| Delight | 10% | **6** | Functional; changelog handoff is utilitarian. |

**Approximate overall:** **7.5 / 10** (rounded).

---

## 9. Files referenced

- `apps/web/src/main.tsx` — route table, `PSlugDashboardRedirect`, `MeApp*Redirect`, `StudioSlugRedirect`, `ExternalRedirect`, legacy routes, `CookieBanner` mount, skip link.
- `apps/web/src/components/CookieBanner.tsx` — consent UI, storage, responsive behavior.
- `docs/ux-audit/by-route/route-24-not-found.md` — CSR / SEO baseline for comparison.
- `docs/ux-audit/by-route/INDEX.md` — index row for route 25.
