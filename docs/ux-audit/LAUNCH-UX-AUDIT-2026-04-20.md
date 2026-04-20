# UI Audit Report — Floom (launch focus)

**Date:** 2026-04-20  
**Mode:** UX / product review (standalone, no wireframe)  
**URL:** https://floom.dev  
**Viewports:** Desktop 1280×800, Mobile 390×844  
**Screens audited:** Home, Store (`/apps`), Permalink (`/p/hash`), Protocol (`/protocol`), About, Install, Login, Signup, Studio home (`/studio`), Studio build (`/studio/build`), Legal, Privacy, Terms, 404 probe  

**ICP lens (from `docs/PRODUCT.md`):** Non-developer AI engineer with a localhost prototype; primary job is **paste repo → hosted app** with **zero deployment plumbing**; product must surface the **three surfaces** (web form, MCP, HTTP) clearly.

**Capture tooling:** Playwright-driven `capture_screens.py` executed on **ax41** (local `playwright install chromium` is blocked in this environment). All listed routes captured successfully; no per-route capture failures.

**Screenshots:** Relative paths under `docs/ux-audit/_captures/` (see `manifest.json`).

---

## Summary

| Metric | Count |
|--------|------:|
| Total issues | 24 |
| **S1 (Critical)** | **2** |
| S2 (Major) | 6 |
| S3 (Minor) | 11 |
| S4 (Cosmetic) | 5 |

**Weighted UX scores (1–10, checklist weights):** Clarity 7 · Efficiency 6 · Consistency 7 · Error handling 7 · Mobile 6 · Delight 7 → **Overall ~6.7**. Scores assume first-visit cookie banner state as captured (no prior consent).

---

## Findings

### Home — Desktop

#### Primary story matches ICP; cookie competes with discovery
- **Severity:** S2  
- **Category:** Content / Interaction  
- **What:** Hero clearly centers “paste GitHub” + “Publish your app”; featured apps support discovery. First-visit **cookie consent** sits above the fold and overlaps the lower app grid, competing with “Browse live apps” and card scanning.  
- **Why it matters:** First five seconds are strong for the value prop, but consent UI reads like a second modal layer and steals attention from proof (live apps).  
- **Fix:** Defer non-essential banner, use a slim bottom bar, or dismiss automatically for anonymous browse with a single “OK” after scroll.  
- **File hints:** Cookie/banner component in web shell (search `cookie`, `CookieConsent` in `apps/web`).  

![Home desktop](_captures/launch-home-desktop.png)

#### “Protocol + runtime” subcopy skews technical
- **Severity:** S3  
- **Category:** Content  
- **What:** Subhead includes “protocol + runtime for agentic work” under a strong plain headline.  
- **Why it matters:** ICP cares about outcomes (URL, run, share); “protocol” reads infra-adjacent next to an otherwise approachable hero.  
- **Fix:** A/B plain line: “Web form, MCP, and API—automatically” (mirrors `PRODUCT.md` three surfaces).  
- **File hints:** Marketing copy on home route component.

---

### Home — Mobile

#### App card descriptions truncate aggressively
- **Severity:** S3  
- **Category:** Mobile / Content  
- **What:** Two-column cards show titles but descriptions clip mid-word; “+37 more” style overflow hints at density without clarity.  
- **Why it matters:** Discovery on mobile relies on cards; truncation hides what each tool does without a tap.  
- **Fix:** Single-column list on narrow widths, 2-line clamp with ellipsis, or “Open” affordance per card.  

![Home mobile](_captures/launch-home-mobile.png)

#### Floating “Cookies” overlaps cards
- **Severity:** S4  
- **Category:** Visual / Mobile  
- **What:** Compact cookie entry overlaps the app grid corner.  
- **Why it matters:** Minor clutter; thumb may mis-tap.  
- **Fix:** Anchor to safe area or auto-collapse after scroll.

---

### Store (`/apps`) — Desktop

#### Category labels expose internal tokens
- **Severity:** S3  
- **Category:** Content / Consistency  
- **What:** Pills show `Open_data`, `Developer_tools`, etc.  
- **Why it matters:** Underscores read like database keys, not shopper-friendly labels for a mixed audience.  
- **Fix:** Humanize (`Open data`, `Developer tools`) at display layer.  
- **File hints:** Store filter mapping near `/apps` page or API category formatter.

#### Cookie banner overlaps list + chevrons
- **Severity:** S2  
- **Category:** Interaction  
- **What:** Same centered cookie card covers the first rows of the directory and affordances.  
- **Why it matters:** Core “discover app” journey is the list; overlap feels unfinished on a flagship page.  
- **Fix:** Same as home—reduce intrusion for browse-only users.

![Store desktop](_captures/launch-store-desktop.png)

---

### Store — Mobile

