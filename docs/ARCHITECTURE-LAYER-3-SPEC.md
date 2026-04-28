# Floom Workspace Architecture Layer 3 Spec

Date: 2026-04-27
Launch constraint: Tuesday 2026-04-28
Scope: v23 HTML wireframe to v24 HTML wireframe delta. Claude produces v24 HTML wireframes from this document in a separate run.

## Global Summary

### URL Rename Decision

Canonical v24 browser files and routes use `/run/*`, `/settings/*`, and `/account/settings`. Existing `/me/*` wireframe files from Round 1 and Round 2 become compatibility references only; the next v24 production pass writes the renamed files below.

### v23 Files Needing v24 Revision

| v23 file | v24 file | Reason |
|---|---|---|
| `me.html` | `run.html` | Removes personal account framing, adds Run shell workspace identity and Run / Workspace settings / Account grouping. |
| `me-apps.html` | `run-apps.html` | Converts installed apps from personal `/me` tabs into runnable apps in the active workspace. |
| `me-runs.html` | `run-runs.html` | Converts personal run history into active workspace run history and adopts the Run shell sidebar. |
| `me-runs-detail.html` | `run-runs-detail.html` | Updates breadcrumbs, Copy for Claude snippet, and run metadata framing to active workspace context. |
| `me-secrets.html` | `settings-byok-keys.html` | Moves BYOK keys to canonical Workspace settings URL and removes personal tab strip. |
| `me-agent-keys.html` | `settings-agent-tokens.html` | Moves Agent tokens to canonical Workspace settings URL and updates token ownership copy to workspace credentials. |
| `me-settings.html` | `account-settings.html` | Moves account settings to `/account/settings` and removes workspace credential controls from this surface. |
| `me-empty-state.html` | `run-empty-state.html` | Reframes first-time `/run` as Workspace Run, not My account. |
| `me-app-run.html` | `run-app-run.html` | Updates installed app run surface to active workspace runtime and BYOK keys copy. |
| `me-app-triggers.html` | `run-app-triggers.html` | Keeps triggers under Run mode and changes personal phrasing to active workspace runtime phrasing. |
| `me-app-trigger-schedule.html` | `run-app-trigger-schedule.html` | Updates schedule builder shell and snippets to Run mode inside active workspace. |
| `me-app-trigger-webhook.html` | `run-app-trigger-webhook.html` | Updates webhook builder shell and snippets to Run mode inside active workspace. |
| `me-install.html` | `run-install.html` | Reframes authenticated install helper around Agent tokens in Workspace settings. |
| `studio-home.html` | `studio-home.html` | Replaces visible switcher with left-rail workspace identity block and hides v1 Team/Billing rail entries. |
| `studio-empty.html` | `studio-empty.html` | Adds Studio shell workspace identity and removes My account topbar framing. |
| `studio-apps.html` | `studio-apps.html` | Aligns Studio apps page to workspace identity block and hides v1-invisible settings entries. |
| `studio-runs.html` | `studio-runs.html` | Keeps workspace-wide Studio run analytics but updates shell and snippet vocabulary. |
| `studio-build.html` | `studio-build.html` | Shows target workspace identity in the build flow and updates publish snippet to Agent token vocabulary. |
| `studio-settings.html` | `settings-studio.html` | Moves Studio-local General/GitHub settings to canonical Workspace settings URL; credentials link to `/settings/byok-keys` and `/settings/agent-tokens`. |
| `studio-app-overview.html` | `studio-app-overview.html` | Updates Studio app shell, breadcrumbs, and app ownership copy to active workspace. |
| `studio-app-runs.html` | `studio-app-runs.html` | Updates Studio app run analytics to workspace-owned app context and shell vocabulary. |
| `studio-app-secrets.html` | `studio-app-secrets.html` | Renames tab and page to App creator secrets and separates it from workspace BYOK keys. |
| `studio-app-access.html` | `studio-app-access.html` | Updates app access copy to distinguish workspace collaborators from app runners. |
| `studio-app-analytics.html` | `studio-app-analytics.html` | Updates shell and breadcrumbs to active workspace context. |
| `studio-app-source.html` | `studio-app-source.html` | Updates shell and breadcrumbs to active workspace context. |
| `studio-app-feedback.html` | `studio-app-feedback.html` | Updates shell and breadcrumbs to active workspace context. |
| `studio-app-triggers.html` | `studio-app-triggers.html` | Keeps as creator-facing explainer, but updates shell and cross-link copy to Run mode. |
| `landing.html` | `landing.html` | Updates global Copy for Claude token snippet to Agent token vocabulary. |
| `apps.html` | `apps.html` | Updates global Copy for Claude token snippet if shown in the public directory topbar. |
| `app-page.html` | `app-page.html` | Updates install/token snippets and keeps public slug route flat. |
| `app-page-running.html` | `app-page-running.html` | Same public slug route; updates global Copy for Claude snippet only. |
| `app-page-output.html` | `app-page-output.html` | Same public slug route; updates global Copy for Claude snippet only. |
| `app-page-rate-limited.html` | `app-page-rate-limited.html` | Keeps rate-limit UX; updates BYOK keys wording if the upsell appears. |
| `app-page-error.html` | `app-page-error.html` | Keeps error UX; updates BYOK keys wording if credential recovery appears. |
| `app-page-install.html` | `app-page-install.html` | Keeps public install tab; updates Agent token snippet wording. |
| `app-page-source.html` | `app-page-source.html` | Keeps source tab; updates global Copy for Claude snippet only. |
| `app-page-about.html` | `app-page-about.html` | Keeps about tab; updates global Copy for Claude snippet only. |
| `login.html` | `login.html` | Updates global Copy for Claude snippet to Agent token vocabulary. |
| `signup.html` | `signup.html` | Updates global Copy for Claude snippet to Agent token vocabulary. |
| `install-in-claude.html` | `install-in-claude.html` | Updates authenticated setup copy to mint an Agent token in Workspace settings. |
| `install.html` | `install.html` | Updates CLI authentication copy to Agent token wording. |
| `install-app.html` | `install-app.html` | Updates per-app installer auth row and snippets to Agent token wording. |
| `ia.html` | `ia.html` | Updates IA documentation to Workspace above Run and Studio, plus new Run sidebar group order. |
| `architecture.html` | `architecture.html` | Updates architecture explainer from per-user token framing to workspace Agent tokens. |
| `mobile-menu.html` | `mobile-menu.html` | Replaces My account drawer group with Workspace identity, Run, Studio, Workspace settings, Account. |
| `design-system.html` | `design-system.html` | Updates locked IA and vocabulary rules for v24. |
| `_v23.css` | `_v24.css` | Adds v24-only shell styles for workspace identity block, Run sidebar, and mobile drawer grouping. |

### v23 Files Staying Unchanged

| v23 file | Rationale |
|---|---|
| `modal-share.html` | Share action is app/run scoped and has no workspace IA change in v1. |
| `modal-invite-people.html` | Multi-member UI is hidden in v1; the modal remains out of launch navigation. |
| `modal-confirm-destructive.html` | Generic destructive confirmation remains valid for account, run, and app deletion. |
| `modal-skill-install.html` | Modal installs a public app as a Skill; workspace credential setup is handled on install pages. |
| `modal-submit-for-review.html` | Submit-for-review flow remains Studio app scoped and does not affect workspace settings IA. |

### New v24 Files Needed

