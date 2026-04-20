# pd-13 — Legal, cookie consent, and trust surfaces

**Track:** pd-13 · **Type:** deep product audit (GDPR *style* expectations, not legal advice) · **Date:** 2026-04-20 · **Scope:** `docs/ROADMAP.md` P0 legal line, `CookieBanner.tsx`, legal routes under `apps/web/src/pages/` (Imprint/Legal, Privacy, Terms, Cookies), footer and landing “trust” adjacent UI.

**Non-advice disclaimer:** This document maps product behavior to common EU privacy *expectations* for product and engineering prioritization. It is not legal advice, not jurisdiction-specific counsel, and not a substitute for counsel.

---

## Executive snapshot

P0 lists “Legal: imprint, privacy policy, terms, cookie consent.” In the codebase, **company/legal notice, privacy, terms, cookie policy pages, a cookie banner, and unified footer links are implemented** and wired in `apps/web/src/main.tsx`. **Gaps remain between disclosures and actual cookies**, between **cookie-policy copy and banner behavior** (withdrawal / reopen), and between **“trust bar” naming in roadmap language vs UI** (landing proof row is product proof, not legal links; legal trust is mostly `PublicFooter`).

---

## Roadmap alignment (`docs/ROADMAP.md`)

| Roadmap item | Status in product (evidence) |
|--------------|------------------------------|
| Imprint | Shipped as **`/legal`** (canonical) with **`/imprint`**, **`/impressum`**, and **`/legal/imprint`** aliases; page title “Legal · Floom”. |
| Privacy policy | Shipped **`/privacy`** (+ `/legal/privacy` redirect). Bilingual DE/EN with language toggle. |
| Terms | Shipped **`/terms`** (+ `/legal/terms` redirect). English only. |
| Cookie consent | Shipped: **`CookieBanner`** globally in `main.tsx`; **`/cookies`** policy (+ `/legal/cookies` redirect). Bilingual default **DE-first** on cookie policy page vs **EN-first** on privacy (inconsistency of default language only). |

Roadmap still treats the bundle as **P0 launch blockers**; the remaining work is less “missing pages” than **accuracy, UX of consent, and counsel review** (the UI already labels policies “preliminary draft”).

---

## Truth table — claims vs implementation vs GDPR-style expectations

Legend: **Match** = broadly aligned for a lean pre-1.0 SaaS *if* downstream fixes are tracked; **Gap** = product or disclosure issue to resolve; **N/A** = not primarily a GDPR topic.

