# v24 Round 5 Wireframe Re-Audit

Date: 2026-04-27
Auditor: Codex
Scope: 17 Round 5 public + auth files plus shared `/var/www/wireframes-floom/v24/_v24.css`
Audit path: `/tmp/v24-r5-reaudit/`

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
11. Agent-token copy and snippets use `floom_agent_••••••`: pass across visible token snippets.
12. `install-in-claude.html` authenticated TopBar contract `Run | Studio | Copy for Claude | + New app | avatar`: pass.
13. `install-in-claude.html` multi-workspace card contract: fail.
14. IA route family and credential vocabulary: fail.
15. Shared CSS stale category selector cleanup: fail.

## Critical

### `install-in-claude.html` still fails the multi-workspace Agent-token mint contract

- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `:108` still render `{workspaceName}` in the active workspace identity, workspace card title, MCP entry name, and Claude MCP command. The claimed fix says workspace cards have concrete workspace names; Playwright screenshots show the placeholder text still visible.
- `/var/www/wireframes-floom/v24/install-in-claude.html:96` and `:108` still link `Create Agent token` to `./settings-agent-tokens.html` with no `data-route="/api/workspaces/:id/agent-tokens"` attribute. Source scan found `data-route` count `0` in the file.

This keeps the prior Round 5 blocker open. The authenticated TopBar itself is fixed, but the workspace-specific token mint/reveal contract is not.

## Important

### `ia.html` has the `/studio/apps/:slug` overview route, but not the full app sub-route family

- `/var/www/wireframes-floom/v24/ia.html:100` and `:116` list only `/studio/apps/:slug`.
- Source scan found no visible `App creator secrets` text in `ia.html`.
- The IA hierarchy still lists `Studio -> Home, Apps, All runs` and omits app-level routes for `runs`, `secrets`, `access`, `analytics`, `source`, `feedback`, and `triggers`.

The previous `/studio/:slug` issue is resolved, but the claimed "all 8 sub-routes" and `App creator secrets` additions are not present in the audited file.

### `architecture.html` only partially adds `App creator secrets`

- `/var/www/wireframes-floom/v24/architecture.html:100` desktop MCP copy includes `App creator secrets`.
- `/var/www/wireframes-floom/v24/architecture.html:116` mobile MCP copy omits `App creator secrets`.
- The credential section still has cards only for `BYOK keys` and `Agent tokens`; there is no separate App creator secrets credential-family card or explicit creator-vs-caller split.

This is a partial fix, not full architecture coverage.

### `_v24.css` still contains the seven stale `.cat-*` category selectors

Source scan found the exact stale selectors that the fix pass claimed to strip:

- `/var/www/wireframes-floom/v24/_v24.css:939` `.cat-research`
- `/var/www/wireframes-floom/v24/_v24.css:941` `.cat-writing`
- `/var/www/wireframes-floom/v24/_v24.css:943` `.cat-utility`
- `/var/www/wireframes-floom/v24/_v24.css:986` `.cat-sales`
- `/var/www/wireframes-floom/v24/_v24.css:988` `.cat-content`
- `/var/www/wireframes-floom/v24/_v24.css:990` `.cat-travel`
- `/var/www/wireframes-floom/v24/_v24.css:992` `.cat-dev`

No visible category tint regression appeared in the 34 screenshots, but the shared stylesheet cleanup is not complete.

## Nits

### `apps.html` mobile filters remain condensed

Desktop shows `All`, `Research`, `Writing`, `Travel`, `Dev`, and `Ops`; mobile shows only `All`, `Research`, and `Dev`. This remains acceptable as a condensed mobile presentation, but it is still not one-to-one with desktop.

### `install-in-claude.html` mobile snippets are dense

The mobile screenshot has no horizontal page overflow, but the multi-workspace command blocks are visually hard to scan on a 390px viewport.

## Previously Open Items

- Visible board H1 labels: resolved. All 17 visible board H1s are route-only strings.
- Chrome `:slug` placeholders: resolved. App and install URLs now use concrete `competitor-lens` examples.
- `install-in-claude.html` TopBar action labels: resolved. Desktop and mobile render `Run`, `Studio`, `Copy for Claude`, `+ New app`, and the avatar.
- Public `Docs` and `Pricing` fragments: resolved. All public instances use `#wireframe-inert`.
- `ia.html` `/studio/:slug` strings: resolved. Source scan found zero `/studio/:slug` matches.