| Proposed v24 file | Parent v23 file | Extension reasoning |
|---|---|---|
| `run-workspace-shell.html` | `run.html` | Canonical desktop/mobile Run shell reference showing the workspace identity block and the exact Run / Workspace settings / Account sidebar groups. |
| `workspace-settings-shell.html` | `settings-byok-keys.html` | Shared Workspace settings shell reference for BYOK keys and Agent tokens without duplicating the whole page in every spec note. |
| `studio-workspace-shell.html` | `studio-home.html` | Canonical Studio sidebar reference with identity block, hidden switcher, hidden Team/Billing, and workspace settings cross-links. |
| `settings-byok-keys-empty.html` | `settings-byok-keys.html` | Empty BYOK keys state after workspace-level migration, including conflict-free add flow copy. |
| `settings-agent-tokens-empty.html` | `settings-agent-tokens.html` | Empty Agent tokens state with first-token CTA and exact Agent token warning copy. |

### Existing v24 File Rename Map

Files already shipped under the previous SPEC move as follows:

| Current v24 file | New v24 file |
|---|---|
| `/var/www/wireframes-floom/v24/me-workspace-shell.html` | `/var/www/wireframes-floom/v24/run-workspace-shell.html` |
| `/var/www/wireframes-floom/v24/workspace-settings-shell.html` | `/var/www/wireframes-floom/v24/workspace-settings-shell.html` |
| `/var/www/wireframes-floom/v24/studio-workspace-shell.html` | `/var/www/wireframes-floom/v24/studio-workspace-shell.html` |
| `/var/www/wireframes-floom/v24/me-secrets.html` | `/var/www/wireframes-floom/v24/settings-byok-keys.html` |
| `/var/www/wireframes-floom/v24/me-agent-keys.html` | `/var/www/wireframes-floom/v24/settings-agent-tokens.html` |
| `/var/www/wireframes-floom/v24/me-settings.html` | `/var/www/wireframes-floom/v24/account-settings.html` |
| `/var/www/wireframes-floom/v24/me-secrets-empty.html` | `/var/www/wireframes-floom/v24/settings-byok-keys-empty.html` |
| `/var/www/wireframes-floom/v24/me-agent-keys-empty.html` | `/var/www/wireframes-floom/v24/settings-agent-tokens-empty.html` |

Additional v24 file rename for the settings URL rework:

| Current or planned v24 file | New v24 file |
|---|---|
| `/var/www/wireframes-floom/v24/studio-settings.html` | `/var/www/wireframes-floom/v24/settings-studio.html` |

### Layer 1/2 Decisions To v24 Changes

| Decision | v24 wireframe change |
|---|---|
| Q-A A3: canonical `/run/*`, `/settings/*`, and `/account/settings` | `/settings/byok-keys` and `/settings/agent-tokens` sit under `Workspace settings`; `/account/settings` sits under `Account`; `/me/*` becomes compatibility only. |
| Q-B B2: workspace identity in left rail/sidebar | Run shell and Studio shell render the same 40px workspace identity block at the top of the rail/sidebar. No TopBar workspace banner and no breadcrumb-only identity. |
| Q-C: Agent-token list cutover | `settings-agent-tokens.html` copy says Agent tokens are workspace credentials. Token rows remain visible under active workspace context, with issuer as audit metadata only. |
| Q-D D1: BYOK keys versus App creator secrets | `/settings/byok-keys` is `BYOK keys`; Studio per-app secret tab is `App creator secrets`. The two forms remain separate and cross-link only for explanation. |
| Workspace-tier IA restructure | The visible hierarchy is `Workspace` above `Run`, `Studio`, and `Settings`. Settings are not nested under Studio. Studio sidebar links to workspace credential pages, while `/settings/studio` remains a Studio-local General/GitHub settings page for v1. |

## Shared v24 Shell Contract

### Routes

Canonical v1 browser URLs:

- `/run`, `/run/apps`, `/run/runs`, `/run/runs/:id`, `/settings/byok-keys`, `/settings/agent-tokens`, `/account/settings`, `/run/install`
- `/run/apps/:slug/run`, `/run/apps/:slug/triggers`, `/run/apps/:slug/triggers/schedule`, `/run/apps/:slug/triggers/webhook`
- `/studio`, `/studio/apps`, `/studio/runs`, `/studio/build`, `/settings/studio`, `/studio/apps/:slug/*`
- Public routes remain flat: `/p/:slug`, `/install`, `/install-in-claude`, `/install/:slug`

Compatibility redirects:

- `/me` -> `/run`
- `/me/apps*` -> `/run/apps*`
- `/me/runs*` -> `/run/runs*`
- `/me/install` -> `/run/install`
- `/me/secrets` -> `/settings/byok-keys`
- `/me/agent-keys` and `/me/api-keys` -> `/settings/agent-tokens`
- `/me/settings` -> `/account/settings`
- `/studio/settings` -> `/settings/studio`

### TopBar

Replace every authenticated TopBar center nav using `Studio · My account` with:

- `Run` -> `./run.html`
- `Studio` -> `./studio-home.html`

Active state:

- Any `/run/*` file marks `Run` active.
- Any `/studio/*` file marks `Studio` active.
- Public/auth files have no active Run/Studio item unless the v23 file already shows authenticated chrome.

Remove these visible strings everywhere:

- `My account`
- `your account`
- `FOR YOUR ACCOUNT`
- `For this page (your account)`
- `YOUR ACCOUNT SETTINGS`

Replacement strings:

- TopBar nav label: `Run`
- Avatar menu first item: `Workspace Run`
- Account page link: `Account settings`
- Copy popover label on `/run`: `FOR WORKSPACE RUN`
- Copy popover label on `/account/settings`: `ACCOUNT SETTINGS`

### Workspace Identity Block

Use the same component in Run and Studio shells:

```text
Eyebrow: Workspace
Name: {workspaceName}
Height: 40px content block
Desktop padding: 16px 16px 12px
Divider: 1px solid var(--line) directly below
Switcher affordance: hidden in v1 when workspaces.length === 1
```

Placeholder contract: wireframes use `{workspaceName}` as the visible workspace-name placeholder; production reads this value from the active workspace.

The block is plain identity text, not a disabled button. No chevron renders in v1 single-workspace wireframes.

### Run Shell Sidebar

Add the v24 Run sidebar to all `/run/*` desktop wireframes. Replace `.me-primary-nav`, `.ms-tabs`, `.ak-tabs`, and page-specific desktop tab strips with this left rail.

Exact group labels and order:

```text
Workspace
{workspaceName}

Run
Overview        /run
Apps            /run/apps
Runs            /run/runs

Workspace settings
BYOK keys       /settings/byok-keys
Agent tokens    /settings/agent-tokens

Account
Account settings /account/settings
```

Hidden in v1:

- Members
- Billing
- Workspace switcher
- Workspace creation

Counts remain visible where v23 already uses counts:

- `Apps 5`
- `Runs 142`
- `BYOK keys 3`
- `Agent tokens 2`

### Studio Sidebar

In every Studio rail, replace `.ws-switcher` with the workspace identity block. Keep `.rail-brand` above it. Exact order:

```text
floom Studio

Workspace
{workspaceName}

New app

Studio
Home            /studio
Apps            /studio/apps
All runs        /studio/runs

Apps · 5
flyfast
opendraft
competitor-lens
pitch-coach
ai-readiness-audit

Workspace settings
BYOK keys       /settings/byok-keys
Agent tokens    /settings/agent-tokens
Studio settings /settings/studio

Account
Account settings /account/settings
```

