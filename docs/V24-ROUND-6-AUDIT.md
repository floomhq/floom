# V24 Round 6 Audit

Date: 2026-04-27  
Inputs: `mobile-menu.html`, `design-system.html`, `_v24.css`  
Verdict: **NO-GO** because `design-system.html` scores below 9.0.

## Critical

None.

## Important

1. `design-system.html` does not fully document the sidebar IA contracts per shell type. The Sidebar IA section only lists the core page links for Run, Studio, and Settings at `/var/www/wireframes-floom/v24/design-system.html:152`. It omits required cross-shell groups and placement rules from L3: Workspace identity, Studio `New app`, Studio app list, Workspace settings links inside Run/Studio, and Account placement. This makes the design system incomplete as the locked reference for non-dev handoff.

2. `design-system.html` contains component examples, but it does not link to them from the page navigation or an in-page anchor. The checklist asks for the design system to link to component examples. The examples exist at `/var/www/wireframes-floom/v24/design-system.html:245`, but the only top navigation links are index, mobile-menu, design-system, ia, and architecture at `/var/www/wireframes-floom/v24/design-system.html:60`.

## Nits

1. `_v24.css` defines `.run-shell` twice: an earlier two-column run-input/output pattern at `/var/www/wireframes-floom/v24/_v24.css:800`, then the v24 shell grid at `/var/www/wireframes-floom/v24/_v24.css:1049`. Current v24 HTML uses the shell meaning, so this is not a rendered failure in the audited pages. It is still a naming collision risk for future edits.

2. `design-system.html` adds `your workspace` to the banned list at `/var/www/wireframes-floom/v24/design-system.html:126`. That is stricter than the audit checklist. It is not harmful, but it is extra policy surface.

## Per-File Scores

| File | Score | Result |
|---|---:|---|
| `mobile-menu.html` | 10.0/10 | Pass |
| `design-system.html` | 8.8/10 | Fail |
| `_v24.css` | 9.4/10 | Pass |

## `mobile-menu.html`

Score: **10.0/10**

Verified:

- Visible H1 is `/mobile-menu` at `/var/www/wireframes-floom/v24/mobile-menu.html:44`.
- Drawer order is Workspace identity, Run, Studio, Workspace settings, Account at `/var/www/wireframes-floom/v24/mobile-menu.html:99`.
- Run group contains Overview, Apps, Runs at `/var/www/wireframes-floom/v24/mobile-menu.html:105`.
- Studio group contains Home, Apps, All runs, New app at `/var/www/wireframes-floom/v24/mobile-menu.html:112`.
- Workspace settings contains BYOK keys, Agent tokens, Studio settings at `/var/www/wireframes-floom/v24/mobile-menu.html:120`.
- Account contains Account settings and Sign out at `/var/www/wireframes-floom/v24/mobile-menu.html:129`.
- Closed and opened states both render.
- 390px browser check: `innerWidth=390`, `scrollWidth=390`, `maxElementOverflow=0`.
- Banned vocabulary absent: `My account`, `your account`, `tok_`, `flo_agt_`, `API key`.
- HTML balance check returned no errors and no unclosed tags.

Screenshot evidence: `/tmp/v24-round6-mobile-menu-390.png`

## `design-system.html`

Score: **8.8/10**

Verified:

- Visible H1 is `/design-system` at `/var/www/wireframes-floom/v24/design-system.html:54`.
- Palette documents single emerald, warm-dark code, light cream shell/banner surfaces, and no category tints at `/var/www/wireframes-floom/v24/design-system.html:71`.
- Typography documents Inter and JetBrains Mono at `/var/www/wireframes-floom/v24/design-system.html:93`.
- Locked vocabulary is present at `/var/www/wireframes-floom/v24/design-system.html:107`.
- Banned terms appear only in the documentation block at `/var/www/wireframes-floom/v24/design-system.html:121`.
- Workspace identity block contract appears at `/var/www/wireframes-floom/v24/design-system.html:137`.
- Mobile drawer order is documented at `/var/www/wireframes-floom/v24/design-system.html:176`.
- URL family, token format, and MCP pattern are documented at `/var/www/wireframes-floom/v24/design-system.html:189`.
- Component examples are present at `/var/www/wireframes-floom/v24/design-system.html:245`.
- 390px browser check: `innerWidth=390`, `scrollWidth=390`, `maxElementOverflow=0`.
- HTML balance check returned no errors and no unclosed tags.

