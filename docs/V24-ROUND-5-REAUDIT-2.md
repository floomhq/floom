# v24 Round 5 Wireframe Re-Audit 2

Date: 2026-04-27
Auditor: Codex
Scope: 17 Round 5 public + auth files plus shared `/var/www/wireframes-floom/v24/_v24.css`
Audit path: `/tmp/v24-r5-reaudit-2/`

## 15-Rule Checklist Re-Run

1. Exact 17-file scope exists and every file references `./_v24.css`: pass.
2. HTML tag balance across the 17 files: pass.
3. Playwright desktop render at 1440x900 for all 17 files: pass.
4. Playwright mobile render at 390x844 for all 17 files: pass.
5. Mobile horizontal overflow gate: pass. Every mobile capture reported `scrollWidth=390`, `clientWidth=390`, and `bodyScrollWidth=390`.
6. Visible board H1s are route-only canonical strings with no page labels or state labels: pass.
7. Chrome URLs are concrete examples and no longer use `:slug` placeholders: pass.
8. Public TopBar `Docs` and `Pricing` links use `#wireframe-inert`: pass across all public files.
9. Local link integrity: pass. No `href="#"` remains and all `./*.html` targets exist.
10. Locked vocabulary scan for `My account`, `your account`, `your workspace`, `/me/*`, `tok_••`, `flo_agt_`, `API key`, and `API keys`: pass.
11. Agent-token copy and snippets use `floom_agent_••••••`: pass for token vocabulary; fail for snippet rendering because multiple code blocks show literal `\n` escape text.
12. `install-in-claude.html` authenticated TopBar contract `Run | Studio | Copy for Claude | + New app | avatar`: pass for required labels; mobile presentation is crowded.
13. `install-in-claude.html` multi-workspace card contract: partial. Desktop has `Federico's workspace` and `Acme Corp`; mobile has `Acme Corp` twice.
14. IA route family and credential vocabulary: pass. All eight `/studio/apps/:slug/*` routes are present, `/studio/:slug` is gone, and `App creator secrets` is visible.
15. Shared CSS stale category selector cleanup: pass. No `.cat-research`, `.cat-writing`, `.cat-utility`, `.cat-sales`, `.cat-content`, `.cat-travel`, or `.cat-dev` selectors remain.

## Critical

No critical issues remain from `V24-ROUND-5-REAUDIT.md`.

The prior critical blocker in `install-in-claude.html` is resolved at the source-contract level: `{workspaceName}` is gone, concrete workspace names are present, and all four `Create Agent token` anchors carry `data-route="/api/workspaces/:id/agent-tokens"`.

## Important

### `install-in-claude.html` mobile duplicates the same workspace card

- `/var/www/wireframes-floom/v24/install-in-claude.html:96` desktop renders `Federico's workspace` and `Acme Corp`.
- `/var/www/wireframes-floom/v24/install-in-claude.html:108` mobile renders `Acme Corp` twice.
- Screenshot evidence: `/tmp/v24-r5-reaudit-2/install-in-claude-mobile.png`.

This keeps the mobile multi-workspace example below the Round 6 quality bar. The previous placeholder issue is fixed, but the mobile frame no longer proves one token per distinct accessible workspace.

### Command snippets render literal `\n` escape text across multiple files

Playwright screenshots and source scans show visible command snippets with `\n` as text instead of real line breaks. This affects copyability for the core `Copy for Claude`, install, CLI, source, and error examples.

Affected source lines include:

- `/var/www/wireframes-floom/v24/landing.html:116` and `:118`
- `/var/www/wireframes-floom/v24/app-page.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-running.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-output.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-rate-limited.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-error.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-install.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-source.html:100` and `:116`
- `/var/www/wireframes-floom/v24/app-page-about.html:100` and `:116`
- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `:108`
- `/var/www/wireframes-floom/v24/install.html:100` and `:116`
- `/var/www/wireframes-floom/v24/install-app.html:100` and `:116`

Screenshot evidence: `/tmp/v24-r5-reaudit-2/install-in-claude-mobile.png`, `/tmp/v24-r5-reaudit-2/app-page-mobile.png`, and `/tmp/v24-r5-reaudit-2/install-mobile.png`.

### `architecture.html` credential-family note is desktop-only

- `/var/www/wireframes-floom/v24/architecture.html:100-101` desktop includes `App creator secrets` in MCP copy and a three-credential-family note.
- `/var/www/wireframes-floom/v24/architecture.html:117` mobile includes `App creator secrets` in MCP copy, but the three-credential-family note is missing.
- Screenshot evidence: `/tmp/v24-r5-reaudit-2/architecture-mobile.png`.

The previous mobile omission of `App creator secrets` is fixed. The 3-family distinction still fails mobile parity.

## Nits

### `install-in-claude.html` mobile TopBar is visually crowded

The mobile TopBar includes the required `Copy for Claude`, `+ New app`, and avatar actions, but `Copy for Claude` wraps into a tall control and the avatar name is clipped in the rendered frame. Evidence: `/tmp/v24-r5-reaudit-2/install-in-claude-mobile.png`.

### `apps.html` mobile filters remain condensed

