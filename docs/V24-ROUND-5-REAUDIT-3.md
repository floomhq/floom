# v24 Round 5 Wireframe Re-Audit 3

Date: 2026-04-27
Auditor: Codex
Scope: 17 Round 5 public + auth files plus shared `/var/www/wireframes-floom/v24/_v24.css`
Audit path: `/tmp/v24-r5-reaudit-3/`

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
13. `install-in-claude.html` multi-workspace card contract: fail. Desktop repeats `Federico's workspace`; mobile repeats `Acme Corp`.
14. IA route family and credential vocabulary: pass. All eight `/studio/apps/:slug/*` route strings are present, `/studio/:slug` is gone, and `App creator secrets` is visible.
15. Shared CSS stale category selector cleanup: pass. No `.cat-research`, `.cat-writing`, `.cat-utility`, `.cat-sales`, `.cat-content`, `.cat-travel`, or `.cat-dev` selectors remain.

## Critical

No critical issues found.

## Important

### `install-in-claude.html` still fails the multi-workspace card contract

- `/var/www/wireframes-floom/v24/install-in-claude.html:96` renders two desktop workspace cards, both titled `Federico's workspace`, with matching MCP entry names and code blocks.
- `/var/www/wireframes-floom/v24/install-in-claude.html:112` renders two mobile workspace cards, both titled `Acme Corp`, with matching MCP entry names and code blocks.
- Screenshot evidence: `/tmp/v24-r5-reaudit-3/install-in-claude-desktop.png` and `/tmp/v24-r5-reaudit-3/install-in-claude-mobile.png`.

The placeholder and token route metadata fixes remain intact: source scan found zero `{workspaceName}` matches in the scoped file and four `data-route="/api/workspaces/:id/agent-tokens"` anchors. The distinct-workspace example is still not correct on either viewport.

## Nits

### `install-in-claude.html` mobile TopBar remains crowded

The required mobile TopBar actions render, but `Copy for Claude` wraps into a tall control and the avatar label is clipped in the 390px capture. Evidence: `/tmp/v24-r5-reaudit-3/install-in-claude-mobile.png`.

### `apps.html` mobile filters remain condensed

Desktop shows `All`, `Research`, `Writing`, `Travel`, `Dev`, and `Ops`; mobile shows only `All`, `Research`, and `Dev`. The app list still includes Writing and Travel cards, so this remains a small parity nit. Evidence: `/tmp/v24-r5-reaudit-3/apps-mobile.png`.

### `architecture.html` mobile credential note is dense

The requested three-credential-family note is visible on mobile, including BYOK keys, Agent tokens, and App creator secrets. It is packed into the MCP card instead of the credential-card section, which makes it harder to scan than the desktop treatment. Evidence: `/tmp/v24-r5-reaudit-3/architecture-mobile.png`.

## Prior Finding Verification

The checked-in `V24-ROUND-5-REAUDIT-2.md` groups findings rather than exposing 16 Important and 25 Nit rows as separate numbered entries. Re-verification of the grouped prior findings:

- Literal `\n` escape text in command snippets: resolved. Fixed-string source scan found zero matches across the 12 previously affected files, and Playwright captures show rendered line breaks.
- `install-in-claude.html` mobile workspace cards: not resolved. Mobile repeats `Acme Corp` twice; desktop also repeats `Federico's workspace` twice.
- `architecture.html` mobile three-credential-family note: resolved. Mobile text includes BYOK keys, Agent tokens, and App creator secrets.
- `install-in-claude.html` crowded mobile TopBar: not resolved.
- `apps.html` condensed mobile filters: not resolved.
- Previously closed critical/source-contract items remain resolved: no `{workspaceName}` in `install-in-claude.html`, four token-mint route attributes exist, all IA app sub-routes exist, `App creator secrets` is present in IA and architecture, and stale `.cat-*` selectors are absent.

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
- `install-in-claude.html`: 8.2. Placeholders, route metadata, token vocabulary, snippets, desktop render, mobile render, and overflow checks pass; desktop and mobile both fail the distinct-workspace card contract, and the mobile TopBar remains crowded.
- `install.html`: 9.7. Route, public TopBar, links, token vocabulary, install snippets, desktop render, mobile render, overflow, and snippet newline checks pass.
- `install-app.html`: 9.7. Concrete `/install/competitor-lens` route, public TopBar, links, token vocabulary, install snippets, desktop render, mobile render, overflow, and snippet newline checks pass.
- `ia.html`: 9.7. Full Studio app route family, `App creator secrets`, H1, links, desktop render, mobile render, overflow, and stale `/studio/:slug` cleanup checks pass.
- `architecture.html`: 9.4. `App creator secrets` and the three credential families are visible on desktop and mobile; the mobile note is dense and lives inside the MCP card.

## Round 6 Verdict

NO-GO.

Round 6 remains blocked because all 17 files are not at 9.0+. `install-in-claude.html` scores 8.2 due to the repeated workspace cards on both desktop and mobile.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r5-reaudit-3/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r5-reaudit-3/*-mobile.png`
- Contact sheets: `/tmp/v24-r5-reaudit-3/contact-desktop.png`, `/tmp/v24-r5-reaudit-3/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r5-reaudit-3/metrics.json`
- Console/page errors: zero across 34 captures.
- Loading states: zero captures matched loading or skeleton text.
- Mobile overflow: all 17 mobile captures reported `390/390/390` for document scroll width, client width, and body scroll width.
- `pnpm typecheck`: passed. Turbo reported `7 successful, 7 total`.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 17 files: `landing.html`, `apps.html`, `app-page.html`, `app-page-running.html`, `app-page-output.html`, `app-page-rate-limited.html`, `app-page-error.html`, `app-page-install.html`, `app-page-source.html`, `app-page-about.html`, `login.html`, `signup.html`, `install-in-claude.html`, `install.html`, `install-app.html`, `ia.html`, and `architecture.html`.
- Verified screenshots show rendered wireframes, not loading states or blank pages.
- Verified source scans for CSS references, HTML balance, canonical route H1s, chrome URLs, public TopBar fragments, missing local links, `href="#"`, locked vocabulary, token placeholders, `install-in-claude` workspace names, required `data-route` attributes, IA route strings, `App creator secrets`, stale `.cat-*` selectors, and literal `\n` command-snippet escapes.
- Verified the source and screenshots agree on the remaining `install-in-claude.html` workspace-card failure.
- Verified `pnpm typecheck` passed.
