# Per-route UX audit: `/me/apps/:slug/run`

**Date:** 2026-04-20  
**Component:** `MeAppRunPage` (`apps/web/src/pages/MeAppRunPage.tsx`)  
**Related:** `SecretsRequiredCard`, `RunSurface`, `REQUIRED_SECRETS_OVERRIDE`, routing in `apps/web/src/main.tsx`  
**ICP & pillars:** `docs/PRODUCT.md` (non-developer AI engineer; **three surfaces** — web form `/p/:slug`, MCP, HTTP; **hosting** as core value; secrets injection without “secrets manager” expertise)  
**Checklist source:** `~/.claude/skills/ui-audit/references/ux-review-checklist.md`  
**Launch cross-ref:** `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` (C1, M1, M3, M6)

---

## Route purpose (5-second test)

This is the **authenticated “run my app as owner”** surface: load app + user secret keys → if required keys are missing, block with **SecretsRequiredCard**; otherwise mount **RunSurface** (sync stream vs async job is driven by `app.is_async` inside the runner, not this page). Deep link **`?prompt=`** pre-fills a `prompt` field for composer → run handoff (v15.1). Breadcrumb: `/me` › app name › **Run**.

**Primary action:** save missing credentials (if gated) or **Run / Refine** inside `RunSurface`.

---

## Redirect & shell context (`main.tsx`)

Relevant comments and behavior:

- **v16 Studio restructure (2026-04-18):** `/me/apps/:slug` and `/me/apps/:slug/secrets` use **`StudioSlugRedirect`** → `/studio/:slug` and `/studio/:slug/secrets`. **`MeAppRunPage` is the exception:** it remains mounted at **`/me/apps/:slug/run`** because *“run an owned app” is a `/me` (consumer) action, not a creator management action — the RunSurface lives there, and Studio links into it when needed.*
- **Legacy short URLs:** `/me/a/:slug` → `/me/apps/:slug` (then Studio); `/me/a/:slug/secrets` → secrets chain; `/me/a/:slug/run` → `/me/apps/:slug/run` via `MeAppRunRedirect` (bookmark preservation).

**UX implication:** From this page, **TabBar** and **MeRail** links still target `/me/apps/:slug` and `/me/apps/:slug/secrets`, which **immediately redirect into Studio** (different chrome: `StudioLayout` vs `PageShell` + `MeRail`). That is **intentional routing**, but it is a **context switch** (aligns with launch finding **M3** — legacy vs Studio mental model).

---

## `REQUIRED_SECRETS_OVERRIDE`

For **`ig-nano-scout`**, the manifest’s `secrets_needed` can list optional Instagram cookies next to required ones. The page **replaces** the declared list with a stricter **minimum set** (`IG_SESSIONID`, `IG_CSRFTOKEN`, `IG_DS_USER_ID`, `EVOMI_PROXY_URL`) so users are not forced to paste non-blocking cookies before running. Other slugs use **`app.manifest.secrets_needed`** as-is.

**ICP fit:** Reduces false “hard stop” before run; matches the product story that Floom should not feel like arbitrary gatekeeping.

**Gap (see launch M1):** Required keys are still **not** unioned with **per-action** `manifest.actions[*].secrets_needed` for the default / selected action, so users can pass this gate and still hit **auth errors** in `RunSurface` / `OutputPanel`.

---

## `SecretsRequiredCard` (pre-flight)

- **Copy:** “This app needs credentials to run” / “Paste them once. We’ll remember them for every run.” — plain language, ICP-appropriate.
- **Inputs:** One password field per **missing** key; **HELP** map adds human labels and Instagram/Evomi hints; unknown keys still render with the raw key name.
- **Submit:** POSTs each filled key via `api.setSecret`, per-key errors inline; on success calls `onSaved()` → `secrets.refresh()`.
- **Trust microcopy:** AES-256 / runtime injection / not logged — supports confidence for non-devs.
- **Gaps:** Submitting with **all fields empty** returns early with **no visible error** (user gets no “fill at least one” message). `data-testid` coverage is good for automation.

---

## `RunSurface` (inline runner)

- **v16 one-surface shell:** no chat turns; input card persists; output slot shows streaming logs, `JobProgress` (async), renderer cascade, errors; **Refine** loop when refinable; past runs in `<details>`; honors `?action=` for multi-action apps; responsive **2-col vs stacked** at 1024px; creator `render_hint === 'stacked'` can force single column.
- **Not owned by this page:** Hydration via `initialRun` is for **public** permalink flows; `MeAppRunPage` only passes `initialInputs` from `?prompt=`.

---

## Checklist pass (condensed)

