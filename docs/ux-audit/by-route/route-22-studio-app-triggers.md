# Per-route UX audit — `/studio/:slug/triggers`

**Date:** 2026-04-20  
**Route:** `/studio/:slug/triggers`  
**Component:** `StudioTriggersTab` (`apps/web/src/pages/StudioTriggersTab.tsx`)  
**Shell:** `StudioLayout` with `activeSubsection="triggers"`; sidebar label **Triggers** (`StudioSidebar` → `/studio/:slug/triggers`).  
**Method:** Code-first (TSX + shared Studio shell). Authenticated Studio surface; no public `curl` probe. Automated screenshots not attached (run Playwright capture locally if visual verification is required).

**ICP lens (from `docs/PRODUCT.md`):** Non-developer AI engineer who needs production hosting without infra plumbing. Triggers support **automation** (schedule + webhook) on top of the hosted app—aligned with “Floom runs your code,” but **cron, IANA timezones, HMAC headers, and `openssl` in the curl example** skew toward integrator literacy; schedule-only users are better served than webhook users.

---

## Summary

| Level | Count | Notes |
|------|------:|------|
| **S1** Critical | 0 | No trust-breaking dead ends identified in this file alone. |
| **S2** Major | 5 | Sticky error banner; timestamp/timezone/cron ergonomics; modal accessibility; small control targets on rows. |
| **S3** Minor | 5 | Primary CTA always opens schedule flow; empty state could reinforce action; clipboard failure silent; webhook list shows path not full URL; copy/naming polish. |
| **S4** Cosmetic | 2 | Inline-style-heavy page (intentional per file header); ISO strings feel “debuggy.” |

---

## S2 — Major

### M1 — Error state never clears on success

- **Severity:** S2  
- **Category:** Error handling / Interaction design (checklist §4, §8)  
- **What:** `error` is set in `catch` paths for app load, trigger list load, toggle, and delete. There is **no** `setError(null)` on successful `reload()`, after a successful toggle/delete, or when the user dismisses implicitly. A prior failure (e.g. transient network error on load, or a failed delete) can leave a **red banner visible** after the user has recovered.  
- **Why it matters:** Violates “success/error feedback is clear and timely” and “error recovery is possible”; users may think the app is still broken.  
- **Fix:** Clear `error` at the start of successful `reload()`, after successful mutations, or add an explicit dismiss control.  
- **File:** `apps/web/src/pages/StudioTriggersTab.tsx` (`error` / `setError` usage).

### M2 — “Last fired” / “Next” as raw ISO strings

- **Severity:** S2  
- **Category:** Content & copy (checklist §5)  
- **What:** `last_fired_at` and `next_run_at` render via `new Date(...).toISOString()`.  
- **Why it matters:** ICP-friendly copy usually uses **locale-relative or human-readable** datetimes (and respects user timezone for “next run” interpretation). Raw ISO is accurate but reads as internal logs.  
- **Fix:** Format with `Intl.DateTimeFormat` (and optionally show user-local zone vs schedule `tz`).  
- **File:** `TriggerRow` in `StudioTriggersTab.tsx`.

### M3 — Timezone input is free text only

- **Severity:** S2  
- **Category:** Forms / ICP fit (checklist §4)  
- **What:** Schedule creation uses a plain text field for IANA timezone with example microcopy (`Europe/Berlin`, etc.). Validation is **only** on submit via API error.  
- **Why it matters:** ICP users may not know IANA names or may typo zones; failures arrive late with generic server messages.  
- **Fix:** Common-timezone presets, fuzzy validation, or inline validation before submit.  
- **File:** `NewTriggerModal` (`studio-triggers-tz`).

### M4 — Modal dialog accessibility gaps

- **Severity:** S2  
- **Category:** Accessibility (checklist §9)  
- **What:** Overlay has `role="dialog"` and `aria-modal="true"` but **no** `aria-labelledby` / `aria-describedby`, **no** Escape-to-close, **no** focus trap, and **no** focus move to the dialog on open. Backdrop click closes when not `busy` (good), but keyboard users can tab “behind” the overlay.  
- **Why it matters:** Fails basic modal patterns for keyboard and screen-reader users.  
- **Fix:** Wire focus trap + initial focus + Escape; associate title/description via `aria-*`.  
- **File:** `NewTriggerModal` in `StudioTriggersTab.tsx`.

### M5 — Row action buttons likely below 44×44px touch target

- **Severity:** S2  
- **Category:** Mobile (checklist §7)  
- **What:** `smallBtnStyle` uses `padding: '6px 12px'` and `fontSize: 12` for Enable/Disable and Delete on each row.  
- **Why it matters:** Checklist recommends **≥44×44px** touch targets; dense grid + small buttons increases mis-taps on phones.  
- **Fix:** Increase min height/padding on touch breakpoints or use full-width stacked actions on narrow viewports.  
- **File:** `TriggerRow` buttons.

---

## S3 — Minor

### m1 — “+ New trigger” always opens Schedule mode

- **What:** The header button calls `setMode('schedule')`, not a chooser. Webhook creation requires opening the modal then clicking the **Webhook** tab.  
- **Why it matters:** Extra step for the webhook-first user; discoverability is fine but not maximal.  
- **Fix (optional):** Split CTA, or remember last-used mode, or default from empty-state emphasis.

