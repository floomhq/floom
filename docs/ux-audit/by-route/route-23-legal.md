# Per-route UX audit — legal cluster

**Date:** 2026-04-20  
**Routes:** `/legal`, `/imprint`, `/privacy`, `/terms`, `/cookies` (see `apps/web/src/main.tsx`; `/legal/*` and `/impressum` redirect to the flat slugs)  
**Components:** `ImprintPage.tsx`, `PrivacyPage.tsx`, `TermsPage.tsx`, `CookiesPage.tsx` under `apps/web/src/pages/`  
**Shared UI:** `LegalPageHeader`, `LegalSection`, `LegalLangToggle` in `apps/web/src/components/LegalPageChrome.tsx` inside `PageShell` (→ unified `PublicFooter` as `Footer`)  
**Mode:** Code-first UX / product review  
**ICP lens:** `docs/PRODUCT.md` (non-developer AI engineer; trust and clarity still matter for signup and org evaluation, even if legal routes are not the core “paste repo” journey)  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Public probe:** `curl -sI` to `https://floom.dev/legal`, `/imprint`, `/privacy`, `/terms`, `/cookies` — all **HTTP 200** with `text/html` and expected security headers (CSP, HSTS, `nosniff`, `X-Frame-Options`).

**Cluster roll-up (severity):** **S1** 0 · **S2** 0 · **S3** 4 (language strategy inconsistency, mobile table scroll, long-form scannability, monolingual vs bilingual split) · **S4** 1 (sitemap/alias duplication for `/legal` vs `/imprint`).

**Weighted UX scores (checklist):** **Clarity** 8/10 · **Efficiency** 7/10 (long text, no TOC) · **Consistency** 6/10 (language defaults + monolingual vs bilingual split) · **Error handling** N/A (static) · **Mobile** 7/10 (table scroll) · **Delight** 7/10 (honest “preliminary draft” + bilingual privacy/cookie care). **Overall (weighted):** ~7.1/10, dominated by the language-strategy inconsistency and mobile table pattern before deeper legal review is due.

**Suggested backlog (this cluster, ordered):** (1) Single language default + optional `localStorage` (or `navigator`) sync across Privacy/Cookies and consider EN/DE (or a stub) for Terms/Imprint for the same `Lang` value. (2) Optional one-line “Terms in English; Privacy/Cookies available in DE+EN” on Terms, or add DE terms when counsel-ready. (3) Responsive cookie table. (4) Optional TOC for Privacy (and long Terms) for scan efficiency.

---

## `/legal` and `/imprint` (`ImprintPage`)

- **5-second test:** Clear “who is Floom, Inc. and how to contact them.” No primary *action* beyond reading and following mailto / policy links; that matches a legal/company page. H1 and `document.title` both read “Legal” (`Legal · Floom` in the shell) — consistent with the footer label **Legal** (`PublicFooter` links to `/legal`).
- **Information hierarchy:** Three short sections: Company, Contact, Policies. Policies links use same slugs as the footer (`/terms`, `/privacy`, `/cookies`) — wayfinding is coherent. The **preliminary draft** callout in `LegalPageHeader` (green notice, last-updated line with `<time dateTime=…>`) sets expectations honestly for a pre-revenue product.
- **Language:** **English only** (no `LegalLangToggle`). The file comment explains the US legal frame vs a German *Impressum*; the page body does not over-explain that for the visitor, which is fine for a US entity but sits next to **DE+EN** Privacy and Cookies — users arriving from a German privacy page may find the language switch jarring.
- **Navigation / chrome:** `PageShell` + `TopBar` + `main#main`; no breadcrumb. Footer repeats Legal / Privacy / Terms / Cookies — the active route is not visually distinct in the footer (expected for a flat link row).
- **Affordance / interaction:** All links are standard anchors; `mailto:team@floom.dev` is a clear contact path.
- **Accessibility & semantics:** Section titles use `LegalSection` (`<section id>` + `h2` with in-heading `#` link for shareable fragments). `PageShell` does not add an `<h1>` landmark beyond what the page renders — the legal header provides a single `h1` (meets a sensible heading order).
- **Imprint / legal alias:** `/imprint` renders the same component as `/legal` (sitemap and bookmarks may keep both); behavior is user-transparent. Minor SEO/duplicate-URL class concern only if no canonical tag at HTML layer (not visible from TSX alone) — **S4**.

