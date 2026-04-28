# v26 IA Spec

Date: 2026-04-27
Federico-locked from chat 2026-04-27.

## Hierarchy

```
Workspace
├── click name → /settings (page with tabs: BYOK keys, Agent tokens, Studio settings, [Members v1.1], [Billing v1.1])
├── [ Run | Studio ] toggle (below workspace name in rail)
│   ├── Run mode
│   │   ├── Apps          (default landing — hero strip + apps grid + runs)
│   │   └── Runs
│   └── Studio mode
│       ├── Apps          (default landing — hero metric + apps grid + activity)
│       └── Runs
├── App store              (mode-agnostic, below workspace in rail; shows public + workspace apps)
└── Docs                   (always visible in rail)
```

## Authenticated TopBar (slim)

```
[floom logo] ──────────────────── [Copy for Claude] [+ New app] [avatar]
```

- Floom logo: route-aware — landing if logged-out, /run/apps if logged-in
- `+ New app`: visible always (creator entry from anywhere)
- Avatar: opens Account dropdown — Account settings, Sign out (Account is NOT in left rail)

## Public/Unauthenticated TopBar

```
[floom logo] ──── [Apps] [Docs] [Pricing] ──── [Sign in] [Sign up]
```

- Mode toggle NOT shown when logged out
- Workspace identity block NOT shown when logged out

## Left rail (authenticated)

```
{workspace name}        ← clickable, subtle chevron, → opens /settings (tabbed page)

[ Run | Studio ]        ← mode toggle pill

— Run mode shown:        — Studio mode shown:
Apps      5              Apps      5
Runs      142            Runs      142
                         + New app

App store                App store
Docs                     Docs
```

- Account NOT in rail (in TopBar avatar dropdown)
- Workspace settings NOT in rail (accessed via workspace name click)
- BYOK keys / Agent tokens / Studio settings NOT in rail (live inside /settings tabs)

## /settings page

Single page with tabs (mirrors per-app page pattern):

```
Tabs: General · BYOK keys · Agent tokens · Studio settings · [Members v1.1] · [Billing v1.1]
```

Each tab is a content block on the same page (URL: /settings/byok-keys, /settings/agent-tokens, etc. for deep links).

## /run dashboard (= /run/apps)

Default authenticated landing for consumer mode. Replaces v25 /run overview.

Layout:
```
Hero strip: "5 runnable apps · 142 runs this week · 1 running now" (compact, not a big metric tile)
─────────
Apps grid (2-3 columns of cards with friendly result preview)
─────────
Recent runs (compact, 5 rows max)
─────────
Footer CTA: "Browse the app store →"
```

Drop the v25 /run page as separate. /run redirects to /run/apps.

## /studio dashboard (= /studio/apps)

Default authenticated landing for creator mode. Replaces v25 /studio overview.

Layout:
```
Hero metric: "Runs across all your apps · last 7d · 2,847 · ↑18%" (kept, more compact than v25)
─────────
Apps grid (per-app cards: stats + status + edit/view)
─────────
Recent activity (compact)
─────────
"+ New app" CTA
```

Drop /studio overview as separate. /studio redirects to /studio/apps.

## App store (/apps)

Mode-agnostic. Available from both Run and Studio rails. Shows:

- Public apps (anyone can run)
- Workspace apps (apps installed in this workspace)

CTAs per app card:
- **Run** — if installed in workspace OR public
- **Fork** — if public; opens Studio Build with this app's manifest as starting point
- **Install** — if it's a public app the runner wants to add to their workspace

## Per-app pages

### Studio per-app (/studio/apps/:slug)
Tabs: Overview · Runs · App creator secrets · Access · Analytics · Source · Feedback · Triggers (info only)

**App creator secrets tab** has 2 sections:
1. **App creator secrets** (existing) — "Secrets I shipped with this app" (publisher-controlled)
2. **Workspace BYOK requirements** (NEW per Federico point 8) — "Declarations of BYOK keys this app expects from the runner's workspace"

### Run per-app (/run/apps/:slug)
Tabs: Run · Triggers
+ Inline cross-link strip: "View 24 runs for this app →" + "Workspace BYOK keys →"

