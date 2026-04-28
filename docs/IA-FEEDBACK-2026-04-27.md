# Federico's IA feedback — 2026-04-27

Captured from chat. NOT decided yet — this is the discussion backlog.

## 1. Wireframe chrome consistency

> "https://wireframes.floom.dev/v25/app-page-running.html doesnt fit https://wireframes.floom.dev/v25/app-page.html f ex? claude agents were lazy apparently?"
>
> "this was just one example, check v25 wireframes for more stuff, all pages pretty much"

**Observation**: `app-page.html` has full chrome (hero with meta-row pills + Share + Install buttons, tabs, 3-card footer). `app-page-running.html` is thinned (no footer, narrow input column, no app meta-row, no Install in Claude button). Same page, different states should share outer chrome.

**Likely scope**: probably affects the full /p/:slug state family (idle/running/output/rate-limited/error) and may extend to other state-variant families across rounds.

## 2. Mode switcher placement

> "why dont we have studio / run on sidebar left as toggle instead of on top header nav?"

**Current**: TopBar center nav `Run | Studio` per L1 Q-B B2.
**Proposed**: Run/Studio as a left-rail toggle (mode switcher).

Implication: rail becomes mode-aware. TopBar simplifies. Mobile drawer also reshapes.

## 3. Landing → dashboard transition

> "i feel like transition landing page vs dashboard we havent cracked yet"

**Open**: how the user gets from public marketing chrome (TopBar Apps/Docs/Pricing) into authenticated workspace chrome. Today it's a hard cut at sign-in. May want a smoother transition.

## 4. Workspace name as click target

> "workspace settings should open when i click the workspace name? to reduce bloat on left side?"

**Current**: Workspace settings is a rail GROUP with 3 items (BYOK keys / Agent tokens / Studio settings).
**Proposed**: Click workspace name in identity block → opens workspace settings menu (modal/popover). Removes the group from the rail.

Reduces rail bloat. Discoverability question: do users know to click the workspace name?

## 5. Profile placement

> "same for profile, which is already at top right?"

**Current**: TopBar avatar dropdown (top-right). Account settings inside.
**Proposed**: stay there. No duplicate in left rail.

## 6. DRY check on UI code

> "and codex shall review how DRY the code is for the ui? seems like not much tbh"

**Open**: codex audit of how much UI code is repeated across Run/Studio/Settings shells, page modules, etc. Refactor into shared components.

## 7. Missing app store link on /run

> "and where is the link to the app store on run page?"

**Observation**: /run dashboard has no visible "Browse the store →" link. Currently you can only get to /apps from /me/apps cross-link or TopBar (which is going away).

## 8. App-level workspace BYOK connection

> "yes, BYOK keys are on workspace level, but on app level i should be able to connect them from workspace? so secrets tab on app is required?"

**Current** (Q-D D1): App creator secrets in Studio per-app are SEPARATE from workspace BYOK keys.
**Proposed**: Keep per-app App creator secrets tab, BUT also allow per-app to wire workspace BYOK keys to the app (creator says "this app uses GEMINI_API_KEY from workspace BYOK").

Implication: Studio app secrets page has TWO sections — App creator secrets (publisher-controlled) + Workspace BYOK key requirements (which workspace BYOK keys this app expects from runners).

## 9. Hierarchy lock

> "but yes, hierarchy is workspace, then run vs studio, then overview, apps, runs/logs"

Confirmed: Workspace > (Run | Studio) > (Overview | Apps | Runs/Logs)

But also:

> "overview pages on studio and run still can be improved but honestly we can also remove for now? apps + runs enough?"

**Open**: drop `/run` and `/studio` overview pages? Just have `/run/apps`, `/run/runs`, `/studio/apps`, `/studio/runs`?

Pro: simpler IA. Con: no landing-after-login dashboard with hero metric / activity / running-now.

## 10. TopBar layout

> "and on header nav profile right, floom logo left to get me home"