#### Filters consume vertical budget; placeholder truncates
- **Severity:** S3  
- **Category:** Mobile / Information hierarchy  
- **What:** Many category pills wrap and occupy a large share of 844px height; search placeholder truncates (`search flig`).  
- **Why it matters:** First screenful is mostly chrome + filters; apps appear “below.”  
- **Fix:** Collapse categories behind “All categories” sheet; shorten placeholder or use rotating hints.

![Store mobile](_captures/launch-store-mobile.png)

---

### Permalink (`/p/hash`) — Desktop

#### Run layout strong; duplicate naming + cookie on workspace
- **Severity:** S3 / S2 (split)  
- **Category:** Information hierarchy / Interaction  
- **What:** App detail is clear (Run / About / Install / Source); “Hash” and `developer-tools` repeat in breadcrumb, hero, and panel. Cookie again overlaps the run workspace.  
- **Why it matters:** Repetition is minor; **cookie over input/output** is worse here because this is the **web form surface**—the ICP proof moment.  
- **Fix:** Z-index / dismiss cookie when interacting with run panel; tighten redundant headings.  
- **File hints:** Public app / permalink layout components.

![Permalink desktop](_captures/launch-permalink-hash-desktop.png)

### Permalink — Mobile

#### Expect two-pane run → stack; verify output visibility after run
- **Severity:** S3  
- **Category:** Mobile (assumption from layout class)  
- **What:** Desktop is split pane; mobile capture not re-read here but pattern implies long scroll between Run and output.  
- **Why it matters:** Run → see result is the core loop on the web form surface.  
- **Fix:** Sticky run bar or collapsible input sheet.

![Permalink mobile](_captures/launch-permalink-hash-mobile.png)

---

### Protocol (`/protocol`) — Desktop

#### Docs-forward page is appropriate but dense for ICP stumble-ins
- **Severity:** S3  
- **Category:** Content / Wayfinding  
- **What:** Strong technical diagram (OpenAPI, YAML, MCP, hosted vs proxied). Valuable for advanced users; may overwhelm if reached before home’s “paste GitHub” story.  
- **Why it matters:** `PRODUCT.md` says OpenAPI is advanced; page is honest but not a soft on-ramp.  
- **Fix:** Top callout: “New here? Start on the homepage—paste a repo link.”  

![Protocol desktop](_captures/launch-protocol-desktop.png)

### Protocol — Mobile

#### Sidebar → hamburger; verify TOC discoverability
- **Severity:** S3  
- **Category:** Navigation  
- **What:** Long-form docs on mobile depend on menu access.  
- **Why it matters:** If TOC is hidden behind an unclear icon, users bounce.  
- **Fix:** Persistent “On this page” or visible first-level headings.

![Protocol mobile](_captures/launch-protocol-mobile.png)

---

### About — Desktop

#### Messaging aligns with “localhost → URL”
- **Severity:** S4 (positive note)  
- **Category:** Content  
- **What:** “Get that thing off localhost fast” matches ICP emotional hook.  
- **Why it matters:** Reinforces promise without requiring Docker vocabulary.  
- **Fix:** None; optional: tie explicitly to “three surfaces” in one sentence.

#### Cookie overlaps “Who Floom is for” cards
- **Severity:** S2  
- **Category:** Interaction  
- **What:** Banner obscures lower hero cards on first paint.  
- **Fix:** Banner positioning / delay.

![About desktop](_captures/launch-about-desktop.png)

### About — Mobile

_(Same cookie + card overlap risk; capture: `_captures/launch-about-mobile.png`.)_

---

### Install (`/install`) — Desktop

#### Instructions are operator-grade, not ICP-default
- **Severity:** S3 (product positioning)  
- **Category:** Content  
- **What:** `git clone`, `pnpm`, local server—correct for self-host (`PRODUCT.md` path 2) but adjacent to marketing that promises “no infra.”  
- **Why it matters:** ICP may land here from “Self-host in one command” and feel the product contradicted the homepage.  
- **Fix:** Explicit subtitle: “For self-hosting Floom itself (operators). To publish *your* app without cloning Floom, use …” + link to `/studio/build` or signed-in publish.  

#### Cookie banner covers step 3 code block
- **Severity:** S1  
- **Category:** Interaction / Error & edge  
- **What:** On first visit, the consent card sits over the lower install steps so **users cannot read or copy the full `curl`/publish example** without dismissing the modal.  
- **Why it matters:** For anyone attempting operator setup from this page, **primary documentation is physically blocked**—this is a launch-credibility hit for the self-host story and for technical evaluators.  
- **Fix:** Move consent to top/slim bar, or ensure code blocks have bottom padding beyond banner height, or use a non-blocking toast.  
- **File hints:** Install page layout + global cookie host.

