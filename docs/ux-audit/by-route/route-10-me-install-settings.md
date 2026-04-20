# Per-route UX audit — `/me/install` + `/me/settings`

**Date:** 2026-04-20  
**Scope:** `apps/web/src/pages/MeInstallPage.tsx`, `apps/web/src/pages/MeSettingsPage.tsx`  
**Method:** Code-first review against `docs/PRODUCT.md` (ICP) and `~/.claude/skills/ui-audit/references/ux-review-checklist.md`. Both routes use `PageShell` with `requireAuth="cloud"`; no live-session verification in this pass.

---

## `/me/install` — `MeInstallPage`

### Summary

The page states its job clearly: connect **Claude Desktop** to Floom via `claude_desktop_config.json`, pick a recently run app, copy JSON, restart. That matches the product pillar of **MCP as a first-class surface** (`docs/PRODUCT.md`). The stepped layout, copy rows, and empty state (“Browse apps”) are coherent for the ICP.

Friction clusters around **(a)** what Step 1’s base `/mcp` URL is for versus the per-app `mcp-remote` URL in Step 3, **(b)** accessibility of the “recent apps” control, **(c)** silent clipboard failure, and **(d)** the HTTP test snippet as the only “verify” path without tying it to “then use MCP in Claude.”

### Checklist-driven notes

| Area | Pass / gap | Notes |
|------|--------------|--------|
| First impressions | Pass | H1 + body explain purpose and primary outcome within a few seconds. |
| Hierarchy | Pass | Steps 1–4 read top-to-bottom; primary work is copy/paste. |
| Wayfinding | Pass | Breadcrumb to `/me`; title `Install to Claude \| Floom`. |
| Interaction | Mixed | Copy buttons give “Copied” feedback on success. Clipboard errors are swallowed with no message (checklist: timely error feedback). |
| Content | Mixed | “Step 4 — Test from HTTP” uses a different punctuation pattern than Steps 1–3 (colon). `curl` example uses empty `action` / empty `inputs`; fine for power users, opaque for ICP without a line of copy (“replace `action` with an operation from your app”). |
| Visual | Pass | Uses design tokens (`--card`, `--line`, `--ink`, mono stack) consistently with other shell pages. |
| Mobile | Risk | Pill “tabs” use small vertical padding; likely under common **44px** touch-target guidance when wrapped. `CopyRow` uses `whiteSpace: 'nowrap'` + ellipsis — URL may be hard to read on narrow viewports (user may not know full value before copy). |
| Edge cases | Pass | Loading card, API error card, empty state with CTA are all present. |
| Accessibility | Risk | `role="tablist"` / `role="tab"` without roving `tabIndex`, arrow-key behavior, or `aria-controls` / panels — keyboard and screen-reader users get buttons labeled as tabs without full tab semantics. Focus styles not visible in inline styles (browser default only). |
| Performance perception | Pass | Single `getMyRuns` fetch; no obvious layout thrash. |

### ICP / product alignment

- **Strength:** Surfaces **MCP + HTTP** in one flow, consistent with “three surfaces” positioning.
- **Gap:** Step 1 shows **`{origin}/mcp`** while the generated config uses **`mcp-remote`** against **`/mcp/app/:slug`**. A non-developer may not know whether they need both, or whether Step 1 is optional. One sentence of copy (“You only need the JSON below; this URL is for …”) would reduce second-guessing.

### Severity highlights

- **S3:** Clipboard failure is silent; add non-blocking inline error or toast.
- **S3:** Step 1 vs Step 3 relationship under-explained for ICP.
- **S3:** Tablist semantics incomplete for keyboard/AT users.
- **S4:** Step label punctuation inconsistency (em dash vs colon).

### Weighted score (checklist rubric)

Assumptions: flaws above counted before scoring; mobile + a11y gaps cap the top end.

| Dimension | Weight | Score (1–10) | Rationale |
|-----------|--------:|-------------:|-----------|
| Clarity | 25% | 7.5 | Goal clear; URL story slightly fuzzy. |
| Efficiency | 20% | 8 | Few steps to a working config. |
| Consistency | 15% | 7 | Small copy/pattern nits. |
| Error handling | 15% | 6 | API errors OK; clipboard not. |
| Mobile | 15% | 6 | Touch targets + truncated URL. |
| Delight | 10% | 6 | Functional, little “aha” beyond working copies. |