## Per-File Scores

10 = no issue found. Round 6 requires every file at 9.0 or higher.

- `landing.html`: 9.7. H1, chrome URL, public TopBar, links, token snippets, and mobile overflow pass; only shared CSS residue remains.
- `apps.html`: 9.4. Core checks pass; mobile filter set remains condensed and shared CSS residue remains.
- `app-page.html`: 9.6. H1 and chrome URL are fixed; state, tabs, token copy, links, and mobile overflow pass.
- `app-page-running.html`: 9.6. H1 and chrome URL are fixed; running state and token copy pass.
- `app-page-output.html`: 9.6. H1 and chrome URL are fixed; output state and token copy pass.
- `app-page-rate-limited.html`: 9.6. H1 and chrome URL are fixed; BYOK recovery copy and token copy pass.
- `app-page-error.html`: 9.6. H1 and chrome URL are fixed; error recovery copy and token copy pass.
- `app-page-install.html`: 9.6. H1 and concrete `/p/competitor-lens/install` chrome URL pass; install tab and token copy pass.
- `app-page-source.html`: 9.6. H1 and concrete `/p/competitor-lens/source` chrome URL pass; source tab and token copy pass.
- `app-page-about.html`: 9.6. H1 and concrete `/p/competitor-lens/about` chrome URL pass; about tab and token copy pass.
- `login.html`: 9.7. H1, chrome URL, public TopBar, links, and banned vocabulary scan pass.
- `signup.html`: 9.7. H1, chrome URL, public TopBar, links, and banned vocabulary scan pass.
- `install-in-claude.html`: 7.0. TopBar is fixed, but `{workspaceName}` remains visible and token mint anchors lack the required `data-route` contract.
- `install.html`: 9.7. H1, chrome URL, public TopBar, install snippets, and token vocabulary pass.
- `install-app.html`: 9.7. H1 and concrete `/install/competitor-lens` chrome URL pass; install snippets and token vocabulary pass.
- `ia.html`: 8.0. H1, chrome URL, and `/studio/:slug` cleanup pass; full Studio app sub-route family and `App creator secrets` are still missing.
- `architecture.html`: 8.6. H1 and chrome URL pass; `App creator secrets` is desktop-only and still lacks a dedicated credential-family treatment.

## Round 6 Verdict

NO-GO.

Round 6 remains blocked because all 17 files are not at 9.0+. `install-in-claude.html`, `ia.html`, and `architecture.html` remain below the threshold.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r5-reaudit/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r5-reaudit/*-mobile.png`
- Contact sheets: `/tmp/v24-r5-reaudit/contact-desktop.png`, `/tmp/v24-r5-reaudit/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r5-reaudit/metrics.json`
- Mobile overflow: all 17 mobile captures report `390/390/390` for document scroll width, client width, and body scroll width.
- Console/page errors: one transient desktop network error appeared on the first `app-page-rate-limited.html` capture; a fresh recapture returned zero console errors. No page errors were recorded.
- `pnpm typecheck`: passed. Turbo reported `7 successful, 7 total`.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 17 files: `landing.html`, `apps.html`, `app-page.html`, `app-page-running.html`, `app-page-output.html`, `app-page-rate-limited.html`, `app-page-error.html`, `app-page-install.html`, `app-page-source.html`, `app-page-about.html`, `login.html`, `signup.html`, `install-in-claude.html`, `install.html`, `install-app.html`, `ia.html`, and `architecture.html`.
- Verified screenshots show rendered wireframes, not loading states or blank pages.
- Verified source scans for CSS references, HTML balance, canonical H1s, chrome URLs, public TopBar fragments, missing local links, `href="#"`, banned vocabulary, token placeholders, `install-in-claude` workspace-card placeholders, required `data-route` attributes, IA route strings, `App creator secrets`, and stale `.cat-*` selectors.
- Verified the issues from `V24-ROUND-5-AUDIT.md` that are fixed: H1 labels, chrome placeholder URLs, authenticated TopBar action labels, public Docs/Pricing fragments, and `/studio/:slug` strings.
- Verified the issues still broken with source-line evidence: `install-in-claude.html` workspace placeholders and missing token route data attributes, incomplete IA credential/sub-route coverage, partial architecture credential coverage, and stale shared CSS selectors.
- Verified `pnpm typecheck` passed.