Desktop shows `All`, `Research`, `Writing`, `Travel`, `Dev`, and `Ops`; mobile shows only `All`, `Research`, and `Dev`. The app list still exposes Writing and Travel apps, so this remains a small parity nit. Evidence: `/tmp/v24-r5-reaudit-2/apps-mobile.png`.

## Previously Open Items

- `install-in-claude.html` `{workspaceName}` placeholders: resolved. Source scan found zero `{workspaceName}` matches.
- `install-in-claude.html` missing token mint route metadata: resolved. Source scan found four `data-route="/api/workspaces/:id/agent-tokens"` anchors.
- `ia.html` missing Studio app sub-route family: resolved. Source scan found all eight `/studio/apps/:slug`, `/runs`, `/secrets`, `/access`, `/analytics`, `/source`, `/feedback`, and `/triggers` routes.
- `ia.html` missing `App creator secrets`: resolved. Desktop and mobile hierarchy plus doc-tree rows include the term.
- `architecture.html` missing mobile `App creator secrets`: resolved. Mobile MCP card includes the term.
- `architecture.html` three-credential-family coverage: partially resolved. Desktop has the note; mobile does not.
- `_v24.css` stale `.cat-*` selectors: resolved. Source scan found zero matching selectors.

## Per-File Scores

10 = no issue found. Round 6 requires every file at 9.0 or higher.

- `landing.html`: 8.8. Core route, TopBar, link, token vocabulary, screenshot, and overflow checks pass; visible command snippets render literal `\n`.
- `apps.html`: 9.4. Core checks pass; mobile filter set remains condensed.
- `app-page.html`: 8.8. Route and token vocabulary pass; visible command snippets render literal `\n`.
- `app-page-running.html`: 8.8. Running state and route checks pass; visible command snippets render literal `\n`.
- `app-page-output.html`: 8.8. Output state and route checks pass; visible command snippets render literal `\n`.
- `app-page-rate-limited.html`: 8.8. BYOK recovery copy and route checks pass; visible command snippets render literal `\n`.
- `app-page-error.html`: 8.8. Error recovery copy and route checks pass; visible command snippets render literal `\n`.
- `app-page-install.html`: 8.7. Install tab and token vocabulary pass; visible command snippets render literal `\n`.
- `app-page-source.html`: 8.7. Source tab and route checks pass; source and Copy for Claude snippets render literal `\n`.
- `app-page-about.html`: 8.8. About tab and route checks pass; visible command snippets render literal `\n`.
- `login.html`: 9.8. H1, chrome URL, public TopBar, links, locked vocabulary, desktop render, and mobile render pass.
- `signup.html`: 9.8. H1, chrome URL, public TopBar, links, locked vocabulary, desktop render, and mobile render pass.
- `install-in-claude.html`: 8.2. Placeholder and route metadata fixes landed; mobile duplicates `Acme Corp`, snippets render literal `\n`, and the mobile TopBar is crowded.
- `install.html`: 8.8. Route, public TopBar, and token vocabulary pass; install snippets render literal `\n`.
- `install-app.html`: 8.8. Concrete `/install/competitor-lens` route and token vocabulary pass; install snippet renders literal `\n`.
- `ia.html`: 9.6. Full Studio app route family, `App creator secrets`, H1, links, desktop render, and mobile render pass.
- `architecture.html`: 8.7. `App creator secrets` is visible on desktop and mobile; the three-credential-family note is desktop-only.

## Round 6 Verdict

NO-GO.

Round 6 remains blocked because all 17 files are not at 9.0+. The blocker set is now smaller, but `landing.html`, the app-page family, install pages, `install-in-claude.html`, and `architecture.html` remain below the threshold.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r5-reaudit-2/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r5-reaudit-2/*-mobile.png`
- Contact sheets: `/tmp/v24-r5-reaudit-2/contact-desktop.png`, `/tmp/v24-r5-reaudit-2/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r5-reaudit-2/metrics.json`
- Console/page errors: zero across 34 captures.
- Loading states: zero captures matched loading/skeleton text.
- Mobile overflow: all 17 mobile captures reported `390/390/390` for document scroll width, client width, and body scroll width.
- `pnpm typecheck`: passed. Turbo reported `7 successful, 7 total`.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 17 files: `landing.html`, `apps.html`, `app-page.html`, `app-page-running.html`, `app-page-output.html`, `app-page-rate-limited.html`, `app-page-error.html`, `app-page-install.html`, `app-page-source.html`, `app-page-about.html`, `login.html`, `signup.html`, `install-in-claude.html`, `install.html`, `install-app.html`, `ia.html`, and `architecture.html`.
- Verified screenshots show rendered wireframes, not loading states or blank pages.
- Verified source scans for CSS references, HTML balance, canonical H1s, chrome URLs, public TopBar fragments, missing local links, `href="#"`, locked vocabulary, token placeholders, `install-in-claude` workspace names, required `data-route` attributes, IA route strings, `App creator secrets`, stale `.cat-*` selectors, and literal `\n` command-snippet escapes.
- Verified the prior critical items are no longer critical: workspace placeholders are gone and token mint route metadata exists.
- Verified remaining issues with source-line and screenshot evidence: duplicated mobile workspace cards, literal command-snippet escape text, desktop-only architecture credential-family note, crowded mobile TopBar, and condensed mobile app filters.
- Verified `pnpm typecheck` passed.
