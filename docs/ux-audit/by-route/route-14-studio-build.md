# Per-route UX audit — `/studio/build`

**Date:** 2026-04-20  
**Route:** `/studio/build`  
**Components:** `StudioBuildPage.tsx` → `BuildPage.tsx` (shared with legacy `/build` → redirect)  
**Method:** Code-first (TSX + hooks); no live browser capture in this pass.  
**ICP:** `docs/PRODUCT.md` — non-developer AI engineer; primary journey **paste repo / spec → detect → review → publish**; three surfaces (web form, MCP, HTTP) are product truth.  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`

---

## Route wiring (what the user actually gets)

- **`StudioBuildPage`** is a thin adapter: `StudioLayout` wrapper, `backHref="/studio"`, `postPublishHref={(slug) => `/studio/${slug}`}`. All UX is **`BuildPage`**.
- **Title:** `Publish an app | Floom` (same as store `/build` path).
- **Success CTAs:** “Open app” → `/p/:slug`; secondary “Manage in Studio” → `/studio/:slug` (store path would say “Install in Claude” / creator dashboard).

---

## Summary

| Level | Count | Headline |
|-------|------:|----------|
| **S1** | 1 | Studio shell auth gate vs anonymous publish flow coded in `BuildPage` |
| **S2** | 4 | Wayfinding copy, signup `next` URL, login draft banner, detect loading |
| **S3** | 5 | Step labels, hierarchy, visibility edge case, mobile/touch |
| **S4** | 2 | Emoji in `StudioSidebar` mobile toggle (cross-cutting) |

**Weighted score (checklist § Scoring):** Clarity **7/10**, Efficiency **6/10**, Consistency **6/10**, Error handling **8/10**, Mobile **6/10**, Delight **7/10** → **Overall ~6.7/10** (flaws below; cloud auth behavior dominates).

---

## S1 — Critical

### C1 — Anonymous detect → review → “Sign up to publish” may not run on cloud `/studio/build`

- **Severity:** S1 (journey / credibility vs code comments)  
- **Checklist:** §4 Interaction (loading/signup), § User Flow (onboarding), cross-screen Consistency.  
- **What:** `BuildPage` implements `!isAuthenticated` → persist `floom:pending-publish` → `SignupToPublishModal`, and restore `step === 'review'` after return (`PENDING_KEY`). **`StudioLayout`** (used only by this adapter) defaults `allowSignedOutShell={false}`. For **cloud** sessions, `data.cloud_mode && user.is_local` forces **immediate** navigation to `/login?next=<pathname+search>` before children render (`StudioLayout.tsx`).  
- **Why it matters:** Comments and modal copy (“Your app is saved…”) imply a **signed-out** creator can complete detect/review first. On **cloud**, `/studio/build` behaves like **login-first** (same as `StudioHomePage` would without `allowSignedOutShell` — but home passes `allowSignedOutShell` for the signed-out preview). **`/studio/build` does not**, so the **anonymous** path is inconsistent with **`/studio`** and with the **inline** signup story in `BuildPage`. OSS (`cloud_mode: false`) avoids this redirect, so behavior **differs by deployment**.  
- **Product lens:** ICP should not need to reason about “OSS vs cloud”; the **paste → hosted** story needs one clear gate.  
- **Files:** `StudioBuildPage.tsx` (adapter does not pass `allowSignedOutShell`), `StudioLayout.tsx`, `BuildPage.tsx` (`handlePublish`, `SignupToPublishModal`, `PENDING_KEY` effects), `useSession.ts` (`isAuthenticated`).

---

## S2 — Major

### M1 — Back link label ignores Studio context

- **What:** The breadcrumb link always reads **“Creator dashboard”** while `backHref` is **`/studio`** on this route (`BuildPage.tsx`).  
- **Why:** Signed-in Studio users see **wrong mental model** (creator store vs Studio workspace).  
- **Fix:** Parameterize label (`backLabel`) or branch on `backHref` / presence of `postPublishHref`.

### M2 — Signup / sign-in `next` uses `/build`, not `/studio/build`

- **What:** `SignupToPublishModal` navigates to `'/signup?next=' + encodeURIComponent('/build')` and `'/login?next=' + encodeURIComponent('/build')`.  
- **Why:** **`/build`** redirects to **`/studio/build`** (`main.tsx`), so return URL may still land correctly, but **`LoginPage`** only treats **`nextPath.startsWith('/studio/build')`** as “saved draft” for UI (`hasSavedDraft`). With `next=/build`, the **draft reassurance** on login may not show even when `floom:pending-publish` exists.  
- **Fix:** Pass **`/studio/build`** (or `location.pathname + search`) into modal handlers — likely requires a new optional prop on `BuildPage` parallel to `postPublishHref`.

### M3 — “Publish / review complexity vs promise” (launch audit C2, reinforced here)

- **What:** Single screen combines **two ramps**, **review** with long operation lists (up to 20 + overflow), **metadata**, **visibility**, **slug collision** pills, **custom renderer** on success.  
- **Why:** Same as `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` C2 — reads as **power tool**, not **30-second** flow; competes with hero/Studio copy.  
- **File:** `BuildPage.tsx` (scope is route-local but product decision).

### M4 — No in-flight state for Detect / Find it / hero auto-detect

- **What:** `runGithubDetect` / `runOpenapiDetect` have **no** `isDetecting` UI; buttons are not disabled during async work; hero `useEffect` auto-runs detect without a **ramp-level** spinner.  
- **Why:** Double submits, unclear wait, **§4** loading states and **§10** performance perception.  
- **Fix:** Disable primary actions + “Detecting…” inline state until settle.

---

## S3 — Minor

### m1 — Step indicator semantics

- **What:** When `step !== 'ramp'`, pills show **1. Find your app** (done), **2. Review**, **3. Publish**. On **`review`**, step 3 is not **active** until `publishing`.  
- **Why:** Mostly correct; some users may read **3. Publish** as “you are publishing now” while still editing.  
- **Fix:** Rename to **3. Go live** or only show three pills after review submitted.

### m2 — `VisibilityChooser` vs `auth-required` state

- **What:** `VisibilityChooser` maps `visibility === 'auth-required'` to **`public`** for display (`value={visibility === 'auth-required' ? 'public' : visibility}`). If `PendingPublish` ever restores **`auth-required`**, the **radio UI can misrepresent** stored state until changed.  
- **Why:** Rare edge case; still a **truthfulness** bug for advanced manifests.

### m3 — Primary ramp promises vs `PRODUCT.md` default path

- **What:** GitHub ramp is **OpenAPI-in-repo** discovery (`openapi.yaml` candidates on `main`/`master`), not **repo → hosted runtime** (path 1 in `PRODUCT.md`). Copy says “Floom reads it and turns it into a live app” — accurate for **wrapped/proxied** ingest, not **running user code**.  
- **Why:** ICP confusion if they expect **container/runner** hosting from this screen alone.

### m4 — Touch targets and responsive layout (code review)

- **What:** Inline styles use compact padding; **Detect** / **Find it** buttons may fall **below 44px** height; two-column visibility grid may be tight on narrow viewports.  
- **Why:** Checklist **§7 Mobile** — should be verified in device preview.

### m5 — `edit=` query path

- **What:** `?edit=slug` pre-fills name/slug/description/category but leaves **`step` on `ramp`** (`setStep('ramp')`). User must still pick a ramp to “re-detect” for publishing — **edit** is partial.  
- **Why:** May confuse creators expecting **edit listing only** without re-import.

---

## S4 — Cosmetic

- **GitHub ramp:** “30 seconds” badge is **aspirational**; network variance makes it feel marketing-heavy if detect fails.  
- **Done step:** Green success panel + `CustomRendererPanel` is a **strong** post-publish upsell — good **delight** if discoverable; dense for tired users.

---

## Checklist coverage (abbrev.)

| Section | Pass / partial / gap | Notes |
|---------|----------------------|--------|
| 1 First impressions | Partial | Clear H1 + primary GitHub ramp; Studio-specific back label wrong. |
| 2 Information hierarchy | Partial | GitHub primary + OpenAPI secondary + collapsed “More ways” works; review step busy. |
| 3 Navigation & wayfinding | Gap | “Creator dashboard” on Studio; `postPublishHref` improves success exit. |
| 4 Interaction | Gap | Missing detect loading; publishing step minimal text-only. |
| 5 Content & copy | Partial | Errors taxonomy-aware for OpenAPI; GitHub `no-openapi` vs `private` not distinguished (code comment acknowledges). |
| 6 Visual design | Pass | Accent discipline noted in `StepBadge` comment; cards consistent. |
| 7 Mobile | Partial | Not validated live; flex + grids need QA. |
| 8 Edge cases | Partial | Slug 409 + suggestions strong; private mode clipboard fail silent. |
| 9 Accessibility | Partial | Modals have `role="dialog"` + Escape; summary/details for paths; some icons `aria-hidden`. |
| 10 Performance perception | Gap | No skeleton on detect; hero auto-detect jumps. |

**Cross-screen:** Success path aligns with **three surfaces** via permalink + Studio management; **consistency** hurt by Studio vs store **shell** and **signup `next`** mismatch.

---

## Positive signals (delight / trust)

- **`ingest_url` / `openapi` query** + **hero auto-detect** closes the **blank form** gap after marketing paste.  
- **`floom:pending-publish`** + review hydration is the **right pattern** for resume-after-auth **when** the page is reachable unsigned.  
- **409 `slug_taken`** with **clickable suggestions** and **immediate retry** (`handleApplySlugSuggestion`) is strong **error recovery**.  
- **ShareableUrl** full origin + copy on **done** fixes non-shareable relative paths.  
- **Default visibility public** (#129) matches “share the link” success copy.

---

## Files referenced

- `apps/web/src/pages/StudioBuildPage.tsx`  
- `apps/web/src/pages/BuildPage.tsx`  
- `apps/web/src/components/studio/StudioLayout.tsx`  
- `apps/web/src/main.tsx` (`/build` → `/studio/build`)  
- `apps/web/src/pages/LoginPage.tsx` (`hasSavedDraft` + `next`)  
- `docs/PRODUCT.md`  
- `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` (C2)