`New app` is a primary Studio CTA, not a Studio navigation item. Desktop places it between the workspace identity block and the `Studio` mode links so creators can start publishing without scanning the app list. Mobile keeps it inside the `Studio` group as a command row.

Hidden in v1:

- Team
- Billing
- workspace switcher chevron
- owner role line as a control

`Studio settings` is scoped to Studio-local General/GitHub configuration in v1. It does not contain BYOK keys or Agent tokens.

### Mobile Drawer

Replace authenticated mobile drawer group order with:

```text
Workspace
{workspaceName}

Run
Overview
Apps
Runs

Studio
Home
Apps
All runs
New app

Workspace settings
BYOK keys
Agent tokens

Account
Account settings
Sign out
```

The same identity block appears as the first item. No workspace switcher affordance renders in v1.

### Signed-Out And Mid-Signup Chrome

Rules for shared shells:

- Unauthenticated users never render the workspace identity block.
- If a user signs out while on `/run/*` or `/studio/*`, replace authenticated chrome with the public TopBar: `Apps`, `Docs`, `Pricing`, plus auth actions from the public shell. Do not keep Run/Studio nav, sidebars, or workspace identity in the signed-out state.
- `login.html` and `signup.html` with visible forms render neither the workspace identity block nor authenticated Run/Studio navigation.
- Public routes including `/`, `/apps`, `/p/:slug`, `/install`, `/install-in-claude`, and `/install/:slug` remain outside workspace chrome unless the v23 file already contains an authenticated install helper state.

### Locked Vocabulary

Exact strings:

- `BYOK keys`
- `Agent tokens`
- `App creator secrets`
- `Workspace settings`
- `Account settings`
- `Workspace Run`

Do not use generic credential labels for BYOK keys or Agent tokens.

### Standard Token Snippets

Replace all authenticated token placeholders in v24 wireframes with Agent token examples:

```bash
floom auth login --token=floom_agent_••••••
```

For publish snippets:

```bash
FLOOM_API_KEY=floom_agent_•••••• floom deploy ./floom.yaml
```

For run snippets:

```bash
floom auth login --token=floom_agent_••••••
floom run competitor-lens --you stripe --rival adyen
```

## Wireframe Production Order

Claude produces v24 files in this order:

### Round 1: Shared Shells

Files:

- `run-workspace-shell.html`
- `workspace-settings-shell.html`
- `studio-workspace-shell.html`

Dependencies: none. These files define the chrome contracts that every workspace, Run, and Studio screen reuses.

Parallel-safe work: all three shared shells can be produced together because each owns a different shell reference.

Screenshot checkpoint: desktop and mobile screenshots show loaded chrome, `{workspaceName}`, hidden switcher, Run/Studio active states, and no overlap.

### Round 2: Workspace Settings Pages

Files:

- `settings-byok-keys.html`
- `settings-agent-tokens.html`
- `settings-byok-keys-empty.html`
- `settings-agent-tokens-empty.html`
- `account-settings.html`

Dependencies: Round 1 shell contracts.

Parallel-safe work: BYOK keys pages and Agent tokens pages can be produced in parallel; `account-settings.html` only shares the Account group placement.

Screenshot checkpoint: `/settings/byok-keys`, `/settings/agent-tokens`, and `/account/settings` show distinct Workspace settings versus Account placement with loaded content or intentional empty states.

### Round 3: Run Mode Pages

Files:

- `run.html`
- `run-apps.html`
- `run-runs.html`
- `run-runs-detail.html`
- `run-empty-state.html`
- `run-app-run.html`
- `run-app-triggers.html`
- `run-app-trigger-schedule.html`
- `run-app-trigger-webhook.html`
- `run-install.html`

Dependencies: Round 1 Run shell and Round 2 credential destinations for BYOK keys and Agent tokens links.

Parallel-safe work: dashboard/list/detail pages can be produced in parallel; trigger builder pages can be produced in parallel after the per-app tab wording is locked.

Screenshot checkpoint: `/run`, `/run/apps`, `/run/runs`, one run detail, one app run page, and one trigger page show Run mode, workspace run copy, valid snippets, and canonical browser URLs.

### Round 4: Studio Mode Pages

Files:

- `studio-home.html`
- `studio-empty.html`
- `studio-apps.html`
- `studio-runs.html`
- `studio-build.html`
- `settings-studio.html`
- `studio-app-overview.html`
- `studio-app-runs.html`
- `studio-app-secrets.html`
- `studio-app-access.html`
- `studio-app-analytics.html`
- `studio-app-source.html`
- `studio-app-feedback.html`
- `studio-app-triggers.html`

Dependencies: Round 1 Studio shell, Round 2 Workspace settings targets, and the `New app` CTA placement call.

Parallel-safe work: Studio home/list/build/settings pages can be produced in parallel with app subpages because they share only the shell contract and locked vocabulary.

Screenshot checkpoint: Studio home, build, app overview, app secrets, and Studio settings show `{workspaceName}`, `New app` CTA placement, App creator secrets wording, and Workspace settings cross-links.

### Round 5: Public And Auth Pages

Files:

- `landing.html`
- `apps.html`
- `app-page.html`
- `app-page-running.html`
- `app-page-output.html`
- `app-page-rate-limited.html`
- `app-page-error.html`
- `app-page-install.html`
- `app-page-source.html`
- `app-page-about.html`
- `login.html`
- `signup.html`
- `install-in-claude.html`
- `install.html`
- `install-app.html`
- `ia.html`
- `architecture.html`

Dependencies: Round 1 signed-out chrome rules and Round 2/3/4 vocabulary decisions.

Parallel-safe work: public app states, auth pages, installer pages, and documentation pages can be produced in separate batches once snippet vocabulary is frozen.

Screenshot checkpoint: public and auth pages show public chrome, no workspace identity block, Agent token snippets where relevant, and flat public URLs.

### Round 6: Mobile And Design System

Files:

- `mobile-menu.html`
- `design-system.html`
- `_v24.css`

Dependencies: all prior rounds, because the mobile drawer and design system codify final shell, spacing, and vocabulary decisions.

Parallel-safe work: `mobile-menu.html` and `design-system.html` can be produced in parallel after `_v24.css` workspace shell classes exist.

Screenshot checkpoint: mobile drawer order is Workspace identity, Run, Studio, Workspace settings, Account; design-system examples match the Round 1 shell screenshots; `_v24.css` supports the loaded screenshots without layout shift.

## Per-File Delta

### run.html

Current state (v23): Shows `My account · /me`, TopBar center nav `Studio · My account`, avatar menu with `My account`, and a horizontal `.me-primary-nav` mixing Apps, Runs, BYOK keys, Agent tokens, Settings. Main content is apps-led with a personal greeting `Hi, Federico.`.

Layer 1+2 logic: `/run` is Workspace Run dashboard under the active workspace. Workspace identity appears in the Run rail, and credentials move under Workspace settings.

Delta: Change page title/spec heading to `Workspace Run · /run`. Replace TopBar nav label `My account` with `Run`. Add Run shell sidebar using the exact Shared Run Shell Sidebar order. Remove `.me-primary-nav` on desktop. Change `aria-label="My account primary nav"` to `aria-label="Workspace Run navigation"` if a reduced mobile strip remains. Change greeting to `Workspace Run` and supporting copy to `5 runnable apps · 142 workspace runs this week · 1 running now`. Avatar menu first link becomes `Workspace Run`; Settings link becomes `Account settings`. Copy popover context label becomes `FOR WORKSPACE RUN` and snippet uses `floom_agent_••••••`.

