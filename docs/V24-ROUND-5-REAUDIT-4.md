# v24 Round 5 Wireframe Re-Audit 4

Date: 2026-04-27
Auditor: Codex
Scope: 17 Round 5 public + auth files plus shared `/var/www/wireframes-floom/v24/_v24.css`
Audit path: `/tmp/v24-r5-reaudit-4/`

## 15-Rule Checklist Re-Run

1. Exact 17-file scope exists and every file references `./_v24.css`: pass.
2. HTML tag balance across the 17 files: pass.
3. Playwright desktop render at 1440x900 for all 17 files: pass.
4. Playwright mobile render at 390x844 for all 17 files: pass.
5. Mobile horizontal overflow gate: pass. Every mobile capture reported `scrollWidth=390`, `clientWidth=390`, and `bodyScrollWidth=390`.
6. Visible board route H1s are route-only canonical strings with no page labels or state labels: pass.
7. Chrome URLs are concrete examples and no longer use `:slug` placeholders: pass.
8. Public TopBar `Docs` and `Pricing` links use `#wireframe-inert`: pass across all public files.
9. Local link integrity: pass. No `href="#"` remains and all `./*.html` targets exist.
10. Locked vocabulary scan for `My account`, `your account`, `your workspace`, `/me/*`, `tok_••`, `flo_agt_`, `API key`, and `API keys`: pass.
11. Agent-token copy and snippets use `floom_agent_••••••`: pass. No legacy token strings and no literal `\n` escapes were found in the scoped snippet files.
12. `install-in-claude.html` authenticated TopBar contract `Run | Studio | Copy for Claude | + New app | avatar`: pass for required labels; mobile remains visually crowded.
13. `install-in-claude.html` multi-workspace card contract: pass. Desktop and mobile each contain `Federico's workspace` and `Acme Corp`; each card has a matching MCP entry name, token placeholder, command snippet, and `data-route="/api/workspaces/:id/agent-tokens"`.
14. IA route family and credential vocabulary: pass. All eight `/studio/apps/:slug/*` routes are present, `/studio/:slug` is gone, and `App creator secrets` is visible.
15. Shared CSS stale category selector cleanup: pass. No `.cat-research`, `.cat-writing`, `.cat-utility`, `.cat-sales`, `.cat-content`, `.cat-travel`, or `.cat-dev` selectors remain.

## Critical

No critical issues found.

## Important

No important issues found.

The prior blocker in `install-in-claude.html` is resolved. Scoped DOM verification found:

- Desktop workspace cards: `Federico's workspace`, `Acme Corp`.
- Mobile workspace cards: `Federico's workspace`, `Acme Corp`.
- All four workspace-card divs are internally consistent: card title, MCP entry name, token placeholder, command snippet, and token-mint route metadata match the card workspace.

Evidence:

- `/tmp/v24-r5-reaudit-4/install-in-claude-desktop.png`
- `/tmp/v24-r5-reaudit-4/install-in-claude-mobile.png`
- `/tmp/v24-r5-reaudit-4/metrics.json`

## Nits

### `install-in-claude.html` mobile TopBar remains crowded

The required mobile TopBar actions render, but `Copy for Claude` wraps into a tall control and the avatar label is clipped in the 390px capture. Evidence: `/tmp/v24-r5-reaudit-4/install-in-claude-mobile.png`.

### `apps.html` mobile filters remain condensed

Desktop shows `All`, `Research`, `Writing`, `Travel`, `Dev`, and `Ops`; mobile shows only `All`, `Research`, and `Dev`. The app list still includes Writing and Travel cards, so this remains a small parity nit. Evidence: `/tmp/v24-r5-reaudit-4/apps-mobile.png`.

### `architecture.html` mobile credential note is dense

The requested three-credential-family note is visible on mobile, including BYOK keys, Agent tokens, and App creator secrets. It is packed into the MCP card instead of the credential-card section, which makes it harder to scan than the desktop treatment. Evidence: `/tmp/v24-r5-reaudit-4/architecture-mobile.png`.