### m2 — Empty state has no primary button

- **What:** Empty panel explains triggers but does not duplicate **+ New trigger** inside the dashed box.  
- **Why it matters:** Minor friction; the top-right CTA is still visible on desktop but less so on small screens where the header stacks.  
- **Fix:** Add a secondary button in the empty state linking to the same action.

### m3 — Clipboard copy failure is silent

- **What:** `CopyField` catches clipboard errors with no UI fallback (comment: “best-effort”).  
- **Why it matters:** Non-HTTPS or permission-denied contexts can block `navigator.clipboard`; users lose the one-time secret with no explanation.  
- **Fix:** Inline error or “select all” hint when `writeText` fails.

### m4 — Webhook rows show path fragment, not full URL

- **What:** List displays `/hook/{webhook_url_path}` without the origin. The **create success** pane shows the full `webhook_url`.  
- **Why it matters:** Returning users may need the full URL again; copy says secret is one-time—**URL might still be reconstructible** from docs, but the UI does not spell out the base URL pattern on the list row.  
- **Fix:** Show canonical full URL (read-only) or link to docs for “base URL for your deployment.”

### m5 — Cron preview shows exception text for invalid expressions

- **What:** `cronstrue` errors surface as the raw message in the preview line while typing.  
- **Why it matters:** Slightly harsh for learners; still better than nothing.  
- **Fix:** Softer copy (“We could not parse this cron yet”) plus link to cron help.

---

## S4 — Cosmetic

- **Visual consistency:** Page relies on inline styles and CSS variables (`--ink`, `--muted`, `--line`, `--card`) consistent with the “tight Studio surface” note in the file header.  
- **Schedule vs webhook badges:** Distinct pill colors aid scanability.

---

## Checklist mapping (`~/.claude/skills/ui-audit/references/ux-review-checklist.md`)

| Section | Verdict |
|--------|---------|
| 1. First impressions | Pass: “Triggers” + subtitle + **+ New trigger** communicate purpose quickly. |
| 2. Information hierarchy | Pass: Title and primary CTA are clear; list vs empty states are distinct. |
| 3. Navigation & wayfinding | Pass: `StudioLayout` title pattern (`{app.name} · Triggers`), `activeSubsection="triggers"`, sidebar **Triggers**. |
| 4. Interaction design | Partial: Destructive delete confirmed; loading string present; **error banner sticky (M1)**; toggle/delete lack inline loading on row (acceptable at small scale). |
| 5. Content & copy | Partial: Webhook HMAC copy is precise; **ISO dates (M2)**; IANA help text ok but **freeform tz (M3)**. |
| 6. Visual design | Pass: Coherent with Studio; badge system readable. |
| 7. Mobile experience | Partial: Modal is responsive padding; **row buttons small (M5)**; header flex may wrap. |
| 8. Edge cases | Partial: Empty state good; **errors don’t clear (M1)**; clipboard **(m3)**. |
| 9. Accessibility | Partial: Some dialog semantics; **gaps (M4)**; form labels present for main fields. |
| 10. Performance perception | Pass: No heavy assets; list is in-memory map. |

**Cross-screen:** Align datetime formatting with **Runs** / **Analytics** Studio tabs if those use friendlier formats. **Three surfaces:** Triggers are an automation layer on the hosted app; they do not replace discoverability of `/p/:slug`, MCP, or HTTP from elsewhere—out of scope for this file but worth a sidebar/protocol link elsewhere.

---

## Weighted score (checklist methodology)

Flaws above counted against scores.

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|----------------|-------|
| Clarity | 25% | 7 | Purpose clear; ISO + cron/tz jargon pulls ICP down. |
| Efficiency | 20% | 7 | Fast path for schedule; webhook tab extra click; sticky errors waste time. |
| Consistency | 15% | 8 | Matches StudioLayout patterns. |
| Error handling | 15% | 4 | **Sticky errors (M1)** is the main drag. |
| Mobile | 15% | 5 | Small row buttons. |
| Delight | 10% | 7 | Human cron + one-time secret + copy fields are strong moments. |

**Overall (weighted):** ~6.5 / 10 — solid feature with strong “webhook secret once” UX undermined by error-state hygiene and accessibility/time presentation gaps.

---

## Files referenced

- `apps/web/src/pages/StudioTriggersTab.tsx` — page under audit.  
- `apps/web/src/components/studio/StudioLayout.tsx` — shell, `document.title`, auth gate.  
- `apps/web/src/components/studio/StudioSidebar.tsx` — **Triggers** nav.  
- `apps/web/src/api/client.ts` — `TriggerPublic`, `CreateTriggerResponse`, trigger APIs.

---

## Appendix — PRODUCT.md alignment

Triggers sit on the **hosted app** story: they do not replace repo→hosted detection or the three surfaces, but they **add production-style automation** without asking the user to run cron on their laptop. Treat **schedule** UX as ICP-first; treat **webhook + HMAC + curl** as **advanced** and ensure errors, dates, and recovery paths remain humane for the non-infra user.