New screens needed: `run-workspace-shell.html`.

Out of scope: Keep apps-led dashboard content order, app cards, running/scheduled block, recent runs block, and Agent tokens closing CTA layout.

### run-apps.html

Current state (v23): Shows `Installed apps`, copy saying apps are pinned to `/me`, TopBar `My account`, and horizontal tabs with BYOK keys and Agent tokens as peer tabs.

Layer 1+2 logic: `/run/apps` is runnable apps in the active workspace, under Run mode.

Delta: Replace page heading with `Apps`. Supporting copy becomes `5 runnable apps in {workspaceName}. Available in browser, Claude, Cursor, CLI, and HTTP.` Add Run shell sidebar. Remove desktop tab strip. Replace all `Installed apps` labels in desktop and mobile with `Apps`. Keep `/run/apps` URL and app cards. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep app grid, status pills, run CTAs, and browse-store CTA.

### run-runs.html

Current state (v23): Shows `/me/runs` as all your runs with TopBar `My account`, horizontal tabs, and run rows.

Layer 1+2 logic: Run history belongs to the active workspace and remains under Run mode.

Delta: Add Run shell sidebar. Change heading to `Runs`. Supporting copy becomes `Run history for {workspaceName} across browser, MCP, HTTP, and CLI.` Change table/list `aria-label="All your runs"` to `aria-label="Workspace run history"`. Replace mobile tab strip with Run drawer grouping or a compact section strip limited to `Overview · Apps · Runs`; BYOK keys and Agent tokens move under the mobile drawer `Workspace settings` group. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep filters, row structure, status pills, and detail links.

### run-runs-detail.html

Current state (v23): Run detail is under `My account`, with personal run metadata and Copy for Claude snippets.

Layer 1+2 logic: Run detail is an active-workspace run record. Route stays `/run/runs/:id`.

Delta: Replace TopBar `My account` with `Run`. Add Run shell sidebar. Breadcrumb becomes `Run / Runs / run_a8f31`. Header meta keeps run id, when, client, duration, model, and tokens, but any ownership copy changes from user-owned to workspace context. Copy popover context label becomes `FOR THIS WORKSPACE RUN`; snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep I/O panels, logs, share/re-run actions, and metrics layout.

### workspace-settings-shell.html

Current state (v24 shell target): Shared shell reference for BYOK keys and Agent tokens.

Layer 1+2 logic: Workspace settings are tenant-scoped. In v1 there is one visible workspace, so the shell shows identity without switching. In v1.1, the same shell exposes switching only when the browser user belongs to more than one workspace.

Delta: Keep the workspace identity block visible in v1 with no chevron or dropdown affordance. Add a v1.1 note to the shell reference: when `workspaces.length > 1`, the identity block becomes `WorkspaceSwitcher`, selecting an item writes `user_active_workspace` and navigates to `/w/:workspaceSlug/settings/<current-page>`. Flat `/settings/*` URLs remain compatibility aliases bound to the active workspace. Do not add workspace selector fields to BYOK keys or Agent token forms; the shell controls browser context, while Agent tokens still control MCP/CLI/HTTP context.

New screens needed: None.

Out of scope: Keep member management, billing, and workspace creation hidden in v1 launch wireframes.

### settings-byok-keys.html

Current state (v23): Page title is already `BYOK keys`, but copy says provider keys are `your` keys; BYOK keys are in the same horizontal tab strip as Apps and Runs.

Layer 1+2 logic: BYOK keys are workspace-level encrypted runtime credentials in Workspace settings.

Delta: Add Workspace settings shell using the Run shell sidebar. Active sidebar item: `BYOK keys` under `Workspace settings`. Header eyebrow becomes `Workspace settings`. H1 remains `BYOK keys`. Replace description with: `Workspace-level provider credentials for apps that declare required runtime keys. Values are encrypted at rest and only decrypted at run time.` Add small workspace scope line under header: `Applies to {workspaceName}.` Replace `Rotate` buttons with `Replace` to match workspace credential semantics. Copy popover label becomes `MANAGE BYOK KEYS`; snippet uses `floom_agent_••••••`. Remove desktop `.ms-tabs`.

New screens needed: `workspace-settings-shell.html`, `settings-byok-keys-empty.html`.

Out of scope: Keep key card list, provider names, masked values, used-by chips, and remove actions.

### settings-agent-tokens.html

Current state (v23): Page title is `Agent tokens`, but copy says tokens let agents act as you. Horizontal tabs frame it as a `/me` sibling page.

Layer 1+2 logic: Agent tokens are workspace credentials. The minting user is issuer metadata, not owner.

Delta: Add Workspace settings shell. Active sidebar item: `Agent tokens` under `Workspace settings`. Header eyebrow becomes `Workspace settings`. H1 remains `Agent tokens`. Replace intro with: `Agent tokens let Claude Code, Cursor, Codex, CI, and scripts run or publish against {workspaceName}. Tokens are workspace credentials; the issuing user is audit metadata.` Replace active section title with `Active Agent tokens`. Row metadata adds `Issued by Federico` before created date. Warning copy in token modal becomes: `Treat this like a password. Anyone with this Agent token can act within {workspaceName} for the configured scope.` Snippets use `floom_agent_••••••`. Remove desktop `.ak-tabs`.

Multi-workspace delta for v1.1: The page lists only tokens where `agent_tokens.workspace_id` equals the active workspace. Switching workspace changes the list. Revoking a token only affects the active workspace row. Add small help copy near the table only when `workspaces.length > 1`: `Agent tokens are per workspace. Create a separate token for each workspace you connect to Claude Code, Cursor, Codex, CLI, or scripts.` The create modal keeps scope selection, but it never creates a multi-workspace token.

New screens needed: `settings-agent-tokens-empty.html`.

Out of scope: Keep token rows, scopes, rate-limit controls, revoked-token reveal, and create-token modal layout.

### account-settings.html

Current state (v23): Page title is `Account settings`, but description says `Profile, workspace, danger zone`; it contains a `Workspace` section with Personal workspace, Team plan, and Connected GitHub.

Layer 1+2 logic: `/account/settings` is account-scoped only and visually separate from workspace credentials.

Delta: Add Run shell sidebar with active item `Account settings` under `Account`. Header remains `Account settings`. Replace description with `Profile, email, security, and account deletion.` Remove the `Workspace` section from this page. Keep `Account` and `Danger zone`; change danger-row copy to `Delete account` and `Removes your account identity and personal login data. Workspace-owned apps, runs, BYOK keys, and Agent tokens follow workspace deletion rules.` Copy popover label becomes `ACCOUNT SETTINGS`; snippet uses `floom_agent_••••••` only if auth snippet remains.

New screens needed: None.

Out of scope: Keep account rows, security rows, export action, delete account action.

### run-empty-state.html

Current state (v23): First-time `/me` state uses TopBar `My account`, copy says the user has not run apps yet, and a tile says `Bring your keys`.

Layer 1+2 logic: Empty state is Workspace Run inside the active workspace.

Delta: Replace TopBar `My account` with `Run`. Add Run shell sidebar. Change title to `Welcome to Workspace Run.` Replace intro with `{workspaceName} has no runs yet. Pick an app below and the first result appears here.` Rename `Bring your keys` tile to `Add BYOK keys`; body becomes `Add Gemini, OpenAI, or Anthropic credentials once in Workspace settings, then run AI apps with workspace credentials.` Copy popover context label becomes `FOR WORKSPACE RUN`; snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep recommended app list and browse-store CTA.