Failed:

- Sidebar IA documentation is incomplete for the locked contract.
- Component examples are present but not linked.

Screenshot evidence: `/tmp/v24-round6-design-system-390.png`

## `_v24.css`

Score: **9.4/10**

Verified:

- Header comment contains `FLOOM v24`.
- `linear-gradient` count is 0.
- `.cat-*` selector count is 0.
- Required classes exist: `.ws-identity`, `.run-shell`, `.settings-shell`, `.app-ic-mono`, `.app-banner-mono`, `.m-drawer-v24`.
- Mobile gates are intact: `@media (max-width:760px)` hides `.bp-desktop`; `@media (max-width:480px)` relaxes page padding and mobile frame width.
- Non-comment `/me/*` reference count is 0.
- Browser stylesheet parse loaded `_v24.css` with 592 CSS rules and no console or page errors.
- Brace count is balanced: 637 `{` and 637 `}`.

Nit:

- Duplicate `.run-shell` selector semantics create maintenance ambiguity.

## Cross-References And Integrity

- `mobile-menu.html` serves as the canonical mobile drawer reference; its annotation states it is the single authenticated phone-width navigation model.
- Every HTML file in `/var/www/wireframes-floom/v24` references `./_v24.css`; checked 52 HTML files.
- `design-system.html` includes component examples but lacks an explicit navigation or anchor link to that section.
- `_v24.css` is referenced by both audited Round 6 HTML files.

## ICP Lens

`mobile-menu.html` is simple enough for a non-dev: it shows closed and opened states, exact groups, labels, and order in a 390px frame.

`design-system.html` is not yet simple enough as a non-dev contract because the Sidebar IA examples are abbreviated. A reader can understand colors, typography, vocabulary, tokens, and components, but cannot reconstruct the complete shell navigation contract from this page alone.

## Backend Logic Lens

The documented route and identity patterns match L1 and L2:

- Workspace is the tenant boundary.
- `/run/*`, `/settings/*`, `/studio/*`, `/account/settings`, and `/p/:slug` align with L2 and L3.
- Agent tokens use `floom_agent_` and resolve workspace from the token.
- MCP naming as `floom-{workspaceName}` matches the per-workspace tool pattern.
- BYOK keys and Agent tokens are workspace settings, while Account settings remain personal.

No backend logic conflict found in the three audited files.

## Verification Evidence

- `pnpm -C /root/floom typecheck`: pass. Turbo reported 7 successful tasks, 7 total.
- Browser render at 390px for `mobile-menu.html`: pass, no overflow, screenshot saved.
- Browser render at 390px for `design-system.html`: pass, no overflow, screenshot saved.
- Browser CSS parse through `http://127.0.0.1:8124`: pass, `_v24.css` loaded with 592 rules.
- HTML balance parser: pass for both HTML files.
- String scans: pass for banned mobile vocabulary, `linear-gradient`, `.cat-*`, and non-comment `/me/*`.
- Independent bouncer quick audit: unavailable. The script returned `WARNING: No GEMINI_API_KEY or GOOGLE_API_KEY set. Cannot run audit.`

## Self-Review

I performed the required self-review. I re-read the L1, L2, and L3 architecture inputs, inspected the three target files, ran mechanical string checks, validated HTML balance, validated CSS parse through a same-origin browser load, captured mobile screenshots, checked rendered overflow at 390px, and ran the repository typecheck. The audit intentionally assigns **NO-GO** because the design-system sidebar IA contract is incomplete.