Confirmed: floom logo top-left → landing. Profile top-right. (No change.)

> "dont know yet where to link the landing page"

If logged in, "/" goes to /run dashboard; if logged out, "/" is landing. Logo always → "/" but route-aware.

> "and dont know yet where to link docs etc - probably on left sidebar? + the claude setup button? or keep next to fede not sure"

**Open**: docs / Claude install button — left rail? TopBar? avatar dropdown?

---

## What's actually ready right now (honest status)

### Backend
- ✅ Code: schema migration, workspace_secrets, agent token cutover, MCP run insert fix, route shims, canonical /api/workspaces/:id/* aliases
- ✅ Tests: workspace-secrets (12), agent-tokens-workspace (14), mcp-run-parity (12), redirects (27), routes (26) — all pass
- ❌ Stale test fixture: `test-byok-gate.mjs` references old demo slugs (lead-scorer/competitor-analyzer/resume-screener) — gate code is correct, test is stale, CI would block. Easy fix.
- ❌ Federico-only verifications still pending:
  - Real OAuth callback (Google/GitHub) on prod credentials
  - Real Resend email delivery
  - Migration dry-run on a copy of prod DB

**Verdict**: backend is **code-ready, not prod-verified**. The 3 Federico-only items are blockers for promoting prod.

### Wireframes (v25)
- 52 files with codex-audit scores 9.0+
- BUT: chrome consistency issues (app-page family, possibly more)
- BUT: IA itself may shift per your feedback above (Run/Studio toggle, workspace-name click, drop overviews, etc.)

**Verdict**: launch-ready in v25 form, but you've flagged a v26 reshape worth doing.

### React
- ✅ Routes wired (/run, /settings/*, /studio/*, /account/settings, /me/* redirects)
- ✅ Shell components built (RunRail/StudioRail/SettingsRail/WorkspaceIdentityBlock/MobileDrawer)
- ✅ 46 page modules updated by codex
- ❌ Real bugs from claude code-audit:
  - Server test failure (stale fixture, easy fix)
  - MeInstallPage MCP JSON key not slugified (workspace names with spaces break)
  - StudioSidebar links to /me/settings instead of /settings/studio (subtab+hash drops on redirect)
- ❌ ~18 hardcoded /me/* links across pages (work via redirect but flash on click)
- ❌ ICP not screenshot-verified end-to-end on auth pages

**Verdict**: code-running but lots of polish + 3 real bugs to land before launch.

---

## Decision points for Federico

**A. Wireframes — patch v25 or rebuild v26?**
- Patch v25: fix chrome consistency, add app store link to /run, fix the 8 app-page states. ~3-4h. Same IA.
- Build v26: re-IA per your feedback (sidebar toggle, click-workspace-for-settings, drop overviews, etc.). ~6-10h. Risk: Tuesday launch slips.

**B. React — finish v25 or wait for v26?**
- Finish v25: fix the 3 bugs + the 18 hardcoded /me/* + ICP screenshots + DRY refactor. ~4-5h.
- Wait for v26: don't waste effort if IA shifts.

**C. Tuesday launch priority**
- Ship v25 + 3 bug fixes + Federico's 3 prod verifications = honest launch
- Push to Wed/Thu = time for v26 reshape

---

## What I think makes sense (not deciding for you)

1. **Tonight (next 4-6h)**: lock the v26 IA verbally with you (15-min discussion or async write-up), so codex/claude can start producing v26 in the background while you sleep. Backend stays as-is (ready).
2. **Tomorrow (Mon)**: v26 wireframes audit + React reshape + your 3 prod verifications.
3. **Tuesday**: launch on v26 React.

OR — if v26 is too much risk for Tuesday:

1. **Tonight**: patch v25 chrome consistency + add app store link + fix 3 real React bugs.
2. **Tomorrow**: your 3 prod verifications + ICP walkthroughs.
3. **Tuesday**: launch v25.
4. **Post-launch**: v26 IA reshape as a follow-up release.

Your call.
