# Per-route UX audit — `/studio/settings`

**Date:** 2026-04-20  
**Route:** `/studio/settings`  
**Component:** `StudioSettingsPage` (`apps/web/src/pages/StudioSettingsPage.tsx`)  
**Shell:** `StudioLayout` (`apps/web/src/components/studio/StudioLayout.tsx`)  
**ICP (from `docs/PRODUCT.md`):** Non-developer AI engineer with a localhost prototype who needs production hosting without learning Docker, reverse proxies, or infra plumbing.  
**Checklist applied:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md` (code-first; no automated captures in this pass).

---

## Summary

| Level | Count | Notes |
|------:|------:|------|
| **S1** Critical | 0 | No ICP-breaking dead ends observed in code path. |
| **S2** Major | 0 | Stubs are explicit; cross-links to `/me/settings` are clear. |
| **S3** Minor | 4 | Copy/mental-model polish, touch targets, focus affordance. |
| **S4** Cosmetic | 2 | Visual weight of danger-styled navigation link. |

**Product alignment:** The page correctly positions **Studio** as creator-specific surface while **account profile and password** live under shared **`/me/settings`**, matching the in-file intent and the three-surfaces / hosted-product story (no code edits in this audit).

---

## What this screen does (code-verified)

- **Document title:** `Settings · Studio` via `StudioLayout` `title` prop.
- **Auth:** Cloud users who are still “local” (`is_local`) are redirected to `/login?next=…` by `StudioLayout`; session loading shows embedded `RouteLoading`.
- **Sections:** Account (summary + link), Creator API keys (stub), Billing (stub), Danger zone (copy + link to shared account settings).
- **Automation:** Root wrapper `data-testid="studio-settings"`.

---

## Checklist walkthrough

### 1. First impressions (5-second test)

- **Purpose:** Clear — “Studio settings” plus body copy that creator preferences live here and **account/profile** are in shared user settings.
- **Primary action:** Outbound: **Edit profile →** and **Account settings →** both target `/me/settings`. There is no in-page form; the primary job is **routing the user to the right place**, which is appropriate given the comment in source.
- **Finished vs WIP:** **Creator API keys** and **Billing** are honestly labeled **Coming v1.1** with dashed cards — reads as staged roadmap, not a broken screen.

### 2. Information hierarchy

- **H1** “Studio settings” dominates; section labels are small-caps **H2**-style headings (`Section`).
- **Stubs** are visually subordinate (dashed border, badge) vs solid **Account** card.
- **Risk:** The **Danger zone** heading may draw disproportionate attention relative to its actual content (explanatory copy + navigation), discussed under Interaction / Visual.

### 3. Navigation & wayfinding

- **Where am I:** `StudioLayout` + browser title; sidebar context assumed from parent (not overridden with `activeAppSlug` on this page — acceptable for a global Studio page).
- **Back / escape:** Standard Studio chrome (sidebar, TopBar) applies; no extra breadcrumbs on this page.
- **Labels:** “Account,” “Creator API keys,” “Billing,” “Danger zone” match common mental models. **Creator API keys** is slightly product-specific but reasonable for this audience.

### 4. Interaction design

- **Clickable:** Links use button-like padding and borders; stubs are **not** interactive — good.
- **Loading:** Session gate handled by `StudioLayout` (`RouteLoading` while session pending / login required).
- **Destructive actions:** No destructive control on this route. **Danger zone** only explains where deletion happens and links to `/me/settings`. No confirmation UI needed here.
- **Gap:** Inline-styled `<Link>` elements do not obviously include **focus-visible** styling in this file; keyboard users may get weaker affordance than router defaults depending on global CSS (flag for verification in browser).

### 5. Content & copy

- **Strength:** Intro paragraph cleanly separates **Studio** vs **shared user settings**.
- **Stub — API keys:** “Until then, use your browser session or the self-host API token.” The **self-host API token** phrase skews toward operators/self-hosters; the ICP is cloud-first per `docs/PRODUCT.md`. It is accurate as interim guidance but may feel **off-audience** for the primary persona (**S3**).
- **Stub — Billing:** Copy distinguishes free self-run Studio vs paid Cloud — aligns with product framing; still future-tense, which is honest.
- **Danger zone:** Explains app deletion via **Overview** and full account deletion via **shared account settings** — reduces wrong-place deletion hunts (**positive**).

### 6. Visual design

- Uses design tokens (`var(--ink)`, `var(--muted)`, `var(--line)`, `var(--card)`, `var(--accent)`).
- **Danger zone** link uses fixed hex red `#c2321f` and border `#f4b7b1` rather than a shared semantic token — **S4** minor inconsistency if the rest of the app uses CSS variables for destructive accents.
- Typography: H1 24px / section labels 12px uppercase — hierarchy is readable.