---

## `/privacy` (`PrivacyPage`)

- **5-second test:** Immediately readable as a **Privacy Policy**; DE/EN toggle is **above** the H1, right-aligned, before the user reads the body — strong “this is a formal notice” pattern for EU users.
- **Bilingual experience:** `useState<Lang>('en')` defaults to **English**. `LegalLangToggle` uses `aria-pressed` and `aria-label="Language"` on a `role="group"` control — good basics. Body copy in German mirrors structure and GDPR references in English; long but appropriate for the audience.
- **Scannability:** Nine numbered `LegalSection` blocks per language with stable `id`s (`controller` / `verantwortlicher`, `data` / `daten`, etc.). In-page anchors in `h2` help deep linking. **S3 — length:** ICP skimming a wall of text may still feel heavy; a mini table of contents at the top (same pattern as not implemented here) would reduce back-scroll friction — optional product polish, not a blocker.
- **Cross-page links:** Cookie section points to `/cookies` with text matched to language — good.
- **Inconsistency vs Cookies:** `CookiesPage` defaults the toggle to **German** while Privacy defaults to **English**. A user who toggles on one page does not see that state on the other (state is per-page) — **S3** (expectation: “I picked DE for legal text” should follow across the cluster, or at least a consistent default).

---

## `/terms` (`TermsPage`)

- **5-second test:** Clearly a **Terms of Service**; structure matches typical SaaS: scope, account, AUP, IP, warranty, liability cap, Delaware law. Last-updated + preliminary banner match other legal pages — consistent trust treatment.
- **Information hierarchy:** 14 short sections; dense legal English is unavoidable. Section titles are action-oriented (Acceptable use, Your content) — scannable. Acceptable use bullets reference OpenAPI, containers, rate limits, `preview.floom.dev` in scope — **aligned** with the product’s three deployment paths in `docs/PRODUCT.md` without exposing internal jargon to casual readers.
- **Language:** **English only**; no `LegalLangToggle`, unlike **Privacy** and **Cookies** which offer DE+EN. **S3** — a German (or other EU) user may see DE privacy/cookie text and EN terms without an explicit “Terms are provided in English only” note at the top.
- **Interaction / edge content:** “Pricing” states preview is free and future paid via processor — clear for the ICP. Governing law / Delaware courts is explicit, with a nod to **mandatory consumer-protection** rules in the user’s country — helpful EU-facing clarity.

---

## `/cookies` (`CookiesPage`)

- **5-second test:** Purpose is clear; DE is the **default** language for the page (`useState<Lang>('de')`), inverting the Privacy default. **S3** — the cluster should either standardize a default (e.g. `navigator.language` or always `en`) or persist language across Privacy/Cookies/Terms/Imprint.
- **Cookie table UX:** `CookieTable` is wrapped in `overflowX: 'auto'` — on narrow viewports, users can **horizontally scroll** a four-column table. Content remains readable; **S3** — on phones, a stacked or card layout would avoid two-axis reading.
- **Copy & accuracy:** The table names actual cookies (`floom.session`, `floom.cookie-consent`, `floom.theme`) with purpose, duration, and type. Aligns with the “strictly necessary + preference” story and matches the more abstract privacy bullet list; trust-positive for a compliance-minded reviewer.
- **Cookie banner alignment:** The copy describes reopening a banner to withdraw consent; worth verifying in `CookieBanner.tsx` in a separate pass that the behavior matches the written promise (out of scope for this route-only file beyond noting the dependency).