| # | Topic | What the product claims | What the implementation does | GDPR-style / ePrivacy-style expectation (high level) | Assessment |
|---|--------|-------------------------|-------------------------------|------------------------------------------------------|------------|
| 1 | Controller & contact | Privacy (EN/DE) and Legal page list Floom, Inc., US address, `team@floom.dev`. | Same in `PrivacyPage.tsx`, `ImprintPage.tsx`. | Controller identity and contact channel for data subjects. | **Match** |
| 2 | Legal notice language | Legal page is EN-only; comments note US entity, EU audience. | `ImprintPage.tsx` single language. | EU users often expect readable legal notice; not identical to “Impressum” law. | **Gap** (product/i18n, not strictly GDPR-articulated) |
| 3 | Terms language | Terms EN-only. | `TermsPage.tsx`. | B2C terms in EU: local consumer law may require understandable language; Terms acknowledge mandatory consumer rules of residence. | **Gap** to validate with counsel (process + locale) |
| 4 | Draft transparency | “Preliminary draft” banner via `LegalPageHeader`. | Shown on Privacy, Cookies, Terms, Legal. | Honest staging reduces “false certainty” risk. | **Match** (trust-positive) |
| 5 | Data categories | Privacy lists account, usage, technical, comms, future payments. | Static copy. | Should reflect real processing. | **Match** at high level; verify against actual processors and features |
| 6 | Legal bases | Art. 6(1)(b)(f)(a) described. | Static copy. | Must match actual operations (e.g. consent only where used). | **Match** structurally; depends on live processing map |
| 7 | SCCs / US transfers | Described in Privacy. | Static copy. | Transfer tooling and DPAs should exist operationally. | **N/A** in code audit — **PM/counsel** verification |
| 8 | Data subject rights | Listed with contact email + account deletion path. | Copy only in repo audit. | Processes and SLAs should exist. | **Gap** to confirm operational handling beyond copy |
| 9 | Cookie inventory in policy | Table: `floom.session`, `floom.cookie-consent`, `floom.theme`. | `CookiesPage.tsx` static `COOKIES` array. | Inventory should be complete and current. | **Gap** — see row 10 |
| 10 | Device / anonymous id cookie | Privacy (EN/DE) mentions “device-ID cookie for anonymous sessions.” | Server sets **`floom_device`** (HttpOnly, long TTL) in `apps/server/src/services/session.ts`; **not listed** on `CookiesPage` table. | Transparency and proportionality for identifiers. | **Gap** — disclosure incomplete vs backend |
| 11 | “Strictly necessary only” narrative | Cookie policy: no analytics/ads; necessary + preference. | Sentry init in `main.tsx` when `VITE_SENTRY_DSN` set; not gated on consent flag. Privacy mentions monitoring “when enabled.” | If Sentry (or similar) is considered non-essential tracking, consent or LI documentation may be expected. | **Gap** to align tech, policy, and banner |
| 12 | Banner choices | “Essential only” vs “Accept all”; stores `essential` \| `all` in localStorage + `floom.cookie-consent`. | No script blocking observed in banner code; choice is persistence + UX. | If no optional cookies/scripts, “Accept all” can confuse; granularity must match reality. | **Gap** (truth-in-labeling + UX) |
| 13 | Consent withdrawal | Cookie policy (EN/DE): withdraw via **reopening banner** or clearing browser cookies. | Banner **does not reappear** after a choice; no in-product “Cookie settings” entry found in this audit slice. | Withdrawal as easy as giving consent (UX expectation). | **Gap** |
| 14 | Preference cookie vs “Essential only” | Policy classifies `floom.theme` as **Preference**. | Unknown from this file set whether theme is suppressed when `essential` only (not audited in theme loader). | If preference storage is non-essential, should respect “essential only” choice. | **Gap** to verify wiring |
| 15 | Footer / discoverability | `PublicFooter`: Legal, Privacy, Terms, Cookies, GitHub, Docs, About. | `Footer.tsx` re-exports `PublicFooter`; `PageShell` includes footer; permalink pages use `Footer`. | Policies should be findable without hunting. | **Match** |
| 16 | Routes | Canonical `/legal`, redirects for legacy URLs. | `main.tsx` routes. | Stable URLs aid transparency and bookmarks. | **Match** |
| 17 | “Trust bar” (roadmap language) | Colloquial track name “trust bar.” | Landing **`ProofRow`**: live app count, optional “runs today,” “MIT / open source” — **marketing proof**, not legal. **`TrustStrip`**: partner-style “works with” logos. **Legal trust** = footer + policies + banner. | Naming clarity for PM/engineering. | **N/A** compliance — **clarify vocabulary** so “trust bar” issues route to correct surface |

---

## UX friction vs compliance (design tension matrix)

| Surface | User friction | Compliance / trust signal | Notes |
|---------|---------------|---------------------------|--------|
| Cookie banner (desktop) | Low–medium: fixed bar, two buttons, link to policy. | Clear link to policy; granular labels need to match real data practices. | Copy says “essential … and preferences” while buttons say “Essential only” / “Accept all” — align language. |
| Cookie banner (mobile pill) | Low viewport blocking (good); extra tap to expand. | Same as desktop; pill uses emoji in UI (see brand/a11y norms in repo rules). | Good hero CTA preservation (documented in component comments). |
| Legal draft banner | Slight anxiety (“not final”). | **Increases** credibility vs pretending polish is legal review. | Keep until counsel sign-off; then replace with version history if needed. |
| Privacy / Cookies DE/EN toggle | Mild cognitive load. | Helps EU readability. | Default language differs Privacy (EN) vs Cookies (DE) — consider unifying default (e.g. browser locale). |
| Terms EN-only for global users | Higher friction for non-English EU users. | May affect fairness and support burden. | Counsel + i18n decision. |
| No cookie settings entry post-consent | Users must dig in browser settings. | Withdrawing consent harder than giving it **if** optional processing exists. | Add footer link “Cookie preferences” or settings entry if optional cookies/analytics ship. |
| Incomplete cookie table | None until user compares to network tab. | **Trust erosion** if users or regulators notice undeclared cookies. | Fix `floom_device` row and any others. |