**Overall (weighted):** **7.0 / 10**

---

## `/me/settings` — `MeSettingsPage`

### Summary

Account settings are grouped into **Profile**, **Change password**, and **Danger zone**, with a prominent **Sign out** control — addressing the real risk of users feeling “orphaned” without a logout path (`MeSettingsPage` comments). **OSS / local mode** is explained with a banner; forms are disabled rather than faking saves. That matches `PageShell` behavior (`requireAuth="cloud"` still renders for signed-out cloud after redirect logic; local users see read-only settings).

The page is usable and honest about **read-only email** (Better Auth email change not shipped). Gaps are mostly **accessibility** (labels not wired to inputs, dialog focus), **validation timing** (password rules on submit only), and **wayfinding consistency** with `/me/install` (no breadcrumb back to `/me`).

### Checklist-driven notes

| Area | Pass / gap | Notes |
|------|--------------|--------|
| First impressions | Pass | H1 “Account settings” + subcopy + Sign out communicate purpose quickly. |
| Hierarchy | Pass | Cards separate concerns; danger zone visually distinct (`danger` border). |
| Wayfinding | Mixed | No breadcrumb or “back to /me” link unlike `MeInstallPage` — navigation relies on TopBar / browser back. |
| Interaction | Mixed | Destructive delete uses confirmation modal (pass). Modal closes on backdrop click (good escape); no visible focus trap or `aria-labelledby`. Submit buttons show saving / success strings (pass). |
| Content | Mixed | Email read-only is labeled; file-level comment says email change is intentionally omitted — the **UI does not say why** email cannot be changed in cloud mode (minor trust/transparency gap). |
| Visual | Pass | Card chrome aligns with stated goal of matching store/run surfaces. |
| Mobile | Pass | Stacked layout, full-width inputs; Sign out wraps under title in flex layout — acceptable. |
| Edge cases | Pass | OSS banner; disabled controls when not authenticated; delete errors mapped for 401/400 vs generic. |
| Accessibility | Risk | `Label` renders `<label>` children but **no `htmlFor`** on labels and **no `id`** on inputs — programmatic label association missing. Delete dialog: `role="dialog"` + `aria-modal` but no labelled title hook for SR; password field in modal should receive initial focus. |
| Performance perception | Pass | Session-driven re-seed with dirty flags avoids clobbering edits — good perceived stability. |

### ICP / product alignment

- **Strength:** Keeps **cloud auth** as the real settings surface; OSS is clearly **read-only**, not a fake persistence layer — aligned with “don’t make self-hosters think they changed a remote account.”
- **Gap:** ICP who signed up with OAuth-only might hit password change / delete flows that assume a password exists — behavior depends on Better Auth + server; the UI does not surface “password not set; use magic link / provider” if applicable (verify server contracts; document if known).

### Severity highlights

- **S2:** Form labels not associated with controls — fails basic a11y checklist and can hurt voice control / SR users.
- **S3:** Delete dialog focus management and labelling for assistive tech.
- **S3:** Add one line under read-only email in cloud mode: “Changing email isn’t available yet” (or link to support / roadmap) to match code intent in comments.
- **S4:** Breadcrumb or “← Account” link for parity with `/me/install`.

### Weighted score (checklist rubric)

| Dimension | Weight | Score (1–10) | Rationale |
|-----------|--------:|-------------:|-----------|
| Clarity | 25% | 8 | Sections and actions are obvious. |
| Efficiency | 20% | 8 | Straight paths to save / change password / sign out / delete. |
| Consistency | 15% | 7 | Card system good; wayfinding vs other `/me/*` pages uneven. |
| Error handling | 15% | 7.5 | Inline errors for API failures; password validation mostly on submit. |
| Mobile | 15% | 8 | Reasonably thumb-friendly; modal padding OK. |
| Delight | 10% | 6 | Solid utility page; little celebration beyond “Saved” / “Password changed”. |

**Overall (weighted):** **7.6 / 10**

---

## Cross-route (these two only)

- **Consistency:** `/me/install` uses a breadcrumb; `/me/settings` does not — consider one pattern for all `/me/*` utilities.
- **Shared pattern:** Both rely on `PageShell` + max-width column; visual family matches. Error/success colors (`#fff8e6` warning strip, amber error text) align with `MeInstallPage`’s `ErrorCard` family.
