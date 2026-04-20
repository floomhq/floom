# Per-route UX audit — `/r/:runId`

**Date:** 2026-04-20  
**Route:** `/r/:runId`  
**Component:** `PublicRunPermalinkPage` (`apps/web/src/pages/PublicRunPermalinkPage.tsx`)  
**ICP:** `docs/PRODUCT.md` (non-developer AI engineer; shareable surfaces matter for trust and distribution)  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`

## Scope (what this route actually renders)

This route is a **thin client bridge**, not a run viewer:

1. On mount it calls `getRun(runId)` (`GET /api/run/:runId`).
2. **Success:** if `run.app_slug` is present, it **`replace`-navigates** to `/p/:slug?run=<runId>` — the shared run is shown on **`AppPermalinkPage`**, not here.
3. **Failure:** static error shell with `TopBar` (`compact`), `Footer`, heading, body copy, and CTAs.

**Dependencies read for this audit:** `PublicRunPermalinkPage.tsx`, `apps/web/src/lib/publicPermalinks.ts` (`classifyPermalinkLoadError`, `getPermalinkLoadErrorMessage`), `apps/web/src/components/RouteLoading.tsx`, `apps/web/src/api/client.ts` (`getRun` + inline doc on public share semantics). **`OutputPanel` is not imported**; run output UX belongs to the `/p/:slug` audit after redirect.

## Checklist walkthrough

### 1. First impressions (5-second test)

- **Purpose:** Clear only on **error** (“Shared run not found” / “temporarily unavailable”). On **success**, the user mostly sees **branded loading** (`RouteLoading` `variant="embed"`) and is moved to the permalink — which matches the mental model “open this link to see the run,” provided the destination loads.
- **Primary action:** On errors, **“Back to all apps”** (`/apps`) is always available; **“Try again”** appears only for **retryable** (non-404) failures.
- **Attention:** Large `h1` and muted explanatory copy; inline monospace `/r/{id}` draws the eye on not-found (useful for support, slightly technical for ICP).
- **Finished vs WIP:** Feels **intentional and minimal**, not half-built; inline styles match a small utility page pattern.

### 2. Information hierarchy

- **Prominence:** Title and explanation lead; CTAs are secondary block below. Good.
- **Subordination:** Muted body (`var(--muted)`) vs strong title works.
- **Empty state:** N/A — this route does not show an empty catalog; loading vs error only.

### 3. Navigation and wayfinding

- **Where am I?** No breadcrumb or “You are viewing…” — acceptable for a **redirect hop**, weak if the user **lands on error** (they only see a generic title, not “Floom shared link”).
- **Back / home:** **“Back to all apps”** is a reasonable global escape; recipients who are **not** Floom users may still understand “browse apps” less than “Home” or product name, but `/apps` is the hub used elsewhere.
- **TopBar:** `compact` preserves global nav (sign-in, publish, etc.) consistent with other shells.

### 4. Interaction design

- **Clickable affordances:** Primary-style **Try again** (retryable) and **Link** styled as button for `/apps` — both read as actions.
- **Loading:** `RouteLoading` sets `aria-busy="true"` and exposes **“Loading…”** via `.sr-only` `role="status"` `aria-live="polite"` — good baseline.
- **Retry:** `window.location.reload()` is a blunt but predictable recovery for transient network/API errors.
- **Destructive actions:** N/A on this page.

### 5. Content and copy

- **Not found:** Plain language plus literal path in `<code>` — helps debugging; may feel **technical** to some ICP users.
- **Retryable:** `getPermalinkLoadErrorMessage('run')` — *“We couldn't open this shared run right now. Check your connection and try again.”* Aligns with **connectivity** framing; **may misfire** if the real issue is server 5xx vs client network (still directionally OK).
- **Jargon:** “Shared run” is on-brand and understandable.

### 6. Visual design

- **Layout:** Centered column (`maxWidth` 520–560), `paddingTop: 80` clears `TopBar` — consistent with other centered error/utility layouts.
- **Typography:** Single `h1` at 32px; body 16px — readable hierarchy.
- **Color:** Uses design tokens (`var(--accent)`, `--muted`, `--card`, `--line`, `--ink`) — consistent with the system.

### 7. Mobile experience

- **CTAs:** `flexWrap: 'wrap'` on the button row helps small widths.
- **Touch targets:** Padding ~10px vertical × 20px horizontal on controls — **borderline vs 44px** guideline; not a full failure but not ideal for thumbs.
- **Horizontal scroll:** Unlikely with narrow `maxWidth` and wrapped actions.

### 8. Edge cases and error states

| State | Behavior | UX note |
|-------|----------|---------|
| **Loading** | `RouteLoading` + shell | Fine; may **flash** briefly on fast networks — acceptable. |
| **404 from API** | Treated as **not_found** | Same UI as **missing `app_slug`** on a 200 response — user **cannot tell** “bad id” vs “run exists but not shared / not public” vs “wrong app.” |
| **Any non-404 error** | **retryable** | Includes cases where **retry will not help** (e.g. persistent **403** if taxonomy ever surfaces that way). Copy suggests **connection**, not **permission**. |
| **Missing `runId` in params** | `not_found` | Rare for this route shape; handled defensively. |

**Offline:** No dedicated offline message; falls under retryable path with same copy.

### 9. Accessibility basics

- **Focus:** Native `button` and `Link` — keyboard reachable; no obvious skip link (same as many marketing shells).
- **Headings:** Single logical `h1` per error view — good.
- **Contrast:** Relies on global tokens; no obvious violation from code alone (visual verification recommended).

### 10. Performance perception

- **Single request** then navigation — efficient.
- **`replace: true`:** Avoids stacking `/r/...` in history so **Back** from `/p/...` does not return to a useless loader — **good**.

## Cross-route consistency and user flow

- **Destination:** Success path hands off to **`/p/:slug?run=…`**, where **`AppPermalinkPage`** owns prefetch/hydration and read-only run surfacing (see comments in that file). This audit should be read **together** with **`route-03-permalink.md`** for end-to-end “shared link” UX.
- **Product alignment:** `client.ts` documents that **`/api/run/:id`** is owner-only until **`shareRun`** marks the run public — recipients hitting a non-public run likely see **404** and the same **not found** copy as a truly missing id. **Trust copy** could acknowledge “ask the person who sent this link” without exposing internals.

## Findings (ordered: flaws first)

1. **Ambiguous not-found (S2):** One message covers **invalid ID**, **unshared run**, and **missing slug** — users cannot self-diagnose. Consider differentiated copy when the API can signal **share required** vs **missing** (without leaking existence if that is a security requirement).
2. **Retryable = any non-404 (S2):** `classifyPermalinkLoadError` maps everything except 404 to **retryable**, so **permission-like** failures could show **“check your connection”** and **Try again** — undermines error recovery for ICP.
3. **Recipient mental model (S3):** “Back to all apps” centers **catalog browsing**; some share recipients may want **home** or **what is Floom** — optional secondary link is a polish item.
4. **Touch target size (S3):** CTA padding may fall under common **44px** mobile guidance — verify on device.

## Scoring

**Flaws considered above before scores.**

| Dimension | Weight | Score (1–10) | Notes |
|-----------|--------|--------------|-------|
| Clarity | 25% | **7** | Clear on errors; success path is implicit loading then redirect. |
| Efficiency | 20% | **9** | Minimal steps; `replace` navigation avoids history trap. |
| Consistency | 15% | **8** | Tokens, `TopBar`/`Footer`, `RouteLoading` match app patterns. |
| Error handling | 15% | **6** | Helpful for network-ish failures; weak distinction for 404 vs access/share. |
| Mobile | 15% | **7** | Wrapped actions; touch targets could be larger. |
| Delight | 10% | **6** | Functional; no extra reassurance for share recipients. |

**Overall (weighted):** \(0.25 \times 7 + 0.2 \times 9 + 0.15 \times 8 + 0.15 \times 6 + 0.15 \times 7 + 0.1 \times 6\) ≈ **7.3 / 10**

## Code references (audit trail)

- `apps/web/src/pages/PublicRunPermalinkPage.tsx` — route logic, UI states, navigation.
- `apps/web/src/lib/publicPermalinks.ts` — error classification and retryable copy.
- `apps/web/src/components/RouteLoading.tsx` — loading accessibility pattern.
- `apps/web/src/api/client.ts` — `getRun`, `shareRun` documentation (public visibility semantics).