### Public app page (/p/:slug)
Tabs: Run · About · Install · Source
Same outer chrome across all 8 states (idle / running / output / rate-limited / error / install-tab / source-tab / about-tab).

## Workspace name click → /settings page

Visual: workspace name in left rail has a subtle chevron `▾` indicating click-action.
Click → navigate to /settings which renders the tabbed settings page (default tab: General).

## Landing → dashboard transition

Federico chose A + C:

**A (always-same TopBar)**: TopBar shows the same brand + nav structure logged-out and logged-in. Only the auth-area changes (Sign in/up vs avatar).

**C (logged-in-aware landing)**: When logged-in user hits "/", landing page shows a banner-CTA at top: "Resume in {workspaceName} →" linking to /run/apps. Then the rest of marketing content. (Logged-out user sees full marketing content with no banner.)

## What v26 actually changes vs v25

| Surface | v25 | v26 |
|---|---|---|
| Mode switcher | TopBar center nav | Left rail toggle below workspace name |
| Workspace settings access | Rail group with 3 items | Click workspace name → /settings tabbed page |
| Account in rail | Yes (Account group) | No (TopBar avatar only) |
| /run dashboard | Separate page | Drops, /run → /run/apps |
| /studio dashboard | Separate page | Drops, /studio → /studio/apps |
| App store | Linked from TopBar | Below workspace in rail (always visible) |
| Docs | TopBar (logged out) | Rail entry (always visible authenticated) |
| Per-app Studio secrets | App creator secrets only | + Workspace BYOK requirements section |
| App-page chrome consistency | Inconsistent across 8 states | Same chrome, only inner differs |
| /settings page | Doesn't exist (3 separate pages) | Tabbed page with all settings |

## Rail comparison

**v25 Run shell:**
```
floom
Workspace
{workspaceName}
─ Run ─
Overview
Apps · 5
Runs · 142
─ Workspace settings ─
BYOK keys · 3
Agent tokens · 2
─ Account ─
Account settings
─ rail-foot ─
Federico · Sign out
```

**v26 Run shell:**
```
floom
{workspaceName} ▾                ← click → /settings tabbed page
[ Run | Studio ]                 ← toggle pill, Run active
─────
Apps · 5
Runs · 142
─────
App store
Docs
─ rail-foot ─
Federico · Sign out
```

12 items → 7 items. Way less rail bloat.

## Locked answers from chat 2026-04-27

| # | Topic | Answer |
|---|---|---|
| 2a | Toggle position | BELOW workspace name (workspace > mode hierarchy) |
| 2b | Toggle on public pages | NO |
| 3 | Landing → dashboard | A (same TopBar) + C (logged-in-aware landing banner) |
| 4 | Click workspace name | YES, opens tabbed /settings page (like per-app pages) |
| 4b | Chevron on workspace name | Subtle ▾ chevron — Claude decide |
| 6 | DRY review | YES, after IA settles |
| 7 | App store placement | Mode-agnostic, below workspace in rail; CTAs are Run / Fork / Install |
| 8 | Per-app workspace BYOK | YES, Studio per-app secrets has 2 sections (creator secrets + BYOK requirements) |
| 9 | Drop overview pages | YES, /run → /run/apps, /studio → /studio/apps; hero metric moves to top of /apps |
| 10 | Authenticated TopBar | Slim: logo + Copy for Claude + + New app + avatar. Drop Apps/Docs/Pricing from authenticated TopBar. |
| 10b | Docs in Studio | Visible in left rail authenticated (Run + Studio modes both) |
| 10c | Pricing | Public TopBar only |
| Store | Mixed view | Public apps + workspace-installed apps in same store |

## Implementation impact

### Wireframes (v26 from v25 base):
- All 52 files: replace TopBar nav, replace rail components, add workspace-name click affordance
- Drop /run/index and /studio/index page wireframes (or redirect to /apps)
- New: /settings tabbed page wireframe
- New: Studio per-app secrets with 2-section layout
- All 8 app-page state files: chrome consistency pass
- Landing: add logged-in resume banner

