# v24 Round 5 Wireframe Audit
Date: 2026-04-27
Auditor: Codex
Scope: 17 public + auth files

## Critical Issues (block Round 6)

### install-in-claude.html

- `/var/www/wireframes-floom/v24/install-in-claude.html:88-94` and `/var/www/wireframes-floom/v24/install-in-claude.html:101-106`: authenticated TopBar is `Run | Studio | Agent tokens | avatar`. L3 requires `Run | Studio | Copy for Claude | +New app | avatar` for the authenticated workspace helper shell.
- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `/var/www/wireframes-floom/v24/install-in-claude.html:108`: workspace cards reveal snippets, but their action is a link to `./settings-agent-tokens.html`; no visible path-explicit mint/reveal contract references `/api/workspaces/:id/agent-tokens`.

### Visible Board H1

- `/var/www/wireframes-floom/v24/landing.html:79`, `/var/www/wireframes-floom/v24/apps.html:79`, `/var/www/wireframes-floom/v24/login.html:79`, `/var/www/wireframes-floom/v24/signup.html:79`, `/var/www/wireframes-floom/v24/install-in-claude.html:79`, `/var/www/wireframes-floom/v24/install.html:79`, `/var/www/wireframes-floom/v24/install-app.html:79`, `/var/www/wireframes-floom/v24/ia.html:79`, and `/var/www/wireframes-floom/v24/architecture.html:79`: board H1s include file/page labels plus route text, for example `Landing · /` and `Apps · /apps`. The checklist requires the visible board H1 to be the canonical URL string.
- `/var/www/wireframes-floom/v24/app-page.html:79`, `/var/www/wireframes-floom/v24/app-page-running.html:79`, `/var/www/wireframes-floom/v24/app-page-output.html:79`, `/var/www/wireframes-floom/v24/app-page-rate-limited.html:79`, `/var/www/wireframes-floom/v24/app-page-error.html:79`, `/var/www/wireframes-floom/v24/app-page-install.html:79`, `/var/www/wireframes-floom/v24/app-page-source.html:79`, and `/var/www/wireframes-floom/v24/app-page-about.html:79`: board H1s include state labels such as `Ready`, `Running`, `Output`, `Error`, and tab names around `/p/:slug`; the locked visible board H1 for this family is the canonical route string `/p/:slug`.

### Chrome URL

- `/var/www/wireframes-floom/v24/app-page.html:87`, `/var/www/wireframes-floom/v24/app-page-running.html:87`, `/var/www/wireframes-floom/v24/app-page-output.html:87`, `/var/www/wireframes-floom/v24/app-page-rate-limited.html:87`, `/var/www/wireframes-floom/v24/app-page-error.html:87`, `/var/www/wireframes-floom/v24/app-page-install.html:87`, `/var/www/wireframes-floom/v24/app-page-source.html:87`, and `/var/www/wireframes-floom/v24/app-page-about.html:87`: chrome URL uses placeholder `floom.dev/p/:slug`; the checklist calls for canonical concrete browser URLs such as `floom.dev/p/competitor-lens`.
- `/var/www/wireframes-floom/v24/install-app.html:87`: chrome URL uses placeholder `floom.dev/install/:slug`; this needs the concrete per-app install URL representation.

## Important Issues (fix before Round 6)

### URL Family / IA

- `/var/www/wireframes-floom/v24/ia.html:100` and `/var/www/wireframes-floom/v24/ia.html:116`: IA doc rows list `/studio/:slug` for Studio app overview. L2 routes Studio apps under `/studio/apps/:slug/*`.
- `/var/www/wireframes-floom/v24/ia.html:100` and `/var/www/wireframes-floom/v24/ia.html:116`: IA hierarchy omits `App creator secrets` under Studio app settings, despite the locked vocabulary and L2 Studio app secrets tab naming.
- `/var/www/wireframes-floom/v24/architecture.html:100` and `/var/www/wireframes-floom/v24/architecture.html:116`: architecture explainer covers BYOK keys and Agent tokens, but omits the separate `App creator secrets` credential family from the surface matrix.

### Public TopBar Link Integrity

- Public pages use non-target fragment links for Docs/Pricing instead of real route links or `#wireframe-inert`: `landing.html:92-93,130-131`, `apps.html:92-93,109-110`, `app-page*.html:92-93,109-110`, `login.html:92-93,109-110`, `signup.html:92-93,109-110`, `install.html:92-93,109-110`, `install-app.html:92-93,109-110`, `ia.html:92-93,109-110`, and `architecture.html:92-93,109-110`.
- Verified no literal `href="#"` remains in the 17-file scope, and all `./X.html` links point to files present in `/var/www/wireframes-floom/v24/`.

### install-in-claude.html

- `/var/www/wireframes-floom/v24/install-in-claude.html:92` and `/var/www/wireframes-floom/v24/install-in-claude.html:105`: TopBar CTA says `Agent tokens`; the locked authenticated shell action is `Copy for Claude`.
- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `/var/www/wireframes-floom/v24/install-in-claude.html:108`: multi-workspace cards use placeholder names `{workspaceName}` and `{workspaceName2}`. The requirement says one helper card per workspace the user can access; concrete example workspace names would make the flow easier to verify visually.

