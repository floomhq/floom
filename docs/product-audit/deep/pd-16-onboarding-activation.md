# pd-16 — Onboarding & activation (deep product audit)

**Lens:** `docs/PRODUCT.md` (ICP must reach “hosted prototype” without infra vocabulary), `docs/ROADMAP.md`. **Primary evidence:** `apps/web/src/pages/MePage.tsx`, `apps/web/src/main.tsx` (`/onboarding` → `/me?welcome=1`), `apps/web/src/lib/onboarding.ts`, `apps/web/src/components/onboarding/Tour.tsx` (if present).

---

## 1. Executive truth table

| Promise (PRODUCT / ROADMAP) | Observed reality | Status |
|-----------------------------|------------------|--------|
| After signup, user knows **next step** toward shipping | `/onboarding` is a **redirect**, not a page; `/me?welcome=1` shows `WelcomeBanner` + first-run cards/tour | **Partial** — depends on tour quality and “publish” vs “run an app” framing |
| ICP activates by **running** or **pasting repo** | `MePage` splits: **no runs** → `FirstRunPublishCard` (tour) if `!hasOnboarded()` else `FirstRunBrowseCard`; “Your apps” = **distinct slugs from run history**, not Studio inventory | **Partial** — “Your apps (0)” does not surface **unpublished** work in Studio; mental model gap for creator |
| Single coherent **activation metric** (e.g. first successful run) | Code tracks runs + `floom_onboarded` localStorage; no visible “step 2 of 3” product narrative in this file alone | **Partial** |

---

## 2. ICP journey (activation) with failure branches

1. **Land `/me?welcome=1` after signup**  
   - **OK:** `WelcomeBanner` + greeting.  
   - **Fail:** Query param lost (bookmark `/me`) → no welcome; user sees empty runs only.

2. **`runs` loading**  
   - **OK:** Wait before auto-tour (`useEffect` waits for `runs !== null`).  
   - **Fail:** `/api/me` slow → prolonged blank; no skeleton distinction between “no runs” and “still loading” in some rows (apps section has loading card).

3. **First-run: `!hasOnboarded()` and zero runs**  
   - **OK:** `FirstRunPublishCard` → opens tour.  
   - **Fail:** User already `hasOnboarded()` but never ran → **Browse** card only; path to **Studio publish** may be one hop too many for ICP.

4. **`usedApps` from run history**  
   - **OK:** Honest “apps you’ve touched.”  
   - **Fail:** Creator published in Studio but never ran from `/me` → **Your apps (0)** feels broken vs expectation “I just shipped.”

5. **Curated hub slice when empty**  
   - **OK:** `getHub().slice(0, CURATED_LIMIT)` on failure sets `[]`.  
   - **Fail:** Same pattern as home — silent empty curation.

---

## 3. Risk register

| ID | Level | Risk |
|----|-------|------|
| O-1 | **P0** | **Studio vs /me split:** “Your apps” ≠ “apps you own” — ICP may think publish failed. |
| O-2 | **P1** | **Welcome param** is easy to lose; no durable “getting started” route. |
| O-3 | **P1** | **Tour** gated on localStorage + run count — incognito / multi-device loses state. |
| O-4 | **P2** | Signed-out preview is strong; cloud `requireAuth` still gates full value — OK but copy must match. |

---

## 4. Open PM questions

1. Should **first published app** (Studio) automatically appear under “Your apps” or a separate “Shipped” strip before first run?
2. Is **activation** defined as first **run**, first **publish**, or first **external HTTP/MCP call**? Pick one and align UI + analytics.
3. Should `/onboarding` become a **real** checklist page (30s) instead of query-param banner?

---

## 5. File anchors

- `apps/web/src/pages/MePage.tsx` — welcome, tour, first-run cards, `usedApps` derivation, comments at ~329–448, ~471–473.  
- `apps/web/src/main.tsx` — `/onboarding` redirect.  
- `apps/web/src/lib/onboarding.ts` — persistence contract for tour.