## Per-File Scores

10 = no issue found. Round 6 requires every file at 9.0 or higher.

- `landing.html`: 9.8. CSS, H1, chrome URL, public TopBar links, local links, token vocabulary, desktop render, mobile render, overflow, and snippet newline checks pass.
- `apps.html`: 9.4. Core checks pass; mobile filters remain condensed.
- `app-page.html`: 9.7. Core route, state, tabs, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-running.html`: 9.7. Running state, route, tabs, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-output.html`: 9.7. Output state, route, tabs, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-rate-limited.html`: 9.7. BYOK recovery copy, route, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-error.html`: 9.7. Error recovery copy, route, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-install.html`: 9.7. Install tab, concrete route, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-source.html`: 9.7. Source tab, route, links, source snippet, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `app-page-about.html`: 9.7. About tab, route, links, token copy, desktop render, mobile render, overflow, and snippet newline checks pass.
- `login.html`: 9.8. H1, chrome URL, public TopBar, links, locked vocabulary, desktop render, mobile render, and overflow checks pass.
- `signup.html`: 9.8. H1, chrome URL, public TopBar, links, locked vocabulary, desktop render, mobile render, and overflow checks pass.
- `install-in-claude.html`: 9.4. Workspace-card blocker is resolved; placeholders, route metadata, token vocabulary, snippets, desktop render, mobile render, and overflow checks pass. Mobile TopBar crowding remains a nit.
- `install.html`: 9.7. Route, public TopBar, links, token vocabulary, install snippets, desktop render, mobile render, overflow, and snippet newline checks pass.
- `install-app.html`: 9.7. Concrete `/install/competitor-lens` route, public TopBar, links, token vocabulary, install snippets, desktop render, mobile render, overflow, and snippet newline checks pass.
- `ia.html`: 9.7. Full Studio app route family, `App creator secrets`, H1, links, desktop render, mobile render, overflow, and stale `/studio/:slug` cleanup checks pass.
- `architecture.html`: 9.4. `App creator secrets` and the three credential families are visible on desktop and mobile; the mobile note remains dense inside the MCP card.

## Round 6 Verdict

GO.

All 17 files score 9.0 or higher. The previous Round 6 blocker in `install-in-claude.html` is resolved on both desktop and mobile.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r5-reaudit-4/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r5-reaudit-4/*-mobile.png`
- Contact sheets: `/tmp/v24-r5-reaudit-4/contact-desktop.png`, `/tmp/v24-r5-reaudit-4/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r5-reaudit-4/metrics.json`
- Console/page errors: zero across 34 captures.
- Loading states: zero captures matched loading, skeleton, or spinner text.
- Mobile overflow: all 17 mobile captures reported `390/390/390` for document scroll width, client width, and body scroll width.
- `pnpm typecheck`: passed. Turbo reported `7 successful, 7 total`.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 17 files: `landing.html`, `apps.html`, `app-page.html`, `app-page-running.html`, `app-page-output.html`, `app-page-rate-limited.html`, `app-page-error.html`, `app-page-install.html`, `app-page-source.html`, `app-page-about.html`, `login.html`, `signup.html`, `install-in-claude.html`, `install.html`, `install-app.html`, `ia.html`, and `architecture.html`.
- Verified screenshots show rendered wireframes, not loading states or blank pages.
- Verified source scans for CSS references, HTML balance, canonical route H1s, chrome URLs, public TopBar fragments, missing local links, `href="#"`, locked vocabulary, token placeholders, `install-in-claude` workspace names, required `data-route` attributes, IA route strings, `App creator secrets`, stale `.cat-*` selectors, and literal `\n` command-snippet escapes.
- Verified the source, scoped DOM, and screenshots agree that `install-in-claude.html` now passes the distinct-workspace card contract on desktop and mobile.
- Verified remaining observations are nits only and all per-file scores are 9.0 or higher.
- Verified `pnpm typecheck` passed.