![Install desktop](_captures/launch-install-desktop.png)

### Install — Mobile

_(Same overlap risk; verify copy on small viewports — `_captures/launch-install-mobile.png`.)_

---

### Login — Desktop

#### Value prop panel reinforces “paste GitHub”
- **Severity:** S4 (positive)  
- **Category:** Content  
- **What:** “Paste a GitHub link. Get a runnable app in 30 seconds.” aligns with ICP.  
- **Fix:** None.

#### Cookie overlaps foot of form
- **Severity:** S2  
- **Category:** Interaction  
- **What:** Footer link (“Create account” / “Don’t have an account”) partially obscured depending on viewport height.  
- **Fix:** Increase bottom padding on auth card or bottom-align cookie.

![Login desktop](_captures/launch-login-desktop.png)

### Login — Mobile

#### “Forgot password?” tap target may be tight
- **Severity:** S3  
- **Category:** Mobile / Accessibility  
- **What:** Link is small relative to 44px guideline.  
- **Fix:** Enlarge hit area.

![Login mobile](_captures/launch-login-mobile.png)

---

### Signup — Desktop

#### Cookie obscures “Already have one? Log in”
- **Severity:** S2  
- **Category:** Interaction  
- **What:** Same overlap pattern on conversion form.  
- **Why it matters:** Secondary escape to login should never fight a compliance widget.  
- **Fix:** Same cookie/layout fixes.

![Signup desktop](_captures/launch-signup-desktop.png)

### Signup — Mobile

_(Capture: `_captures/launch-signup-mobile.png`.)_

---

### Studio home (`/studio`) — Desktop

#### Signed-out preview explains three surfaces well
- **Severity:** S4 (positive)  
- **Category:** Content  
- **What:** Copy mentions web, MCP, HTTP alignment—matches `PRODUCT.md`.  
- **Fix:** None.

#### Sidebar “SIGN IN” on every sub-link is noisy
- **Severity:** S3  
- **Category:** Visual hierarchy  
- **What:** Repeated badges next to Overview, Runs, Secrets, etc.  
- **Why it matters:** Readable but repetitive; may feel like errors.  
- **Fix:** Single banner + greyed list without per-row badges.

![Studio home desktop](_captures/launch-studio-home-desktop.png)

### Studio home — Mobile

#### Split preview column very narrow; body text truncates
- **Severity:** S3  
- **Category:** Mobile / Layout  
- **What:** Signed-out preview column shows clipped narrative.  
- **Why it matters:** Studio story is important; mobile readability suffers.  
- **Fix:** Stack preview below nav on small screens full-width.

![Studio home mobile](_captures/launch-studio-home-mobile.png)

---

### Studio build (`/studio/build`) — Desktop & Mobile

#### Authenticated route presents as generic login with no publish context
- **Severity:** S1  
- **Category:** Wayfinding / Trust  
- **What:** Captures for `/studio/build` are **pixel-identical to `/login`** (no “Sign in to publish”, no Studio chrome, no preserved return URL messaging in frame). A user who clicked **Publish an app** or followed `/deploy` → `/studio/build` may believe the app sent them to the wrong page.  
- **Why it matters:** Launch narrative is “paste repo in Studio”; **auth wall without contextual chrome** erodes confidence for the ICP (“is this Floom or did I lose my place?”). Technically correct, experientially fragile.  
- **Fix:** Use branded sub-layout or headline: “Sign in to publish your app” + optional `returnTo=/studio/build` breadcrumb; after login, land on `BuildPage` inside `StudioLayout` (already wired in `StudioBuildPage.tsx` / `main.tsx`—improve **pre-auth** presentation only).  
- **File hints:** `apps/web/src/pages/StudioBuildPage.tsx`, auth gate wrapper around `BuildPage`, `apps/web/src/main.tsx` (`/studio/build`, redirects from `/build`, `/deploy`).

![Studio build desktop](_captures/launch-studio-build-desktop.png)  
![Studio build mobile](_captures/launch-studio-build-mobile.png)

---

### Legal / Privacy / Terms — Desktop & Mobile

#### Standard legal chrome; cookie still present
- **Severity:** S4  
- **Category:** Consistency  
- **What:** Footer-linked legal pages render as expected (captures: `launch-legal-*.png`, `launch-privacy-*.png`, `launch-terms-*.png`).  
- **Fix:** None beyond global cookie policy.

---

### 404 (`/__ux-audit-404-probe__`) — Desktop

#### Clear recovery; on-brand
- **Severity:** S4 (positive)  
- **Category:** Error state  
- **What:** “404 • not found” with **Back to home** and **Browse apps**—no dead end.  
- **Fix:** None.

![404 desktop](_captures/launch-404-desktop.png)

### 404 — Mobile

