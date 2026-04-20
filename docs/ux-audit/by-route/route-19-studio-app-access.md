# Per-route UX audit — `/studio/:slug/access`

**Date:** 2026-04-20  
**Component:** `StudioAppAccessPage` (`apps/web/src/pages/StudioAppAccessPage.tsx`)  
**Shell:** `StudioLayout` (`activeSubsection="access"`)  
**Auth:** Cloud session required (`StudioLayout` → login with `next=` return URL when signed out).  
**Method:** Code-first audit against `docs/PRODUCT.md` and `~/.claude/skills/ui-audit/references/ux-review-checklist.md`. No live screenshots in this revision.

---

## ICP alignment (`docs/PRODUCT.md`)

This page controls **who can discover and run** an app (Store visibility + auth-required mode). That maps to the product promise of **hosted apps with an auth layer** and the **three surfaces** (web form `/p/:slug`, MCP, HTTP). The page partially explains runtime paths (`/apps`, `/p/:slug`) but does **not** spell out MCP or HTTP implications of each visibility mode, which matters for a non-developer who thinks in “who can use my thing” not in route names.

---

## Summary

| Level | Count | Notes |
|------:|------:|------|
| **S1** Critical | 0 | — |
| **S2** Major | 2 | Loading blank; keyboard / roving focus on custom radiogroup |
| **S3** Minor | 4 | Route jargon in copy; error copy; success notice persistence; header only shows “Private” |
| **S4** Cosmetic | 2 | Title before app name resolves; dashed stub box rhythm |

---

## Checklist mapping (ux-review-checklist.md)

### 1. First impressions

- **Page purpose:** Clear after load (`Visibility`, `API keys` headings). During initial fetch, main content can be **empty** (no skeleton) — hurts the 5-second test.
- **Primary action:** Choose visibility (three large cards). Obvious once data is present.
- **Finished vs WIP:** API keys block is explicitly “Coming v1.1” — honest; reads as **staged product**, acceptable if Studio nav sets expectations.

### 2. Information hierarchy

- Visibility options are prominent; API keys section is secondary with dashed border — appropriate.
- **Headings:** `h2` for sections but **no page-level `h1`** in this file (the shared `AppHeader` uses `h1` for the app name). Logical for Studio drilldown; screen reader order is app name then sections — OK.

### 3. Navigation & wayfinding

- **Where am I:** Sidebar `Access` active via `activeSubsection="access"`; document title `{name} · Access · Studio`.
- **Back / escape:** `StudioLayout` + sidebar + TopBar — consistent with other Studio app routes (`INDEX.md` route 16–18 pattern).

### 4. Interaction design

- Cards are `type="button"` with `role="radio"` inside `role="radiogroup"` — good intent.
- **Saving:** All options `disabled={saving}` during PATCH — clear wait state; cursor `wait` on active control.
- **Success:** Green notice after visibility change; **no auto-dismiss** or undo.
- **Errors:** Generic `Error` message or `HTTP ${status}` — not always actionable.

### 5. Content & copy

- **Jargon:** Descriptions cite **`/apps`**, **`/p/:slug`** — accurate for builders, **heavy for ICP** who may not internalize URL structure. Prefer “Store listing” / “public link” with optional “Advanced” collapsed route names.
- **Auth required:** “callers need a Floom account” is plain language; good.
- **API keys stub:** Explains session cookie vs PAT — aligns with “no secrets manager homework” positioning.

### 6. Visual design

- Uses shared CSS variables (`--ink`, `--muted`, `--accent`, `--line`, `--card`) for options; error/notice use **fixed hex** reds/greens — same pattern as `MeAppPage` error block, so **cross-page consistent**, not random.

### 7. Mobile

- Visibility grid `maxWidth: 640`, single column — scales reasonably.
- Option buttons: vertical padding 14px + two text rows — likely **≥44px** hit height; verify on device.
- **Floating studio menu** (`StudioLayout` 44×44 toggle) applies; no extra modals on this page.

### 8. Edge cases

- **404:** `replace` navigate to `/studio`.
- **403:** `replace` navigate to `/p/${slug}` — assumes viewer can use permalink; reasonable for non-owner access attempt.
- **Slug missing:** effect no-ops; page stays with null `app` — rare route misconfig; low priority.
- **Load:** No dedicated loading UI — **gap** (see S2).

### 9. Accessibility basics

- **Radiogroup:** `aria-label`, `aria-checked` set — good.
- **Keyboard:** Native `<input type="radio">` groups get arrow-key behavior from the browser; **custom buttons do not** unless scripted. Expect **arrow key / roving tabindex** gap for WCAG-minded users (see S2).
- **Focus visible:** Relies on browser defaults; no `:focus-visible` styling in component.

### 10. Performance perception

- Single `getApp` on mount; visibility PATCH only on change — light.
- No skeleton → possible **layout pop** when `AppHeader` appears.

---

## Findings (detail)

### S2 — Major

**M1 — Empty main while app detail loads**