---

## Risk register

| ID | Risk | Likelihood | Impact | Owner hint |
|----|------|------------|--------|------------|
| R1 | **Cookie inventory omits `floom_device`** while privacy text references a device id cookie. | High (factual) | Medium–high (transparency / trust) | Sync `CookiesPage` + privacy annex with server `session.ts` |
| R2 | **Policy says users can reopen the banner** to withdraw; **UI does not offer reopen** after storage is set. | Medium | Medium (misrepresentation vs behavior) | Product fix or copy change |
| R3 | **`Accept all` label** without optional categories in the table may read as dark pattern adjacent (overselling consent). | Low–medium | Low–medium | Rename to match reality (e.g. “Allow preferences” / “OK”) or add categories |
| R4 | **Sentry (or future analytics)** enabled without consent gating while cookie story is “no analytics cookies.” | Depends on env | Medium if DSN on in EU-facing prod | Align engineering toggle with policy and Art. 6 basis |
| R5 | **Terms + Legal EN-only** for DE-market visitors. | Medium | Medium (support, disputes, perception) | i18n or explicit “English controlling” UX |
| R6 | **Preliminary draft** visible: good for honesty, but **launch marketing** must not overclaim legal review. | Low | Reputational | Coordinate GTM with counsel timeline |
| R7 | **`floom_device` 10-year TTL** vs “session” framing in privacy (30-day session language for session cookies). | Low | Medium if challenged as disproportionate | Counsel + engineering alignment on retention narrative |

---

## PM questions (decision queue)

1. **Cookie model:** Will Floom stay “strictly necessary + preferences only” through paid launch, or is analytics (Sentry, product analytics) in scope? That drives banner architecture (CMP vs lightweight).
2. **Consent granularity:** If the only non-essential artifact is theme storage, should the banner collapse to **informational + “OK”** for EU, with no “Accept all,” or keep binary storage for future expansion?
3. **Withdrawal UX:** Should there be a persistent **Cookie preferences** link in `PublicFooter` that clears or edits `floom.cookie-consent` and reopens the banner?
4. **`floom_device` disclosure:** What exact purpose, retention, and legal basis text should appear in the cookie table (and should TTL be shortened for proportionality)?
5. **Language defaults:** Should legal pages default from `Accept-Language` / geo, or stay fixed defaults per page?
6. **Counsel milestone:** What ship gate moves policies from “preliminary draft” to “reviewed,” and does that gate block **paid** only or **public launch**?
7. **“Trust bar” scope:** Should roadmap rename this track to **“Legal + cookie consent + public trust links”** to avoid conflating `ProofRow` metrics with compliance work?
8. **MCP / API clients:** How are cookies and device ids explained for non-browser surfaces (cookie banner is web-only)?

---

## Appendix — primary file map

| Path | Role |
|------|------|
| `docs/ROADMAP.md` | P0 legal line item |
| `apps/web/src/components/CookieBanner.tsx` | Consent UI, persistence |
| `apps/web/src/pages/ImprintPage.tsx` | Legal / company info (`/legal`) |
| `apps/web/src/pages/PrivacyPage.tsx` | GDPR-framed privacy notice |
| `apps/web/src/pages/TermsPage.tsx` | Terms of Service |
| `apps/web/src/pages/CookiesPage.tsx` | Cookie policy + table |
| `apps/web/src/components/LegalPageChrome.tsx` | Draft notice, lang toggle, section chrome |
| `apps/web/src/components/public/PublicFooter.tsx` | Legal + trust links |
| `apps/web/src/main.tsx` | Routes, aliases, global `CookieBanner` |
| `apps/server/src/services/session.ts` | **`floom_device`** cookie (not in cookie table at time of audit) |
| `apps/web/src/components/home/ProofRow.tsx` | Landing proof metrics (not legal compliance strip) |

---

## Conclusion (product, not legal)

The **P0 legal checklist is largely present in the UI**, with strong **discoverability** (footer + routes) and laudable **draft honesty**. The highest-value **product** follow-ups are: **complete the cookie table** (including `floom_device`), **align banner wording and behavior with the policy** (especially withdrawal and “Accept all”), and **resolve Sentry/analytics vs consent** before EU-facing production with a DSN. Clarify internally what “trust bar” means so roadmap, design, and compliance tasks stay aligned.