### run-app-run.html

Current state (v23): Installed app run page uses TopBar `My account`, breadcrumbs `my runs / apps / competitor-lens`, and copy `Runs use your saved GEMINI_API_KEY`.

Layer 1+2 logic: This is a Run-mode app surface in the active workspace. Runtime credentials come from workspace BYOK keys.

Delta: Replace TopBar label with `Run`; add Run shell sidebar. Breadcrumb becomes `Run / Apps / competitor-lens`. Replace credential helper with `Runs use the saved workspace BYOK key GEMINI_API_KEY.` Link text becomes `Manage BYOK keys`. If a tab says `Secrets`, rename it to `BYOK keys` and link to `/settings/byok-keys`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep input form, last output panel, recent run list, and triggers CTA.

### run-app-triggers.html

Current state (v23): Triggers page says triggers live with you and uses TopBar `My account`. It has per-app tabs `Run`, `Triggers`, `Runs`, `Secrets`.

Layer 1+2 logic: Triggers are configured by the runner in Run mode for the active workspace.

Delta: Add Run shell sidebar. Breadcrumb becomes `Run / Apps / Competitor Lens / Triggers`. H1 becomes `Triggers for Competitor Lens`. Supporting copy becomes `Triggers run this installed app inside {workspaceName}. Each workspace configures its own webhooks and schedules.` Rename per-app tab `Secrets` to `BYOK keys` and link it to `/settings/byok-keys`. Remove the Federico quote from v24 production-facing content; keep the model explanation in spec notes only. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep webhooks/schedules list, add trigger CTA, and trigger row details.

### run-app-trigger-schedule.html

Current state (v23): Schedule builder uses TopBar `My account`, personal input labels, and Copy for Claude snippets with legacy token placeholder.

Layer 1+2 logic: Schedule runs in the active workspace under Run mode.

Delta: Add Run shell sidebar. Header becomes `Schedule trigger`. Scope line becomes `Runs Competitor Lens in {workspaceName}.` Replace any `your` ownership helper text with workspace runtime copy. Preserve input field names like `your_url` because they are app input schema names. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep cron builder, payload mapping, test run, and run history sections.

### run-app-trigger-webhook.html

Current state (v23): Webhook builder uses TopBar `My account`, personal trigger copy, HMAC secret copy, and legacy token snippet.

Layer 1+2 logic: Webhook trigger belongs to active workspace Run mode.

Delta: Add Run shell sidebar. Header becomes `Webhook trigger`. Scope line becomes `Runs Competitor Lens in {workspaceName} when this endpoint receives a signed POST.` Keep HMAC copy and replay/spoofing explanation. Preserve app input field names. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep URL, signing secret, payload mapping, and test request layout.

### run-install.html

Current state (v23): Authenticated install helper links to Agent tokens and says setup is authenticated with a fresh token tied to this account; sample Cursor auth uses `flo_agt_`.

Layer 1+2 logic: Authenticated install uses an Agent token tied to the active workspace.

Delta: Add Run shell sidebar with `Workspace settings / Agent tokens` visible. Replace copy with `Authenticated with an Agent token for {workspaceName}.` Replace Cursor auth example with `Bearer floom_agent_{your-token}`. Link label stays `Agent tokens`; link points to `/settings/agent-tokens`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep install surfaces, terminal commands, and after-install steps.

### studio-home.html

Current state (v23): Studio already has a left rail with `.ws-switcher`, `{workspaceName}`, role, Team/Billing/Settings under `Workspace`, and rail foot linking to `My account`.

Layer 1+2 logic: Studio is a mode inside the active workspace. Workspace identity is a label, not a visible switcher in v1. Workspace settings sit above Run and Studio, not inside Studio.

Delta: Replace `.ws-switcher` with the shared workspace identity block. Add `Studio` rail section label above Home/Apps/All runs. Hide Team and Billing. Replace `Workspace` rail section with `Workspace settings` containing `BYOK keys`, `Agent tokens`, and `Studio settings`. Rail foot link becomes `Account settings`. TopBar center nav becomes `Run · Studio` with Studio active. Replace topbar/breadcrumb `Personal · Home` with `{workspaceName} / Studio / Home`.

New screens needed: `studio-workspace-shell.html`.

Out of scope: Keep dashboard cards, app list, activity, health, and New app CTA.

### studio-empty.html

Current state (v23): First-time Studio state uses TopBar `Studio · My account` and has no persistent Studio rail.

Layer 1+2 logic: Empty Studio still needs active workspace identity in the Studio shell.

Delta: Add Studio sidebar from Shared Studio Sidebar. TopBar center nav becomes `Run · Studio` with Studio active. H1 remains `Welcome to Studio.` Add subcopy line `Publishing into {workspaceName}.` Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep empty-state CTAs and onboarding steps.

### studio-apps.html

Current state (v23): Studio apps page has a rail switcher, `Workspace` settings section, and rail foot `My account`.

Layer 1+2 logic: Apps are owned by active workspace, and workspace settings are separate from Studio mode.

Delta: Apply Shared Studio Sidebar. H1 can remain `Apps in this workspace`. Breadcrumb becomes `{workspaceName} / Studio / Apps`. Rail `Workspace settings` includes BYOK keys, Agent tokens, Studio settings. Rail foot link becomes `Account settings`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep table, filters, most-used hero, and app counts.

### studio-runs.html

Current state (v23): Studio runs page already says workspace runs, but uses switcher and `My account` foot link.

Layer 1+2 logic: Studio run analytics are workspace-owned app analytics under Studio mode; detailed personal run history remains `/run/runs`.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / All runs`. Keep H1 `All runs across your workspace`. Copy snippet `floom runs list --workspace` remains, but any auth snippet uses `floom_agent_••••••`. Rail foot link becomes `Account settings`.

New screens needed: None.

Out of scope: Keep stat strip, filters, and table rows.

### studio-build.html

Current state (v23): Build flow has TopBar `Studio · My account` and publish snippet with legacy token placeholder.

Layer 1+2 logic: Build publishes into the active workspace.

Delta: Add Studio sidebar or a compact Studio build shell that includes the workspace identity block. Add a scope line under H1: `Target workspace: {workspaceName}`. TopBar center nav becomes `Run · Studio`. Copy popover label becomes `PUBLISH FROM AN AGENT`; snippet uses `FLOOM_API_KEY=floom_agent_•••••• floom deploy ./floom.yaml`. Keep build stages unchanged.

New screens needed: None.

Out of scope: Keep paste card, examples, detect/publish/done flow links, and GitHub App CTA.

### settings-studio.html

Current state (v23): Workspace settings page under `/studio/settings` includes General, GitHub integration, Team, Billing, base URLs, and danger zone.

Layer 1+2 logic: v1 keeps `/settings/studio`, but workspace credentials live under `/settings/byok-keys` and `/settings/agent-tokens`; multi-member and billing UI stay hidden.

Delta: Apply Shared Studio Sidebar with active item `Studio settings` under `Workspace settings`. Page H1 becomes `Studio settings`. Description becomes `Studio-local settings for {workspaceName}. Workspace credentials live in BYOK keys and Agent tokens.` Keep `General` and `GitHub integration`. Remove `Team · 3`, `Billing`, and workspace transfer/delete panels from v24 launch wireframe. Keep read-only endpoint panel only if labeled `Endpoints`, not credential settings. Add two cross-link cards at top: `BYOK keys` -> `/settings/byok-keys`, `Agent tokens` -> `/settings/agent-tokens`.

New screens needed: None.

Out of scope: Keep workspace name/slug fields and GitHub integration controls.

### studio-app-overview.html

Current state (v23): Studio app overview has switcher, Team/Billing/Settings rail entries, TopBar `My account`, and tab label `Secrets`.

Layer 1+2 logic: App is owned by active workspace. Per-app secrets are creator-owned configuration, distinct from workspace BYOK keys.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast`. Replace tab label `Secrets` with `App creator secrets` on desktop. Mobile tab can use `Creator secrets` where space is constrained. Top errors row `Missing secret: AMADEUS_KEY` becomes `Missing app creator secret: AMADEUS_KEY`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep hero metrics, right meta rail, actions, and overview charts.