### Color / Shared CSS

- `/var/www/wireframes-floom/v24/_v24.css:939-944` and `/var/www/wireframes-floom/v24/_v24.css:986-993`: stale category selector residue remains (`cat-research`, `cat-writing`, `cat-utility`, `cat-sales`, `cat-content`, `cat-travel`, `cat-dev`). The active Round 5 pages do not render category-tint gradients, but the shared stylesheet still carries old category-specific surface hooks.

## Nits (defer)

- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `/var/www/wireframes-floom/v24/install-in-claude.html:108`: long mobile code snippets use horizontally scrollable code blocks; screenshots verify no page overflow, but the mobile snippets are harder to scan than the desktop cards.
- `/var/www/wireframes-floom/v24/apps.html:100` and `/var/www/wireframes-floom/v24/apps.html:116`: mobile filter chips show `All`, `Research`, and `Dev` only, while desktop includes `Writing`, `Travel`, and `Ops`. This is acceptable for a condensed mobile board, but the filter set is not identical across breakpoints.

## Per-file scores (0-10)

10 = no issues. Below 8 = needs rework before Round 6.

- `landing.html`: 8.0. L3 hero copy and token snippets are correct; board H1 is not the exact canonical URL string and Docs/Pricing fragments are inert.
- `apps.html`: 8.0. Filter chips and neutral app cards pass; board H1 and inert Docs/Pricing fragments remain.
- `app-page.html`: 7.0. Token snippet and public TopBar pass; board H1 and chrome URL are noncanonical placeholders.
- `app-page-running.html`: 7.0. Running state and token snippet pass; board H1 and chrome URL are noncanonical placeholders.
- `app-page-output.html`: 7.0. Output state and token snippet pass; board H1 and chrome URL are noncanonical placeholders.
- `app-page-rate-limited.html`: 7.5. BYOK keys upsell copy passes; board H1 and chrome URL are noncanonical placeholders.
- `app-page-error.html`: 7.5. BYOK keys recovery copy passes; board H1 and chrome URL are noncanonical placeholders.
- `app-page-install.html`: 7.0. Agent token install snippet passes; board H1 and chrome URL are noncanonical placeholders.
- `app-page-source.html`: 7.0. Source tab and token snippet pass; board H1 and chrome URL are noncanonical placeholders.
- `app-page-about.html`: 7.0. About tab and token snippet pass; board H1 and chrome URL are noncanonical placeholders.
- `login.html`: 8.0. No workspace identity block and token snippet pass; board H1 and inert Docs/Pricing fragments remain.
- `signup.html`: 8.0. No workspace identity block and token snippet pass; board H1 and inert Docs/Pricing fragments remain.
- `install-in-claude.html`: 6.0. Use+Publish first-viewport cards and `floom_agent_••••••` pass; authenticated TopBar contract and token-mint route contract fail.
- `install.html`: 8.0. Agent token auth copy and env alternative pass; board H1 and inert Docs/Pricing fragments remain.
- `install-app.html`: 7.5. Agent token install copy passes; board H1 and chrome URL use placeholder route.
- `ia.html`: 6.5. Workspace hierarchy is updated and `/me` is gone; Studio app route is wrong, `App creator secrets` is missing, board H1 is decorated, and inert Docs/Pricing fragments remain.
- `architecture.html`: 7.5. Agent token workspace explanation passes; `App creator secrets` is missing, board H1 is decorated, and inert Docs/Pricing fragments remain.

## Round 6 readiness verdict

NO-GO. Round 6 is blocked by install-in-Claude authenticated shell/token-card contract drift, noncanonical visible board H1s, and noncanonical app/install chrome URLs.

## Self-Review v1

- Verified all 17 requested files were read and scored: `landing.html`, `apps.html`, `app-page.html`, `app-page-running.html`, `app-page-output.html`, `app-page-rate-limited.html`, `app-page-error.html`, `app-page-install.html`, `app-page-source.html`, `app-page-about.html`, `login.html`, `signup.html`, `install-in-claude.html`, `install.html`, `install-app.html`, `ia.html`, and `architecture.html`.
- Verified HTML tag balance for `div`, `main`, `section`, `aside`, `header`, `nav`, `button`, `a`, `code`, `li`, `ul`, and `ol`: all 17 files passed.
- Verified source scans for `/me`, `My account`, `your account`, `your workspace`, `tok_••`, `flo_agt_`, `API key`, and `API keys`: no banned visible strings were found in the 17-file scope.
- Verified token snippets use `floom_agent_••••••` where visible; no `tok_••` or `flo_agt_` token placeholders remain in the 17-file scope.
- Verified Playwright screenshots at desktop 1440x900 and mobile 390x844 for all 17 files. Screenshots and metrics are saved in `/tmp/v24-r5-audit/`; `/tmp/v24-r5-audit/metrics.json` records 34 captures and zero console/page errors.
- Verified mobile overflow gate: every mobile file reported `scrollWidth=390` and `clientWidth=390`.
- Verified `pnpm typecheck` in `/root/floom` exited 0 through Turbo: 7 successful tasks, 7 total.
