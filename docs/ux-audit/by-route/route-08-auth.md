# Per-route UX audit — `/login`, `/signup` (`LoginPage`)

**Date:** 2026-04-20  
**Routes:** `/login`, `/signup` (same component; mode from pathname + query)  
**Component:** `apps/web/src/pages/LoginPage.tsx`  
**Mode:** Code-first UX / product review  
**ICP lens:** `docs/PRODUCT.md` (non-developer AI engineer; primary path *paste repo → hosted*; three surfaces web + MCP + HTTP; cloud sign-in is part of “managed” creator story, OSS stays frictionless for demos)  
**Checklist:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`

---

## Summary

| Level | Count | Notes |
|------:|------:|-------|
| **S1** Critical | 0 | — |
| **S2** Major | 2 | Return URL dropped from global “Sign in”; possible mis-read of OSS vs cloud while session loads |
| **S3** Minor | 5 | URL vs tab state, mobile value pitch removed, forgot-password is mailto, `next` not surfaced, checklist gaps |
| **S4** Cosmetic | 1 | Tab pattern vs full tabpanel semantics |

**Automated screenshots:** Not run in this revision. Prefer Playwright at 390×844 and 1280×720 for `data-testid="login-page"` / `signup-page` with variants: cloud + OAuth on, cloud email-only, OSS (`cloud_mode: false`), and error states after forced 401.

---

## Scope — route wiring

| Route | `main.tsx` | Initial mode (`getModeFromLocation`) |
|-------|------------|--------------------------------------|
| `/login` | `<Route path="/login" element={<LoginPage />} />` | `signin`, unless `?mode=signup` |
| `/signup` | `<Route path="/signup" element={<LoginPage />} />` | `signup` |

Callers append `next` for post-auth navigation (examples: `PageShell` cloud gate, `BuildPage` signup modal, `TopBar` publish CTA → `/signup?next=%2Fstudio%2Fbuild`, `CreatorHeroPage` → `/signup?next=…/studio/build`).

---

## Checklist walkthrough (both routes)

### 1. First impressions (5-second test)

- **Purpose:** Clear — centered hero (“Welcome to Floom” / “Create your Floom account”), tabs, form or OAuth stack.
- **Primary action:** Single green submit (`--accent`) or OAuth row when enabled; hierarchy matches launch audit direction (primary CTA consistency).
- **Attention:** Logo + headline center mass; right-column pitch on desktop reinforces ICP (“paste link”, agents, OSS vs cloud) — **absent on narrow viewports** (see S3).
- **Finished vs WIP:** Reads intentional (comments + `Logo` `animate="boot-in"`), not placeholder.

### 2. Information hierarchy

- **Strong:** Tab control above method choice; OAuth above email when providers exist; divider “or continue with email”.
- **Subordinate:** Footer swap line (“Don’t have an account?”) below primary submit.
- **Risk:** Multiple banners can stack (draft resume + OSS + error) — vertical scan order gets busy before the first field.

### 3. Navigation & wayfinding

- **Where am I:** Document title switches (`Sign in · Floom` / `Create account · Floom`); `TopBar` treats both paths as “login page” (hides duplicate Sign in link).
- **URL vs UI:** Pathname `/signup` forces signup mode from server; user can switch tab to **Sign in** without changing URL — support/analytics see “signup” while user reads sign-in (see S3).
- **Deep link:** `?mode=signup` on `/login` activates signup; there is no symmetric `?mode=signin` override for `/signup`.

### 4. Interaction design

- **Forms:** Labels + placeholders; `required`, `minLength={8}`, sensible `autoComplete` (`email`, `current-password` / `new-password`, `name` on signup).
- **Loading:** Submit disables with “Working…” and reduced opacity — clear.
- **Tabs:** `role="tablist"` / `role="tab"` + `aria-selected`; no `tabpanel` / roving `tabIndex` pattern — keyboard semantics incomplete (see S4).

### 5. Content & copy

- **Signup subhead** (“One account. Run apps…”) aligns with hub + creator positioning.
- **Value column** bullets echo `PRODUCT.md` themes (surfaces, OSS vs cloud) — desktop only.
- **OSS banner** explains local browsing and offers **Continue as local** → `next` — good escape hatch for self-hosters.

### 6. Visual design

- **Palette:** Mostly CSS vars; banners use fixed greens/ambers — consistent with pragmatic alert styling elsewhere.
- **OAuth:** Neutral outlined buttons + real GitHub/Google SVGs (explicitly avoids “monogram slop”) — **trust-positive**.

### 7. Mobile experience (`globals.css` ≤1023px)

- **Layout:** `.login-grid` collapses to one column, `max-width: 440px`.
- **Value pitch:** `.login-right { display: none }` — mobile users lose the three proof points and “Built for creators…” tag; auth feels **form-only**, weaker for cold ICP.
- **Touch:** Tab buttons and OAuth rows are full-width with comfortable padding; primary button full width.

### 8. Edge cases & error states

- **Already authenticated:** `useEffect` → `navigate(nextPath, { replace: true })` when `isAuthenticated` — avoids redundant auth.
- **Session fetch failure / still loading:** `cloudMode = data?.cloud_mode === true` is **false** when `data` is null — before `/api/session/me` resolves, UI can briefly resemble **OSS** (yellow banner + no OAuth) even on cloud — **trust glitch** (see S2).
- **`next` oddities:** No UI shows where the user will land after success; external or malformed `next` values are not normalized in this file (product/security review separate from layout).

### 9. Accessibility basics

- **Labels:** Proper `htmlFor` / `id` wiring on inputs.
- **Tabs:** Partial pattern (see §4); bottom “Create account / Sign in” uses `<button>` inside paragraph — OK, but easy to miss vs tabs.
- **Focus:** No documented focus move to error region on submit failure.

### 10. Performance perception

- **Lazy route:** `LoginPage` is lazy in `main.tsx` — expect brief shell; consistent with other pages.

---

## Focus areas (as requested)

### Return URL (`next`)

- **Source:** `const nextPath = searchParams.get('next') || '/me'` (`LoginPage.tsx`).
- **Used for:** Post-password `navigate`; post-session `useEffect` redirect when already authed; OAuth `callbackURL` (`api.socialSignInUrl(provider, nextPath)`); OSS **Continue as local** `Link`; draft resume banner gate (`nextPath.startsWith('/studio/build')` + `localStorage` `floom:pending-publish`).
- **Default:** `/me` — reasonable hub after auth; may not match “I came from Studio” mental model unless callers passed `next` (many do).
- **Gap — global Sign in:** `TopBar` links to **`/login` without `next`** (`apps/web/src/components/TopBar.tsx`). Users bounced from a deep page who then use the bar lose their return path; aligns with launch doc **M5** (return URL / studio friction) at the **chrome** layer, not inside `LoginPage`.
- **Product note:** This file does not display “After sign-in you’ll return to …” — reduces confidence for long `next` URLs (studio build, publish flow).

### Friction

- **Single page for sign-in + sign-up:** Low friction for switching intent; tab + bottom toggle duplicate the same mental affordance (minor redundancy).
- **Signup fields:** Email + password + optional display name only — low field count (good for ICP).
- **Forgot password:** `mailto:team@floom.dev?subject=Password%20reset` — **human-mediated**, not self-serve reset in product; acceptable early-stage but high friction if volume grows.
- **OSS path:** No email/password submit in practice when Better Auth 404s — message steers to `FLOOM_CLOUD_MODE` or local user; **Continue as local** preserves intent when `next` is set.

### Trust signals

- **OAuth only when configured:** Buttons gated on `data?.auth_providers.{google,github}` — avoids dead social buttons (**explicitly called out in file comments as trust**).
- **OSS honesty:** Yellow banner states open-source mode and what works — matches `PRODUCT.md` host vs user distinction.
- **Draft resume:** Green banner when a pending publish draft exists and `next` targets studio build — signals “we didn’t lose your work.”
- **Legal / privacy:** `PageShell` still renders `Footer` — users can reach policies from auth (good baseline trust).
- **Gap:** No inline “We never see your GitHub tokens” / data-processing line on OAuth row — optional microcopy for enterprise-sensitive users (not required for ICP minimum).

### Errors

- **Mapping** (`handlePasswordSubmit` catch): `404` → cloud auth disabled + dev hint; `401` → “Wrong email or password.”; `422`/`400` → `e.message` or generic invalid; else `e.message` or “Sign-in failed.”
- **Presentation:** Single `auth-error` paragraph, amber-ish text — visible, not mistaken for success.
- **Limits:** No per-field server errors (e.g. “email taken” vs generic 422 message); no explicit “network offline” branch; successful path resets message only implicitly on next submit (clears at submit start).
- **OAuth errors:** Not handled on this page (return happens via Better Auth redirect chain — out of scope for this component audit).

---

## Findings

### S2 — Major

#### M1 — TopBar “Sign in” drops `next` (return URL)

- **Severity:** S2  
- **Category:** Navigation / friction (launch audit M5 family)  
- **What:** `TopBar` renders `<Link to="/login">` without appending `encodeURIComponent(location.pathname + location.search)`. Users who self-navigate to Sign in lose the deep return path `LoginPage` would honor.  
- **Why it matters:** ICP often arrives from Studio/publish flows; losing `next` forces manual wayfinding back to `/studio/build` or `/build`.  
- **Fix (product):** Mirror `PageShell` pattern: `/login?next=` + current path (and preserve query).  
- **Files:** `TopBar.tsx` (link), compare `PageShell.tsx` / `MePage.tsx` / `StudioLayout.tsx`.

#### M2 — “OSS mode” banner can appear until `cloud_mode` is known

- **Severity:** S2  
- **Category:** Trust / error states  
- **What:** `cloudMode` is `data?.cloud_mode === true`. While `data` is still `null` (initial session fetch), `cloudMode` is false, so the yellow **open-source mode** banner and missing OAuth stack can render transiently on a **cloud** deployment.  
- **Why it matters:** First impression reads “this isn’t the real product” for a fraction of a second — undermines managed-sign-in positioning in `PRODUCT.md`.  
- **Fix:** Treat “session unknown” as a third UI state (skeleton or neutral shell) until `getSessionMe` settles; only then branch OSS vs cloud.  
- **Files:** `LoginPage.tsx`, optionally `useSession.ts` loading contract.

### S3 — Minor

#### m1 — URL and selected mode can disagree

- **What:** On `/signup`, user can select **Sign in** tab; pathname remains `/signup`. Bookmarks, support screenshots, and analytics mislabel the user intent.  
- **Fix:** Push shallow history on tab change (`/login` ↔ `/signup`) or add explicit `?mode=` sync both ways.

#### m2 — Mobile hides entire value proposition column

- **What:** `.login-right { display: none }` below 1024px removes ICP-oriented proof.  
- **Fix:** Collapse to a short accordion or 2-line subhead under the logo on mobile.

#### m3 — Forgot password is mailto, not productized reset

- **What:** No in-app reset flow on `/login`.  
- **Fix:** When Better Auth reset is available again, wire button to `/auth/...` flow; until then, microcopy could set expectation (“We’ll help manually within …”).

#### m4 — No visible confirmation of post-auth destination

- **What:** `next` affects behavior but is never shown in UI.  
- **Fix:** One line: “After sign-in: Studio” (truncate path) for non-default `next`.

#### m5 — Inline validation is submit-only

- **What:** HTML5 `required` / `minLength` only; no async “email format” beyond `type="email"`.  
- **Acceptable** at current scope; note for future if server returns field-scoped errors.

### S4 — Cosmetic

#### c1 — Tablist without tabpanels / roving tabindex

- **What:** Visual tabs use `role="tab"` but content is not wrapped in `role="tabpanel"` with `aria-labelledby`; arrow-key navigation between tabs not implemented.  
- **Fix:** Complete the pattern per WAI-ARIA Authoring Practices or simplify to segmented control semantics (`radiogroup`) if tabs are purely visual.

---

## Alignment with `docs/PRODUCT.md`

| Theme | On this route |
|--------|----------------|
| ICP non-dev | Low field count, plain language, OAuth “continue” wording, OSS escape hatch. |
| Paste repo → hosted | Value column mentions paste link / agents (desktop). |
| Three surfaces | Bullets in right column name Claude tool + page + URL — reinforces promise. |
| OSS vs cloud | OSS banner + `cloud_mode` gating matches “host requirements operator-side; users never install tooling” framing. |

---

## Cross-links

- Launch-level auth friction: `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` **M5** (return URL / studio).  
- Session semantics: `apps/web/src/hooks/useSession.ts` (`isAuthenticated`, OSS `is_local`).