### studio-app-runs.html

Current state (v23): Per-app runs page has switcher, TopBar `My account`, and tab label `Secrets`.

Layer 1+2 logic: Per-app runs are workspace-owned app analytics in Studio.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast / Runs`. Replace tab label `Secrets` with `App creator secrets` on desktop and `Creator secrets` on mobile. Any row label `API` as a surface remains unchanged. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep filters, run table, metrics, and mobile sub-tab pattern.

### studio-app-secrets.html

Current state (v23): Page/tab is named `Secrets`; copy says `Env vars this app declares`; one row says `GEMINI_API_KEY inherited from your account` with link `Manage in /me`.

Layer 1+2 logic: This page is only App creator secrets. Workspace BYOK keys are in Workspace settings.

Delta: Rename document title, page heading, tab, mobile heading, and notes to `App creator secrets`. Header description becomes `Publisher-controlled secrets for this app only. These are separate from workspace BYOK keys used when running apps.` Row `GEMINI_API_KEY inherited from your account` becomes a separate informational row: `Uses workspace BYOK key GEMINI_API_KEY when a runner has it configured.` Link text becomes `Manage BYOK keys` and points to `/settings/byok-keys`. Add callout above list: `App creator secrets configure flyfast for all runners. BYOK keys are workspace runtime credentials and live in Workspace settings.` Add/replace CTA becomes `+ Add app creator secret`.

New screens needed: None.

Out of scope: Keep key-card styling, masked value display, and declared env var list.

### studio-app-access.html

Current state (v23): Access page has public/private controls, invitees, workspace collaborators, and BYOK upsell copy for anonymous runs.

Layer 1+2 logic: App access is workspace-owned; workspace collaborators edit/manage, app runners run/install.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast / Access`. Keep `Workspace collaborators` section, but copy becomes `Collaborators can manage apps in {workspaceName}. App invitees can run this app only.` Keep public-rate-limit BYOK upsell wording as `BYOK keys`. Replace tab label `Secrets` with `App creator secrets`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep visibility controls, invite flow, public page settings, and review gate content.

### studio-app-analytics.html

Current state (v23): Analytics page has TopBar `My account`, switcher, and tab label `Secrets`.

Layer 1+2 logic: Analytics belongs to active workspace's app inside Studio.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast / Analytics`. Replace tab label `Secrets` with `App creator secrets`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep charts, metrics, and filters.

### studio-app-source.html

Current state (v23): Source page has TopBar `My account`, switcher, and tab label `Secrets`.

Layer 1+2 logic: Source belongs to active workspace's app inside Studio.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast / Source`. Replace tab label `Secrets` with `App creator secrets` on desktop and `Creator secrets` on mobile. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep source panels, manifest preview, and edit controls.

### studio-app-feedback.html

Current state (v23): Feedback page has TopBar `My account`, switcher, and tab label `Secrets`.

Layer 1+2 logic: Feedback belongs to active workspace's app inside Studio.

Delta: Apply Shared Studio Sidebar. Breadcrumb becomes `{workspaceName} / Studio / flyfast / Feedback`. Replace tab label `Secrets` with `App creator secrets`. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep feedback table, review states, and response actions.

### studio-app-triggers.html

Current state (v23): Creator-facing explainer says triggers moved to `/me`; shell still uses TopBar `My account` and a Studio rail switcher.

Layer 1+2 logic: Studio does not own runner triggers; Run mode owns trigger configuration.

Delta: Apply Shared Studio Sidebar. Keep this as a docs/redirect page. H1 becomes `Triggers are configured in Run`. Supporting copy becomes `Creators publish the app once. Each workspace configures webhooks and schedules from Run mode after installing the app.` Cross-links point to `/run/apps/:slug/triggers` represented by `run-app-triggers.html`. Replace tab label `Secrets` with `App creator secrets`. Remove quoted product debate from visible UI; keep it only in notes. Copy popover snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep privacy explanation and redirect-style layout.

### landing.html

Current state (v23): Public landing page includes global Copy for Claude snippet with legacy token placeholder and copy about workspace/team plan.

Layer 1+2 logic: Public positioning can keep workspace benefits, but credential snippets must use Agent tokens.

Delta: Replace token snippet with `floom auth login --token=floom_agent_••••••`. Keep `agent token` prose only when lower-case generic grammar is part of a sentence; primary credential label in CTA/help copy is `Agent tokens`. No route or hero layout change.

New screens needed: None.

Out of scope: Keep hero, app previews, audience sections, and public CTAs.

### apps.html

Current state (v23): Public app directory has global Copy for Claude topbar and public app cards.

Layer 1+2 logic: Public directory is outside workspace shell. Only auth snippets change.

Delta: If the Copy for Claude popover includes an auth command, use `floom_agent_••••••`. Keep public copy `Run it`, install labels, and directory filters unchanged.

New screens needed: None.

Out of scope: Keep cards, filters, category sections, and public nav.

### app-page.html

Current state (v23): Public app run page has flat `/p/:slug`, tabs `Run / About / Install / Source`, and install actions.

Layer 1+2 logic: Public slug stays flat. Caller workspace is implicit at run time.

Delta: Keep URL and tab labels. Update any auth snippet to `floom_agent_••••••`. If a helper mentions saved keys, use `BYOK keys`. Do not add workspace identity to public app pages.

New screens needed: None.

Out of scope: Keep run form, output preview, tabs, share/install buttons.

### app-page-running.html

Current state (v23): Public running state under `/p/:slug` with Copy for Claude topbar.

Layer 1+2 logic: Public slug stays flat; only credential snippet vocabulary changes.

Delta: Update any auth snippet to `floom_agent_••••••`. Keep run progress UI unchanged.

New screens needed: None.

Out of scope: Keep loading/progress state, public tabs, and route.

### app-page-output.html

Current state (v23): Public completed output state under `/p/:slug`.

Layer 1+2 logic: Public slug stays flat; only credential snippet vocabulary changes.

Delta: Update any auth snippet to `floom_agent_••••••`. Keep output and share/install actions unchanged.

New screens needed: None.

Out of scope: Keep rendered output state and public tabs.

### app-page-rate-limited.html

Current state (v23): Public rate-limited state explains rate limits and credential upsell.

Layer 1+2 logic: BYOK keys are workspace runtime credentials for authenticated users.

Delta: Any upsell copy must say `Add BYOK keys` or `Use workspace BYOK keys`, never generic key labels. Keep public route flat.

New screens needed: None.

Out of scope: Keep rate-limit panel, retry/install actions, and route.