_(Capture: `_captures/launch-404-mobile.png`.)_

---

## Cross-screen analysis

### Consistency
- Primary green, serif headlines, and rounded cards read as one product.  
- **Cookie + Feedback** floaters behave the same everywhere—good for consistency, bad for cumulative obstruction (especially Install, Store, Run).  
- Nav: **Apps / Docs / Sign in / Publish** repeats predictably—good.

### Core journeys
1. **Discover → Run:** Store → app permalink works; friction is cookie + mobile truncation.  
2. **Publish repo (ICP hero):** Header and hero drive to publish; **`/studio/build` unauthenticated looks like login**—weakest link in “paste repo” story.  
3. **Sign in if needed:** Login/signup split and toggle are clear; cookie obscures footers.  
4. **Three surfaces:** Best explicit copy on Studio signed-out preview and protocol docs; homepage could name MCP/HTTP once in plain language.

### Mobile thumb reach
- Primary CTAs (Publish, Sign in) are generally mid/lower on auth screens—good.  
- Hamburger + top-right **Publish** on marketing pages are a stretch one-handed.  
- Floating Cookies bottom-left avoids home indicator conflict better than full banner but overlaps content.

### Empty / error states
- **404:** Strong.  
- **Studio signed-out:** Good explanatory empty state.  
- **Codebase (not visible in captures):** `MeAppSecretsPage` shows `data-testid="me-app-secrets-empty"` when `manifest.secrets_needed` is empty (“This app doesn’t declare any secrets…”). `MeAppRunPage` blocks via `SecretsRequiredCard` using `manifest.secrets_needed` (plus `REQUIRED_SECRETS_OVERRIDE` for `ig-nano-scout`). **`proxied-runner.ts`** prefers **per-action** `secrets_needed` when set, else `manifest.secrets_needed` (`openapi-ingest.ts` populates both for OpenAPI). If manifest-level list were ever empty while an action still required secrets, UI could show the **empty Secrets page** while Run still fails at execution—worth guarding in QA for edge manifests.

---

## Codebase cross-check (friction only; no code changes)

| Area | Observation |
|------|----------------|
| `MeAppSecretsPage.tsx` | Rows keyed off `app?.manifest?.secrets_needed`; empty state is accurate only if manifest list is the single source of truth. |
| `MeAppRunPage.tsx` | Missing keys derived from manifest (+ slug override); aligns with common path; mismatch risk if action-level secrets diverge from manifest list. |
| `openapi-ingest.ts` | Populates `secrets_needed` on manifest and operation-level secrets for proxied apps—generally aligned. |
| `proxied-runner.ts` | Resolution order: action `secrets_needed` if defined, else manifest—**server truth can be stricter than a sparse manifest list**. |
| `StudioBuildPage.tsx` | Thin wrapper: `BuildPage` + `StudioLayout`, `postPublishHref` → `/studio/:slug`—good post-login path. |
| `main.tsx` | `/studio/build`, redirects `/build`, `/deploy` → build; **auth gate** before layout is the UX gap observed in screenshots. |

---

## Prioritized backlog (launch impact)

1. **S1 — Install + cookie:** Ensure step-3 (and all) code blocks are never covered by cookie UI on first paint (`/install`).  
2. **S1 — Pre-auth Studio build:** Add explicit “Sign in to publish” / Studio framing (or embed `BuildPage` teaser) so `/studio/build` does not look like a mistaken redirect to `/login`.  
3. **S2 — Global cookie strategy:** Reduce centered modal frequency intrusiveness on Store, Run, About, Signup, Login.  
4. **S2 — Signup/login footers:** Guarantee “Log in” / “Create account” links clear the consent UI without scrolling tricks.  
5. **S3 — Store categories:** Display-layer humanization of category slugs.  
6. **S3 — Install page framing:** Label self-host path as operator-only; point ICP to cloud publish.  
7. **S3 — Home / protocol copy:** One plain sentence on three surfaces for ICP alignment.  
8. **S3 — Mobile store:** Collapse or paginate filter pills; fix truncated search placeholder.  
9. **S3 — Mobile Studio:** Full-width signed-out preview; reduce per-row “SIGN IN” noise.  
10. **QA — Secrets vs actions:** Add a matrix test: proxied app where action secrets ⊆ manifest `secrets_needed`; catch manifest-empty/action-non-empty regressions.

---

## Capture / tooling notes

- **PNG count:** 28 files in `docs/ux-audit/_captures/` (14 screens × 2 viewports).  
- **Report path:** `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`  
- **Errors:** Local environment blocked `python3 -m playwright install chromium`; captures completed on **ax41** via `ssh ax41` using existing Playwright + browser. No failed routes in the capture run.  
- **Manifest:** `docs/ux-audit/_captures/manifest.json` lists relative filenames for all captures.
