# Per-route UX audit — `/apps` (store directory)

**Scope:** `AppsDirectoryPage` (`apps/web/src/pages/AppsDirectoryPage.tsx`) only. **ICP:** `docs/PRODUCT.md` (discover → run; non-developer). **Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`.

## Summary (this route only)

| Level | Count |
|------|------:|
| **S1** Critical | 0 |
| **S2** Major | 2 |
| **S3** Minor | 4 |
| **S4** Cosmetic | 1 |

---

## Findings

### A1 — S2 — Client-only `qualityHubApps` vs marketing “live” claims

- **What:** The list is sorted/filtered with `qualityHubApps(apps)` before display. That improves perceived quality but the **count** in the header (`PUBLIC DIRECTORY · N APPS`) reflects **post-filter** length, while upstream hub may still expose more rows elsewhere — users comparing Store vs API can see a mismatch.
- **Why it matters:** If “N apps” is used as social proof, it must match a **single** definition of “listed in Store” vs “registered in hub.”
- **Fix:** Document in UI microcopy that the directory is **curated**, or show both “listed” and “total” if transparency matters.
- **Files:** `apps/web/src/pages/AppsDirectoryPage.tsx`, `apps/web/src/lib/hub-filter.ts`

### A2 — S2 — Search submit is a no-op

- **What:** `<form role="search" onSubmit={(e) => e.preventDefault()}>` — the **Search** button does not trigger any behavior beyond what the debounced input already does (filter-as-you-type). The button looks like the primary action for “run search.”
- **Why it matters:** ICP users may click Search expecting navigation or server-side search; nothing happens on submit (already filtered). Minor trust hit.
- **Fix:** Remove the button, or make submit **scroll** to results / announce result count via `aria-live`, or wire to explicit “apply” if you move off live filter.
- **Files:** `apps/web/src/pages/AppsDirectoryPage.tsx`

### A3 — S3 — Category strip `aria-hidden` when only “All”

- **What:** When `categories.length <= 1`, the chip container sets `aria-hidden="true"` — good to hide a useless strip, but ensure **no** focusable controls remain inside (currently none when hidden).
- **Fix:** OK as-is; verify if future chips render in loading state.

### A4 — S3 — Hub error is generic

- **What:** `catch` sets `hubError` to fixed `"Couldn't load apps"` with Retry — no status code or “maintenance” distinction.
- **Fix:** Map 5xx vs network for calmer copy; optional support link.
- **Files:** `apps/web/src/pages/AppsDirectoryPage.tsx`, `getHub` client

### A5 — S3 — Empty directory vs empty filter

- **What:** Two states: truly no apps vs no matches — both are clear; “Clear filters” only appears in filter-empty case. Good.
- **Fix:** None.

### A6 — S3 — Mobile headline scaling

- **What:** `.apps-headline` drops to 30px at 640px — verify line breaks with long localized titles if i18n expands later.
- **Fix:** Optional `clamp()` for smoother scaling.

### A7 — S4 — Focus ring on search pill

- **What:** Inline `onFocus`/`onBlur` style mutation for border/shadow — works for pointer; keyboard focus should be verified against `:focus-visible` parity.
- **Files:** `apps/web/src/pages/AppsDirectoryPage.tsx`

---

## Checklist highlights

| Area | Notes |
|------|--------|
| First impressions | H1 + subhead clear; count shows after load. |
| Hierarchy | Search → chips → list is logical. |
| Loading / error | Loading text, retry on error, reserved min-heights (CLS). |
| Mobile | Responsive headline; chips wrap; stripes in `AppStripe`. |