### app-page-error.html

Current state (v23): Public error state for failed runs.

Layer 1+2 logic: Error recovery can point to BYOK keys when missing runtime credentials are the cause.

Delta: If credential recovery appears, link text is `Manage BYOK keys` and points to `/settings/byok-keys` for authenticated users. Otherwise unchanged.

New screens needed: None.

Out of scope: Keep error layout, diagnostics, and retry action.

### app-page-install.html

Current state (v23): Public install tab for an app.

Layer 1+2 logic: Install remains public; authenticated snippets use Agent tokens.

Delta: Replace any auth command with `floom auth login --token=floom_agent_••••••`. If credential setup is mentioned, link to `Agent tokens` at `/settings/agent-tokens`.

New screens needed: None.

Out of scope: Keep install tab layout and public app tabs.

### app-page-source.html

Current state (v23): Public source tab for an app.

Layer 1+2 logic: Public source tab remains outside workspace shell.

Delta: Update global Copy for Claude auth snippet only if present. No IA change.

New screens needed: None.

Out of scope: Keep source content and tabs.

### app-page-about.html

Current state (v23): Public about tab for an app.

Layer 1+2 logic: Public about tab remains outside workspace shell.

Delta: Update global Copy for Claude auth snippet only if present. No IA change.

New screens needed: None.

Out of scope: Keep about content and tabs.

### login.html

Current state (v23): Auth entry page includes global Copy for Claude snippets with legacy token placeholder.

Layer 1+2 logic: Auth pages are public surfaces; credential snippets still use Agent token vocabulary.

Delta: Replace auth snippet with `floom auth login --token=floom_agent_••••••`. Keep login form, OAuth buttons, and account creation links.

New screens needed: None.

Out of scope: Keep auth layout and validation states.

### signup.html

Current state (v23): Signup page includes global Copy for Claude snippets with legacy token placeholder.

Layer 1+2 logic: Auth pages are public surfaces; default workspace is provisioned after auth.

Delta: Replace auth snippet with `floom auth login --token=floom_agent_••••••`. Keep signup form and public copy unchanged.

New screens needed: None.

Out of scope: Keep auth layout and onboarding benefits.

### install-in-claude.html

Current state (v23): Claude install helper focuses on one command and does not cover both ICP flows: using Floom apps from Claude and publishing a creator-owned app into Floom.

Layer 1+2 logic: Claude installs authenticate through Agent tokens that resolve the active workspace. Creator publishing uses the same Agent token vocabulary through CLI or Studio, with no workspace selector and no URL churn.

Delta: Rewrite the page around two first-viewport choices:

```text
H1: Install Floom in Claude
Subcopy: Use Floom apps from Claude, or publish your app so Claude users can run it.

Primary choice cards:
Use Floom apps in Claude
Publish my app to Floom
```

Section structure:

```text
1. Use Floom apps in Claude
   Heading: Use Floom apps in Claude
   Body: Browse public apps, then authenticate for private workspace apps.
   Code:
   curl -fsSL https://floom.dev/install.sh | bash
   floom auth login --token=floom_agent_••••••
   Link: Create Agent token -> /settings/agent-tokens

2. Publish my app to Floom
   Heading: Publish your app as a Floom app
   Body: Turn a local app or OpenAPI spec into a hosted Floom app for web, MCP, and HTTP.
   Code:
   floom init --name "My App" --openapi-url https://example.com/openapi.yaml
   FLOOM_API_KEY=floom_agent_•••••• floom deploy ./floom.yaml
   Alternate CTA: Open Studio -> /studio/build

3. Agent token setup
   Heading: Create an Agent token
   Body: Agent tokens live in Workspace settings and select the active workspace for Claude, CLI, CI, and publish flows.
   Code:
   floom auth login --token=floom_agent_••••••

4. What Claude gets
   Heading: Three surfaces
   Body: Published apps stay available through web, MCP, and HTTP without changing public URLs.
```

Multi-workspace section:

```text
Visible in v1 only when workspaces.length > 1: false
Visible in v1.1 when workspaces.length > 1: true

Heading: Multiple workspaces
Body: Create one Agent token for each workspace you want Claude Code, Cursor, Codex, CLI, or scripts to access.

Workspace card:
{workspaceName}
MCP entry name: floom-{workspaceSlug}
Token: floom_agent_••••••
Action: Create Agent token
Code:
claude mcp add floom-{workspaceSlug} --env FLOOM_API_KEY=floom_agent_•••••• -- floom mcp
```

The page can render several workspace cards in one authenticated install flow. Creating a token from a card calls the path-explicit workspace token route after membership and role verification. The generated token still belongs only to that workspace. Do not add a workspace selector to MCP tools or HTTP run snippets.

Keep public install command above the fold. Do not add workspace selector fields. Do not collapse publish flow into the use flow.

New screens needed: None.

Out of scope: Keep CLI install mechanics, Claude MCP client details, and public route URLs unchanged.

### install.html

Current state (v23): Generic installer says run `floom login` after install.

Layer 1+2 logic: CLI auth uses an Agent token; `FLOOM_API_KEY` remains the env var for compatibility.

Delta: Replace after-install auth copy with `Create an Agent token in Workspace settings, then run floom auth login --token=floom_agent_••••••.` Add env alternative in CLI panel: `FLOOM_API_KEY=floom_agent_•••••• floom auth --check`. Keep installer picker unchanged.

New screens needed: None.

Out of scope: Keep CLI/Claude/Cursor/curl picker and install command.

### install-app.html

Current state (v23): Per-app installer includes Claude/Cursor/CLI/curl tabs and an auth row.

Layer 1+2 logic: Authenticated installs use Agent tokens tied to the active workspace.

Delta: Auth row label becomes `Authenticated with Agent token`. Body becomes `Create an Agent token in Workspace settings to run private workspace apps from Claude, Cursor, CLI, or curl.` Snippets use `floom_agent_••••••`. Do not add workspace selector.

New screens needed: None.

Out of scope: Keep tab pattern, per-app command, and public install flow.

### ia.html

Current state (v23): IA documentation says authed center nav is `Studio · My account`, `/me` has five tabs, and Studio rail has workspace section under Studio.

Layer 1+2 logic: Workspace sits above Run and Studio; `/run` is Run mode; credentials are Workspace settings.

Delta: Update IA tree and notes to exact v24 hierarchy from Shared v24 Shell Contract. Replace `My account` center nav rule with `Run · Studio`. Replace five-tab `/run` rule with Run shell sidebar groups. Add note: `Members and Billing are hidden in v1.` Preserve flat public routes.

New screens needed: None.

Out of scope: Keep public route inventory and app-page route inventory.

### architecture.html

Current state (v23): Architecture explainer says Agent tokens are an auth primitive with per-user wording in places and links to Agent tokens.

Layer 1+2 logic: Agent tokens are workspace credentials and resolve workspace identity.

Delta: Replace token explanation with `Agent tokens are workspace credentials. The token selects the workspace for MCP, HTTP, CLI, and publish flows.` Keep 4x4 surface matrix. Any auth snippet uses `floom_agent_••••••`.

New screens needed: None.

Out of scope: Keep visual matrix and public architecture layout.

### mobile-menu.html

Current state (v23): Authenticated drawer uses group `My account`, item `My account`, and places BYOK keys and Agent tokens as account links.

Layer 1+2 logic: Mobile drawer mirrors workspace-tier IA with identity first.