- **What:** Until `api.getApp(slug)` resolves, `app` is null and the fragment guarded by `app &&` renders nothing. Unlike `MeAppPage`, there is no `LoadingSkeleton` (or `RouteLoading` in the main column only).
- **Why it matters:** Signed-in creators see a **blank** workspace under the shell; looks broken or slow, especially on cold API latency.
- **Evidence:** ```72:137:apps/web/src/pages/StudioAppAccessPage.tsx
  return (
    <StudioLayout
      ...
    >
      {error && <div style={errorStyle}>{error}</div>}
      {notice && <div style={noticeStyle}>{notice}</div>}
      {app && (
        <>
          <AppHeader app={app} />
          ...
        </>
      )}
    </StudioLayout>
  );
```
- **Fix direction:** Inline skeleton or reuse `MeAppPage`’s loading pattern for Studio app subpages.

**M2 — Custom radio group without keyboard roving**

- **What:** Three `role="radio"` buttons; no `tabIndex` roving, no `onKeyDown` for Arrow/Home/End.
- **Why it matters:** Checklist §9 expects keyboard parity with native radios; screen reader users may get confused when arrows do not move selection.
- **Evidence:** ```89:119:apps/web/src/pages/StudioAppAccessPage.tsx
          <div
            role="radiogroup"
            aria-label="Visibility"
            ...
          >
            <VisibilityOption ... />
```
- **Fix direction:** Use native `<fieldset><legend>` + `<input type="radio">` styled as cards, or implement [roving tabindex](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) for the button pattern.

### S3 — Minor

**m1 — Route-centric helper copy**

- **What:** “Anyone can find and run this app via /apps and /p/:slug.”
- **Why:** ICP in `docs/PRODUCT.md` should not **have** to learn URL taxonomy to understand public vs private.
- **Fix direction:** Lead with outcomes (“listed in the Store”, “shareable public page”); put paths in secondary text or “Developer details”.

**m2 — Error messages rarely actionable**

- **What:** Failed PATCH surfaces `(err as Error).message` or `HTTP ${res.status}` with no “retry”, “sign in again”, or link to support.
- **Fix direction:** Map 401/403/5xx to short recovery copy consistent with `OutputPanel` / Studio patterns.

**m3 — Success notice persists**

- **What:** `setNotice` on success is never cleared on next action or timeout; only cleared when starting another `saveVisibility`.
- **Why:** Older success banners stack visually with new errors if a later call fails — minor clutter.

**m4 — `AppHeader` visibility badge only for `private`**

- **What:** `AppHeader` shows a “Private” chip only when `visibility === 'private'`. “Auth required” and “public” have no complementary badge on this page.
- **Why:** Users confirming “auth required” mode get no reinforcing label in the header — only inside the radio list.

### S4 — Cosmetic

- Document title is `Access · Studio` until `app` exists, then `{name} · Access · Studio` — small title flash.
- “Coming v1.1” vs elsewhere the product may say “coming soon” — vocabulary drift only.

---

## Cross-route consistency

| Topic | Note |
|--------|------|
| **Me vs Studio** | `MeAppPage` `TabBar` still has **Access** as `disabled: true` while Studio ships `/studio/:slug/access` — mental model split (see launch doc M3 legacy vs Studio). |
| **Secrets / auth story** | Visibility + future per-app keys touch the same “who can call my app” theme as Secrets; consider cross-links (“Need upstream credentials?” → Secrets) without duplicating C1 from the launch audit. |
| **Three surfaces** | Optional enhancement: one line under visibility stating that **MCP and HTTP** follow the same visibility/auth rules (if true in backend); reduces “did I only lock the website?” anxiety. |

---

## Weighted scores (checklist § Scoring)

Flaws above considered.

| Dimension | Weight | Score (1–10) | Rationale |
|-----------|--------:|-------------:|-----------|
| Clarity | 25% | 7 | Clear after load; route jargon and MCP/HTTP ambiguity hold it back. |
| Efficiency | 20% | 8 | One-click visibility change; no extra publish step. |
| Consistency | 15% | 7 | Matches Studio patterns; Me tab still disabled for Access. |
| Error handling | 15% | 5 | Load gap + thin HTTP errors. |
| Mobile | 15% | 7 | Layout OK; verify focus/touch on real devices. |
| Delight | 10% | 6 | Straightforward; stub is transparent, not delightful. |

**Overall (weighted):** **6.9 / 10**

---

## Files touched by this audit

- `apps/web/src/pages/StudioAppAccessPage.tsx`
- `apps/web/src/components/studio/StudioLayout.tsx` (auth gate, shell, mobile drawer)
- `apps/web/src/components/studio/StudioSidebar.tsx` (`Access` subnav)
- `apps/web/src/pages/MeAppPage.tsx` (`AppHeader`, `TabBar` comparison)
- `apps/web/src/main.tsx` (route registration)
- `docs/PRODUCT.md` (ICP + three surfaces)

---

## Suggested backlog (this route only)

1. Add **loading skeleton** (or shared async placeholder) for `!app && !error`.  
2. **Keyboard-complete** visibility control (native radios or APG radio pattern).  
3. **Rewrite** visibility descriptions for ICP (outcomes first, paths second).  
4. **Richer errors** + optional **dismiss** or timed fade for success notice.  
5. Optional: **header chips** for `auth-required` / `public` if product wants at-a-glance state.