### 7. Mobile experience

- **Touch targets:** **Edit profile →** and **Account settings →** use `padding: 8px 14px` — vertical hit area may fall **below ~44px** on small screens (**S3**). Content is not a “squeezed desktop” layout by structure (single column), but tap comfort should be validated.
- No horizontal scroll implied by layout (single column sections).

### 8. Edge cases & error states

- **No user display name/email:** Falls back to **“Local user”** and avatar **“?”** — understandable for local/dev; ensure cloud users always see real identifiers in production (session contract, not this file).
- **Empty data:** Stubs cover “not yet shipped” features without pretending features exist — good.

### 9. Accessibility basics

- **Heading order:** Single **h1**, section titles are **h2** inside `Section` — logical.
- **Avatar:** Initial in a div — decorative; no misleading `img` without alt.
- **Links:** Visible text (“Edit profile →”, “Account settings →”); arrow is part of label (screen readers will read it — acceptable).
- **Focus / keyboard:** Worth verifying focus rings on custom-styled links (**S3**).

### 10. Performance perception

- No heavy async beyond session already loaded by layout; no layout-heavy media. Perceived risk is low.

---

## Cross-screen consistency (brief)

- **Studio vs `/me`:** Intentional duplication of entry points to **`/me/settings`** (profile card + danger zone) matches the shared profile model described in the page comment. **Minor inconsistency:** first link says **Edit profile** while the second says **Account settings** — both go to the same route; some users may wonder if destinations differ (**S3**).

---

## Scoring (after flaws)

Weighted dimensions from checklist:

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|-------|
| Clarity | 25% | **8** | Purpose and split Studio vs account are clear; stub honesty helps. |
| Efficiency | 20% | **7** | Few steps, but real account work is one hop away by design. |
| Consistency | 15% | **7** | Tokens mostly consistent; danger link color is a one-off hex. |
| Error handling | 15% | **8** | No errors on this page; danger zone copy helps prevent wrong deletes. |
| Mobile | 15% | **6** | Likely fine; touch targets and focus need verification. |
| Delight | 10% | **6** | Functional; stubs manage expectations rather than delight. |

**Approximate overall (weighted): ~7.2 / 10**

---

## Prioritized follow-ups (this route only)

1. **S3:** Unify or clarify copy for the two `/me/settings` links (e.g. both “Account & profile” or add helper text that both go to the same place).
2. **S3:** Soften or segment **self-host API token** mention so cloud-first ICP users are not nudged toward a path that `docs/PRODUCT.md` treats as operator/secondary.
3. **S3:** Increase tap padding on primary links toward **44×44** minimum on narrow viewports.
4. **S3 / a11y:** Ensure `:focus-visible` styles on studio settings links match app standards.
5. **S4:** Align danger-zone link colors with shared destructive/semantic tokens if available.

---

## Appendix — files reviewed

- `apps/web/src/pages/StudioSettingsPage.tsx`
- `apps/web/src/components/studio/StudioLayout.tsx` (partial — auth gate, title, loading)
- `docs/PRODUCT.md`
- `~/.claude/skills/ui-audit/references/ux-review-checklist.md`