| Section | Notes |
|--------|--------|
| **1. First impressions** | Clear if user reads breadcrumb + header; “Run” is explicit. Tab row still highlights **Overview**, not Run — undermines “where am I?” (see findings). |
| **2. Hierarchy** | App header + tabs + main content read top-down; error banner (red) is visible. |
| **3. Wayfinding** | Breadcrumb to `/me` and app name works; app name link goes to `/me/apps/:slug` → **Studio** (not v15 “me app overview”). **MeRail** app rows also navigate to that redirect. **TabBar `active="overview"`** on the Run route is **incorrect** for wayfinding. |
| **4. Interaction** | Run flow is async-aware inside `RunSurface`. Secrets form: inline errors on failure; empty submit needs feedback. |
| **5. Copy** | “Credentials” in card vs “Secrets” in tab label — cross-screen vocabulary split (launch doc: Consistency). |
| **6. Visual** | Inline styles align with other `/me` app pages; warning icon on credentials card is clear. |
| **7. Mobile** | `MeRail` hidden &lt;720px per `globals.css` / rail comment — Run still usable via main column; `RunSurface` stacks on narrow viewports. |
| **8. Edge cases** | 404 → `replace` navigate to `/me` (no `notice` query, unlike some other flows). If **`useSecrets` fails** (`entries` stays `null` with `error` set), `missingKeys` stays `null` and the page can show **“Loading…”** indefinitely — no error surfacing in `MeAppRunPage`. |
| **9. a11y** | Breadcrumb `nav` with `aria-label="Breadcrumb"`; secrets form has labels + `htmlFor`; TabBar uses `role="tablist"`. |
| **10. Performance** | `MeAppRunPage` is **lazy** in `main.tsx`; code-split with route. |

---

## Findings (severity)

| ID | Sev | Issue | Why it matters | Suggested direction |
|----|-----|--------|----------------|---------------------|
| R12-1 | **S2** | **`TabBar active="overview"`** on a dedicated **Run** URL | “Overview” reads selected while the user is on **Run**; `aria-selected` is wrong for screen readers. | Add a **Run** tab, or remove/hide tabs on this route, or pass an active state that matches “Run” and link Overview/Secrets to **`/studio/...`** explicitly if that is the canonical shell. |
| R12-2 | **S2** | **Pre-flight `missingKeys`** ignores per-action `secrets_needed` | Same as launch **M1**: user reaches `RunSurface` then fails with **auth_error** / secrets guidance mismatch (**C1**). | Union manifest-level and default (or selected) action required keys before showing the card. |
| R12-3 | **S2** | **Secrets list fetch error** not handled on this page | Stuck on “Loading…” if `listSecrets` fails. | Show error + retry; optionally allow run if policy allows (product call). |
| R12-4 | **S3** | **Studio redirect** from TabBar / rail / breadcrumb app link | User leaves light `/me` chrome for **Studio** without on-page explanation. | Optional one-line cue: “App settings open in Studio” on first navigation, or align copy in TabBar targets. |
| R12-5 | **S3** | **Empty submit** on `SecretsRequiredCard` | No validation message when zero fields filled. | Inline: “Enter at least one value to continue.” |
| R12-6 | **S4** | 404 from `getApp` → **`/me`** silent | Slightly confusing vs flows that add `?notice=`. | Optional `?notice=app_not_found` for parity. |

---

## Weighted scorecard (1–10)

*Flaws above applied before scoring.*

| Dimension | Weight | Score | Note |
|-----------|--------|------:|------|
| Clarity | 25% | 6 | Breadcrumb + Run surface clear; tab active state and Studio hop hurt “where am I?”. |
| Efficiency | 20% | 7 | Override + preflight save time for ig-nano-scout; per-action gap can waste a run. |
| Consistency | 15% | 5 | Me vs Studio split + “Overview” tab on Run; Credentials vs Secrets wording. |
| Error handling | 15% | 5 | API error banner OK; secrets load failure stuck loading; empty credentials submit. |
| Mobile | 15% | 7 | RunSurface responsive; rail hidden on small screens is acceptable if TopBar/hamburger cover nav. |
| Delight | 10% | 6 | `?prompt=` prefill and trust copy on secrets are nice touches. |

**Overall (weighted):** **6.0 / 10**

---

## Files referenced

- `apps/web/src/pages/MeAppRunPage.tsx` — page shell, gating, `REQUIRED_SECRETS_OVERRIDE`, `?prompt=`
- `apps/web/src/components/me/SecretsRequiredCard.tsx` — credentials pre-flight
- `apps/web/src/components/runner/RunSurface.tsx` — run UI
- `apps/web/src/pages/MeAppPage.tsx` — `AppHeader`, `TabBar`
- `apps/web/src/main.tsx` — Studio redirects vs `MeAppRunPage` exception, legacy `/me/a/.../run`
- `apps/web/src/hooks/useSecrets.ts` — global secrets cache
- `docs/PRODUCT.md` — ICP, three surfaces, secret injection story