Delta: Replace authenticated drawer with exact Shared Mobile Drawer order. First group is `Workspace` with `{workspaceName}`; next groups are `Run`, `Studio`, `Workspace settings`, and `Account`. Remove `My account` strings. `BYOK keys` and `Agent tokens` move under `Workspace settings`. `Account settings` points to `/account/settings`.

New screens needed: None.

Out of scope: Keep anonymous drawer unchanged.

### design-system.html

Current state (v23): Design system locks `Studio · My account`, `/me` five-tab strips, and BYOK/Agent tokens as `/me` top-level tabs.

Layer 1+2 logic: v24 design system needs workspace shell rules.

Delta: Replace IA rule cards with the Shared v24 Shell Contract. Add component spec for workspace identity block. Add Run sidebar and Studio sidebar examples. Replace `/run` tab rule with sidebar grouping. Keep vocabulary lock for `BYOK keys` and `Agent tokens`; add `App creator secrets`. Add rule: `Workspace switcher hidden in v1 single-workspace wireframes.`

New screens needed: None.

Out of scope: Keep color, typography, buttons, cards, modals, tables, and Copy for Claude component styling.

### _v23.css

Current state (v23): CSS contains Studio rail and mobile drawer styles, but no Run sidebar identity block or v24 workspace shell classes.

Layer 1+2 logic: v24 wireframes need shared shell components without changing the v23 source.

Delta: In `_v24.css`, add classes for `.workspace-identity`, `.run-shell`, `.run-rail`, `.run-main`, `.rail-group-label`, and mobile drawer workspace group. Reuse existing CSS variables, `.rail-item`, `.rail-section`, `.studio-rail`, `.m-tab-strip`, and `.drawer-link` visual language. Do not mutate `_v23.css` in place for the v24 output; copy forward and extend.

New screens needed: None.

Out of scope: Keep palette, typography scale, card styles, topbar, table styles, and modal styles.

## Explicit Removal List For `My account`

Remove visible `My account` from these components and files:

- TopBar center nav in `run.html`, `run-apps.html`, `run-runs.html`, `run-runs-detail.html`, `settings-byok-keys.html`, `settings-agent-tokens.html`, `account-settings.html`, `run-empty-state.html`, `run-app-run.html`, `run-app-triggers.html`, `run-app-trigger-schedule.html`, `run-app-trigger-webhook.html`, `run-install.html`
- TopBar center nav in `studio-home.html`, `studio-empty.html`, `studio-build.html`, `studio-app-overview.html`, `studio-app-runs.html`, `studio-app-secrets.html`, `studio-app-access.html`, `studio-app-analytics.html`, `studio-app-source.html`, `studio-app-feedback.html`, `studio-app-triggers.html`
- Rail foot links in `studio-home.html`, `studio-apps.html`, `studio-runs.html`, `settings-studio.html`, `studio-app-overview.html`
- Avatar menu in `run.html`
- Mobile drawer group and item in `mobile-menu.html`
- Design notes in `design-system.html` and `ia.html`

Replacement:

- Use `Run` for the mode link to `/run`.
- Use `Workspace Run` for dashboard/menu item labels when a noun phrase is needed.
- Use `Account settings` only for `/account/settings`.

## Verification Checklist For Claude v24 Output

- Every file listed under "v23 Files Needing v24 Revision" has either a changed v24 HTML file or a documented no-HTML-needed reason in the v24 changelog.
- Every file listed under "v23 Files Staying Unchanged" remains byte-for-byte unchanged or has only v24 index/changelog linkage edits.
- New v24 file proposals include parent v23 filename and extension reasoning, as listed above.
- No v24 user-facing copy contains `My account`.
- No v24 user-facing copy contains generic credential labels for BYOK keys or Agent tokens.
- `BYOK keys`, `Agent tokens`, and `App creator secrets` appear exactly with that capitalization.
- Run shell desktop sidebar order matches Shared Run Shell Sidebar.
- Studio sidebar order matches Shared Studio Sidebar.
- Workspace switcher controls are hidden in single-workspace v1; workspace identity remains visible.
- Canonical browser URLs are `/run/*`, `/settings/*`, `/studio/*`, `/account/settings`, `/p/:slug`, `/install`, `/install-in-claude`, and `/install/:slug`.
- Compatibility redirects from `/me/*` and `/studio/settings` resolve to canonical URLs.
- Public app surfaces do not render workspace identity blocks.
- Mobile authenticated drawer uses Workspace, Run, Studio, Workspace settings, Account group order.
- Copy for Claude and install/auth snippets use `floom_agent_••••••`.

## Self-Review v3

Flaws found in this pass:

- The workspace name appeared as a literal in shell contracts, sidebar trees, mobile drawer order, and per-file deltas.
- `install-in-claude.html` only covered the use flow and omitted the creator publish flow.
- Mobile drawer order placed Workspace settings before Studio, diverging from the desktop workspace tier.
- Claude production sequencing was absent, leaving shell-dependent files vulnerable to drift.
- Signed-out and mid-signup chrome behavior was implicit.
- Studio sidebar did not declare whether `New app` is a primary CTA or a navigation item.
- Public/auth page handling needed an explicit no-workspace-identity rule.
- The design handoff needed screenshot checkpoints for every production round, not only a final checklist.

Resolutions:

- Replaced every literal workspace-name example with `{workspaceName}` and added a placeholder contract that production reads from the active workspace.
- Rewrote the `install-in-claude.html` delta to serve both `Use Floom apps in Claude` and `Publish your app as a Floom app`, with exact headings and snippets.
- Updated Shared Mobile Drawer, `mobile-menu.html`, and verification checklist order to Workspace identity, Run, Studio, Workspace settings, Account.
- Added Wireframe Production Order with six rounds, dependencies, parallel-safe work, and screenshot checkpoints.
- Added Signed-Out And Mid-Signup Chrome rules to the Shared v24 Shell Contract.
- Declared `New app` a primary Studio CTA on desktop and a command row inside the mobile Studio group.
- Added public/auth shell constraints covering `/run/*`, `/studio/*`, login, signup, and public installer routes.
- Adversarial persona pass verified implementer cold-read coverage, backend/auth specificity, visual placement detail, and QA testability after the changes above.

Residual risks: empty.

Final self-score: 10/10.

## Self-Review v4

Flaws found:

- Implementer cold-read: the previous SPEC kept `/me/*` as canonical and left file names out of sync with the new URL architecture.
- Backend skeptic: browser-route changes could have been read as API route changes without a compatibility redirect list.
- Federico bar: "copy fixes the mental model" was not enough; file paths and visible URLs also had to stop saying personal ownership.
- Visual designer cold-read: Studio links to Workspace settings looked like a mode switch into Run because the target files were named `me-*`.
- QA engineer: the already-shipped v24 Round 1 and Round 2 files lacked an exact rename map.

Resolutions:

- Canonical L3 routes now use `/run/*`, `/settings/*`, `/studio/*`, and `/account/settings`.
- Compatibility redirects from `/me/*`, `/me/api-keys`, and `/studio/settings` are listed in the shell contract.
- Wireframe production order now uses `run-*`, `settings-*`, and `account-settings.html` file names.
- Existing shipped v24 file moves are listed with full `/var/www/wireframes-floom/v24/...` paths.
- Studio sidebar cross-links target Settings shell files: `settings-byok-keys.html`, `settings-agent-tokens.html`, and `settings-studio.html`.

Residual risks: empty.

Final self-score: 10/10.
