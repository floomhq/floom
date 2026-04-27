# V24 Round 6 Re-Audit

Date: 2026-04-27  
Inputs: `mobile-menu.html`, `design-system.html`, `_v24.css`  
Verdict: **NO-GO** because `design-system.html` remains below 9.0.

## Critical

None.

## Important

1. `design-system.html` now horizontally overflows at 390px. Browser verification returned `innerWidth=390`, `scrollWidth=620`, and `maxElementOverflow=229.73`; the top offender is the appended Sidebar IA `pre > code` block at `/var/www/wireframes-floom/v24/design-system.html:300`. The Studio shell code block also overflows by `175.52px` at `/var/www/wireframes-floom/v24/design-system.html:315`. Round 6 requires the design system to be a mobile-safe locked reference, so this blocks GO.

2. The complete Sidebar IA contract content was appended, but it is not integrated into the existing styled `Sidebar IA` section. The in-page nav link points to `#ia-title` at `/var/www/wireframes-floom/v24/design-system.html:61`, while the detailed appended contract uses `id="sidebar-ia"` at `/var/www/wireframes-floom/v24/design-system.html:297` and has no in-page nav target. The prior content gap is resolved, but the handoff page still splits the abbreviated visual IA section from the complete contract.

## Nits

1. `_v24.css` still defines `.run-shell` in two semantic contexts: the earlier app run input/output layout at `/var/www/wireframes-floom/v24/_v24.css:800`, and the v24 workspace shell grid at `/var/www/wireframes-floom/v24/_v24.css:1049`. Current audited pages still render, but the selector collision remains a maintenance risk.

2. `design-system.html` keeps `your workspace` in the banned list at `/var/www/wireframes-floom/v24/design-system.html:139`. This is stricter than the audit checklist and remains harmless extra policy surface.

## Per-File Scores

| File | Score | Result |
|---|---:|---|
| `mobile-menu.html` | 10.0/10 | Pass |
| `design-system.html` | 8.7/10 | Fail |
| `_v24.css` | 9.4/10 | Pass |

## Prior Issues

1. Sidebar IA documentation completeness: **content resolved, presentation not fully resolved**. The Run shell tree now includes Workspace identity, Run, Workspace settings, Account, and rail-foot. The Studio shell tree now includes Workspace identity, New app primary CTA, Studio, Apps · 5 list, Workspace settings, Account, and rail-foot. Cross-shell rules are present. The appended block is unstyled, not linked directly from the in-page nav, and causes mobile overflow.

2. Component examples linked from in-page nav: **resolved**. `Components` is linked from the in-page nav at `/var/www/wireframes-floom/v24/design-system.html:65`, and the target `#components-title` exists at `/var/www/wireframes-floom/v24/design-system.html:259`.

## `mobile-menu.html`

Score: **10.0/10**

Verified:

- Visible H1 is `/mobile-menu`.
- Drawer order is Workspace identity, Run, Studio, Workspace settings, Account.
- Run group contains Overview, Apps, Runs.
- Studio group contains Home, Apps, All runs, New app.
- Workspace settings contains BYOK keys, Agent tokens, Studio settings.
- Account contains Account settings and Sign out.
- Closed and opened states both render.
- 390px browser check: `innerWidth=390`, `scrollWidth=390`, `maxElementOverflow=0`.
- Banned mobile vocabulary absent: `My account`, `your account`, `tok_`, `flo_agt_`, `API key`.
- HTML balance check returned no errors and no unclosed tags.

Screenshot evidence: `/tmp/v24-round6-reaudit-mobile-menu-390.png`

## `design-system.html`

Score: **8.7/10**

Verified:

- Visible H1 is `/design-system`.
- Palette documents single emerald, warm-dark code, light cream shell/banner surfaces, and no category tints.
- Typography documents Inter and JetBrains Mono.
- Locked vocabulary is present.
- Banned terms appear only in the documentation block.
- `Workspace identity block Block` is absent; `Workspace identity block` is the rendered heading.
- Duplicate ID scan returned none.
- All hash links resolve to existing IDs, excluding inert component demo anchors.
- In-page nav links to Palette, Typography, Vocabulary, Identity block, Sidebar IA, Mobile drawer, URLs & tokens, TopBar, and Components.
- Full Run shell tree, Studio shell tree, and cross-shell rules are present.
- Component examples are present and linked from the in-page nav.
- HTML balance check returned no errors and no unclosed tags.

Failed:

- 390px browser check: `innerWidth=390`, `scrollWidth=620`, `maxElementOverflow=229.73`.
- Overflow offenders are the appended Run and Studio Sidebar IA `code` blocks.
- The complete Sidebar IA contract is appended after Components instead of being integrated into the styled Sidebar IA section or linked directly from the in-page nav.

Screenshot evidence: `/tmp/v24-round6-reaudit-design-system-390.png` and `/tmp/v24-round6-reaudit-design-system-1280.png`

## `_v24.css`

Score: **9.4/10**

Verified:

- Header comment contains `FLOOM v24`.
- `linear-gradient` count is 0.
- `.cat-*` selector count is 0.
- Required classes exist: `.ws-identity`, `.run-shell`, `.settings-shell`, `.app-ic-mono`, `.app-banner-mono`, `.m-drawer-v24`.
- Non-comment `/me/*` reference count is 0.
- Browser stylesheet parse loaded `_v24.css` with 592 CSS rules and no console or page errors.
- Brace count is balanced: 637 `{` and 637 `}`.
- Every HTML file in `/var/www/wireframes-floom/v24` references `./_v24.css`; checked 52 HTML files.

Nit:

- Duplicate `.run-shell` selector semantics create maintenance ambiguity.

## Cross-References And Integrity

- `mobile-menu.html` remains the canonical phone-width authenticated navigation reference.
- `design-system.html` now contains the missing Sidebar IA contract content, but the appended contract creates a mobile rendering failure.
- `_v24.css` is referenced by both audited Round 6 HTML files and all 52 v24 HTML files.
- The L1/L2/L3 route, identity, token, and shell vocabulary decisions still match the audited content.

## All-Rounds-Complete Verdict

**NO-GO.** All three Round 6 files are not at 9.0+. `design-system.html` scores **8.7/10**, so all 6 rounds of v24 wireframes are not complete and Layer 5 React implementation remains blocked.

## Verification Evidence

- `pnpm -C /root/floom typecheck`: pass. Turbo reported 7 successful tasks, 7 total.
- Browser render at 390px for `mobile-menu.html`: pass, no overflow, screenshot saved.
- Browser render at 390px for `design-system.html`: fail, horizontal overflow, screenshot saved.
- Browser CSS parse through `http://127.0.0.1:8124`: pass, `_v24.css` loaded with 592 rules.
- HTML balance parser: pass for both audited HTML files.
- Duplicate ID scan: pass for both audited HTML files.
- Anchor-target scan: pass for both audited HTML files, excluding inert demo anchors.
- String scans: pass for mobile banned vocabulary, `linear-gradient`, `.cat-*`, and non-comment `/me/*`.

## Self-Review

I performed the required self-review. I re-read the prior Round 6 audit, inspected the three target files, checked the Layer 1/2/3 architecture inputs, ran mechanical string and structure checks, validated rendered 390px behavior in Chromium, captured screenshots, validated stylesheet parsing, checked all v24 HTML files for `_v24.css` references, and ran the repository typecheck. The audit intentionally assigns **NO-GO** because `design-system.html` has a verified mobile overflow regression.