### React (post-wireframe):
- New components: `WorkspaceRail` (replaces RunRail+StudioRail+SettingsRail with mode prop), `WorkspaceNameClick` (the clickable identity block), `ModeToggle` pill, mode-aware page shell
- New page: SettingsPage with tab routing
- Update: StudioAppSecretsPage with 2-section layout
- Update: per-app-page family chrome
- Update: TopBar (drop Apps/Docs/Pricing nav when authenticated)
- Update: landing to read session and show resume banner
- Drop: MePage (/run dashboard), StudioHomePage (/studio dashboard) → redirect to /apps
- Server: add /run, /studio redirects to /apps; add /settings → /settings/general

### Backend (no schema change):
- /api/me/agent-keys, /api/me/runs etc. unchanged (already workspace-scoped)
- App manifest schema may add `required_workspace_byok` field for v1.1

## Tuesday → Wed/Thu launch slip

Per Path B agreement. Schedule:
- **Tonight**: this spec locks (you're reading it)
- **Mon AM**: codex+claude rebuild wireframes (v26)
- **Mon PM**: codex DRY review + React reshape
- **Mon eve**: ICP walkthroughs on v26 React
- **Tue**: your prod verifications (OAuth, Resend, migration dry-run)
- **Wed/Thu**: launch on v26

---

## 11. App + key sharing visibility + rate limits (Federico added 2026-04-27)

Both apps and BYOK keys / Agent tokens have **3 visibility levels**:

- **Only me** — only the workspace member who created it
- **Selected** — explicit list of workspace members or external users
- **Public** — anyone in the workspace (or globally for apps published to /p/:slug)

Both apps and keys can also be **rate-limited** per scope:
- Per workspace member
- Per external caller (agent token bearer)
- Globally

UI: visibility + rate limit controls live on the per-resource page. For apps: Studio per-app Access tab. For keys/tokens: /settings/byok-keys row + /settings/agent-tokens row each have visibility + rate-limit controls.

v1: ship "only me" + "public" + global rate limit. v1.1: "selected" + per-caller rate limits.

---

## 12. Post-audit IA refinements (Federico locked 2026-04-27)

Eight refinements after the first wireframe pass exposed gaps:

### 12.1 Drop rail brand
- TopBar carries the floom logo. WorkspaceRail does NOT — it starts directly with the workspace identity block.
- Remove `<a class="rail-brand">` from `run-workspace-shell` and `studio-workspace-shell`.

### 12.2 Run vs Studio shell alignment
- `/run/apps` and `/studio/apps` use the SAME shell + SAME layout shape.
- `/run/runs` and `/studio/runs` use the SAME shell + SAME layout shape.
- Layout shape = `[hero stat row] → [primary list/grid] → [secondary panel] → [activity strip]`. Only data + primary CTA differ.
- Today the two are divergent because two agents built them; one alignment pass fixes this.

### 12.3 + 12.4 "+ New app" as single rail entry; App store collapses inside
- Remove standalone "App store" rail item.
- "+ New app" is the single entry point for adding apps in both modes:
  - **Run "+ New app"**: overlay with tabs `Browse store` (default) · `Connect existing`
  - **Studio "+ New app"**: overlay with tabs `From repo` · `Blank` · `Fork from store`
- One mental model: "+ New app" is always how an app enters the workspace.

### 12.5 Docs → avatar dropdown
- Remove "Docs" from rail.
- Avatar dropdown menu = `Account settings` · `Docs` · `Help` · `Sign out`.

### 12.6 Workspace settings entry
- Workspace name in identity block (click → `/settings`) is the only entry. No bottom-rail gear.
- First-hover tooltip: "Workspace settings".

### 12.7 Streaming UX deferred to v1.1
- v1 runs are SYNC only. Running state shows static "running…" + cancel + elapsed timer.
- v1.1 ships job queue + SSE token-by-token streaming inside the output card.

### 12.8 Output rendering — plain auto-renderer in v1
- Auto-render output from JSON schema:
  - `array<object>` → table, columns = first object's keys, formatter per JSON type
  - `object` → key/value list
  - `string` / `number` / `boolean` → inline value
- No per-app render config in v1.
- v1.1 may ship optional `output_view: { columns, primary, sort }` hints in the manifest.
- Wireframes showing polished demo tables are aspirational — replace with realistic auto-rendered output.
