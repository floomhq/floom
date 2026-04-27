# V26 Wireframe Audit

Date: 2026-04-27
Scope: `/var/www/wireframes-floom/v26/`
Baseline: copied from `/var/www/wireframes-floom/v25/`
Locked spec: `/root/floom/docs/V26-IA-SPEC.md`

## Verdict

PASS with self-review notes.

The v26 wireframes implement the locked IA: authenticated pages use a single WorkspaceRail, authenticated TopBar is slim, `/settings` is tabbed with deep-link variants, `/run` and `/studio` are redirect stubs, Run/Studio app dashboards carry the compact metrics, app store cards expose Run/Fork/Install, public app pages share the canonical chrome, and sharing/rate-limit controls are represented on apps, BYOK keys, and Agent tokens.

## Evidence

| Check | Result |
|---|---:|
| HTML files served at `http://127.0.0.1:8766/v26/*.html` | 53/53 HTTP 200 |
| CSS served at `http://127.0.0.1:8766/v26/_v26.css` | 200 |
| Broken local `.html` links | 0 |
| `<div>` balance | 0 failures |
| Exact banned phrases | 0 matches |
| Gradient leakage (`linear/radial/conic`) | 0 matches |
| Auth pages with WorkspaceRail | 31 |
| Auth pages with old TopBar nav inside primary TopBar | 0 |
| Mobile overflow at 390px across all HTML pages | 0 |
| App-page family canonical chrome checks | 8/8 pass |
| Screenshots captured | 21 in `/tmp/v26-shots/` |

## Screenshots Captured

- Desktop: `landing`, `run-apps`, `studio-apps`, `settings`, `settings-byok-keys`, `settings-agent-tokens`, `settings-studio`, `studio-app-secrets`, `studio-app-access`, `apps`, `app-page`, `app-page-running`, `app-page-output`, `app-page-rate-limited`
- Mobile: `landing`, `run-apps`, `studio-apps`, `settings`, `studio-app-secrets`, `apps`, `app-page-running`

## Spec Compliance Highlights

- Rail: primary authenticated pages now render `workspace-rail` with `{workspaceName} ▾`, `[ Run | Studio ]`, mode-specific Apps/Runs, Studio `New app`, plus persistent App store and Docs.
- TopBar: authenticated primary TopBar removes Run/Studio, Apps, Docs, and Pricing; it keeps floom, Copy for Claude, `+ New app`, and avatar.
- Settings: added `settings.html`; retained `settings-byok-keys.html`, `settings-agent-tokens.html`, and `settings-studio.html` as tabbed deep-link variants.
- Redirects: `run.html` redirects to `run-apps.html`; `studio-home.html` redirects to `studio-apps.html`.
- Run apps: added compact `5 runnable apps · 142 runs this week · 1 running now`, app grid, compact recent runs, and app store CTA.
- Studio apps: added compact `Runs across all your apps · last 7d · 2,847 · ↑18%`, apps table, recent activity, and `+ New app` CTA.
- Studio secrets: split into App creator secrets and Workspace BYOK requirements, including present/missing key states and `/settings/byok-keys` links.
- App store: filter chips are All/Mine/Public/By category; cards expose Run/Fork/Install.
- Sharing/rate limits: `studio-app-access.html`, `settings-byok-keys.html`, and `settings-agent-tokens.html` include visibility and global/per-scope rate-limit controls.
- Landing logged-in state: top banner links to `/run/apps` with `Resume in {workspaceName} →`; TopBar keeps public nav and swaps auth buttons for avatar.

## Per-File Scores

| File | Score | Notes |
|---|---:|---|
| `_v26.css` | 10 | v26 shared tokens, WorkspaceRail, settings tabs, mobile overflow guards |
| `account-settings.html` | 9 | Auth chrome updated; account remains avatar-owned conceptually |
| `app-page.html` | 10 | Canonical public app chrome |
| `app-page-running.html` | 10 | Canonical chrome plus live streaming indicator retained |
| `app-page-output.html` | 10 | Canonical chrome |
| `app-page-rate-limited.html` | 10 | Canonical chrome |
| `app-page-error.html` | 10 | Canonical chrome |
| `app-page-install.html` | 10 | Canonical chrome |
| `app-page-source.html` | 10 | Canonical chrome |
| `app-page-about.html` | 10 | Canonical chrome |
| `apps.html` | 10 | Mode-agnostic store, mixed filters, Run/Fork/Install |
| `landing.html` | 10 | Logged-in resume banner and avatar TopBar variant |
| `run.html` | 10 | Redirect stub to `run-apps.html` |
| `run-apps.html` | 10 | v26 Run dashboard content |
| `run-runs.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-runs-detail.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-empty-state.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-install.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-app-run.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-app-triggers.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-app-trigger-schedule.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-app-trigger-webhook.html` | 9 | WorkspaceRail and slim TopBar applied |
| `settings.html` | 10 | New tabbed default General page |
| `settings-byok-keys.html` | 10 | Tabbed deep link, visibility/rate controls |
| `settings-agent-tokens.html` | 10 | Tabbed deep link, visibility/rate controls |
| `settings-studio.html` | 10 | Tabbed deep link |
| `settings-byok-keys-empty.html` | 9 | Rail/tabs applied |
| `settings-agent-tokens-empty.html` | 9 | Rail/tabs applied |
| `studio-home.html` | 10 | Redirect stub to `studio-apps.html` |
| `studio-apps.html` | 10 | v26 Studio dashboard content |
| `studio-runs.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-build.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-empty.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-overview.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-runs.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-secrets.html` | 10 | Two-section secrets/BYOK requirement model |
| `studio-app-access.html` | 10 | Visibility and rate-limit controls |
| `studio-app-analytics.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-source.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-feedback.html` | 9 | WorkspaceRail and slim TopBar applied |
| `studio-app-triggers.html` | 9 | WorkspaceRail and slim TopBar applied |
| `run-workspace-shell.html` | 9 | Reference shell updated to v26 chrome |
| `studio-workspace-shell.html` | 9 | Reference shell updated to v26 chrome |
| `workspace-settings-shell.html` | 9 | Reference shell updated; mobile overflow fixed |
| `mobile-menu.html` | 10 | Drawer contract updated to v26 order |
| `index.html` | 8 | Board index still references historical rounds |
| `design-system.html` | 8 | Reference content sanitized for banned phrases |
| `ia.html` | 8 | Reference page sanitized for banned phrases |
| `architecture.html` | 8 | Public reference page unchanged except v26/version cleanup |
| `install.html` | 8 | Public install page unchanged except v26/version cleanup |
| `install-app.html` | 8 | Public install page unchanged except v26/version cleanup |
| `install-in-claude.html` | 8 | Public install page unchanged except v26/version cleanup |
| `login.html` | 8 | Public TopBar contract retained |
| `signup.html` | 8 | Public TopBar contract retained |

## Self-Review Notes

- Several lower-priority reference pages still include historical board copy from prior rounds. They pass links, banned-phrase, and mobile checks, but their explanatory text is less clean than the primary product wireframes.
- Empty settings variants received the v26 rail/tabs but did not get the same depth of custom content as the non-empty settings pages.
- The app-page family was verified by DOM checks for the shared outer chrome, not pixel-diffed against a single canonical template.

