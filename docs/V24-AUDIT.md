# v24 Wireframe Audit
Date: 2026-04-27
Auditor: Codex
Scope: Rounds 1+2+3 (listed scope contains 19 HTML files + _v24.css)

## Critical Issues (block Round 4)

### Global

- `/var/www/wireframes-floom/v24/`: the prompt says 18 files, but the supplied list contains 19 HTML files plus `_v24.css`. I audited all 19 HTML files: `index.html`, the 3 Round 1 shells, 5 Round 2 pages, and 10 Round 3 pages.
- `/var/www/wireframes-floom/v24/`: rendered browser verification found horizontal overflow on every audited mobile wireframe page except `index.html`. Evidence from Playwright at 390px viewport: most pages render `scrollWidth=407`, `workspace-settings-shell.html` renders `scrollWidth=429`, while `clientWidth=390`. Screenshots saved under `/tmp/v24-audit-screens/`.
- `/var/www/wireframes-floom/v24/`: HTML tag-balance check passed for all 19 HTML files.
- `/var/www/wireframes-floom/v24/`: repeated live anchors point at files absent from `v24/`. This breaks the “anchors point to real files in v24/” and “no broken refs” requirements.

### Broken Local Links

- `/var/www/wireframes-floom/v24/account-settings.html`: missing targets at lines 63, 89, 103, 187 (`landing.html`), lines 69 (`studio-home.html`), and 82 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/run-app-run.html`: missing targets at lines 50, 57, 68, 129 (`landing.html`), lines 51 (`studio-home.html`), 52 (`studio-build.html`), and 80 (`app-page.html`).
- `/var/www/wireframes-floom/v24/run-app-trigger-schedule.html`: missing targets at lines 44, 48, 59, 110 (`landing.html`) and line 44 (`studio-home.html`).
- `/var/www/wireframes-floom/v24/run-app-trigger-webhook.html`: missing targets at lines 44, 48, 59, 107 (`landing.html`) and line 44 (`studio-home.html`).
- `/var/www/wireframes-floom/v24/run-app-triggers.html`: missing targets at lines 39, 43, 54, 115 (`landing.html`), line 39 (`studio-home.html`), and line 39 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/run-apps.html`: missing targets at lines 59, 76, 87, 145 (`landing.html`), line 60 (`studio-home.html`), line 69 (`studio-build.html`), lines 104, 157 (`apps.html`), and lines 108, 113, 118, 123, 128, 151, 152, 153, 154, 155 (`app-page.html`).
- `/var/www/wireframes-floom/v24/run-empty-state.html`: missing targets at lines 41, 48, 59, 100 (`landing.html`), line 42 (`studio-home.html`), line 43 (`studio-build.html`), lines 70, 103 (`apps.html`), and lines 85, 86, 87 (`app-page.html`).
- `/var/www/wireframes-floom/v24/run-install.html`: missing targets at lines 40, 44, 55, 112 (`landing.html`), line 40 (`studio-home.html`), and lines 33, 101 (`install-in-claude.html`).
- `/var/www/wireframes-floom/v24/run-runs-detail.html`: missing targets at lines 63, 78, 89, 175 (`landing.html`), line 64 (`studio-home.html`), and line 71 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/run-runs.html`: missing targets at lines 60, 71, 82, 129 (`landing.html`), line 61 (`studio-home.html`), and line 64 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/run-workspace-shell.html`: missing targets at lines 58, 100, 110, 163, 190, 239 (`landing.html`), line 95 (`apps.html`), and lines 222, 223, 224, 225 (`studio-home.html`, `studio-apps.html`, `studio-runs.html`, `studio-build.html`).
- `/var/www/wireframes-floom/v24/settings-agent-tokens-empty.html`: missing targets at lines 68, 89, 103, 146 (`landing.html`), line 74 (`studio-home.html`), and line 82 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html`: missing targets at lines 86, 113, 127, 221 (`landing.html`), line 92 (`studio-home.html`), and line 106 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/settings-byok-keys-empty.html`: missing targets at lines 72, 93, 107, 146 (`landing.html`), line 78 (`studio-home.html`), and line 86 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/settings-byok-keys.html`: missing targets at lines 61, 88, 102, 182 (`landing.html`), line 67 (`studio-home.html`), and line 81 (`studio-build.html`).
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html`: missing targets at lines 58, 100, 171, 213, 260 (`landing.html`), lines 86, 115, 188, 218, 245 (`studio-build.html`), lines 126, 243 (`studio-apps.html`), lines 130, 244 (`studio-runs.html`), line 137 (`studio-app-overview.html`), and lines 155, 252 (`studio-settings.html`).
- `/var/www/wireframes-floom/v24/workspace-settings-shell.html`: missing targets at lines 72, 115, 163, 199 (`landing.html`).

### URL Family / Filename Compliance

- `/var/www/wireframes-floom/v24/index.html:31`: visible lede includes old `/me/*` URLs. The checklist says no surface-facing `/me/*` URLs remain.
- `/var/www/wireframes-floom/v24/run-workspace-shell.html:183`: visible content slot still references `me.html`; the actual v24 file is `run.html`.
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html:155,252`: `Studio settings` links to `studio-settings.html`. L3 production order and route map use `settings-studio.html` / `/settings/studio`.
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html:284`: visible note says `/studio/settings` remains a Studio-local configuration page. L1/L2/L3 define `/studio/settings` as a redirect to `/settings/studio`.
- `/var/www/wireframes-floom/v24/run-apps.html:108,113,118,123,128,151,152,153,154,155`, `/var/www/wireframes-floom/v24/run.html:128,137,146,155,164,252,260,265,270`, `/var/www/wireframes-floom/v24/run-empty-state.html:85,86,87`, and `/var/www/wireframes-floom/v24/run-app-run.html:80`: app-page links use `./app-page.html` instead of the L1 flat public route representation `/p/:slug`; the target file is absent in `v24/`.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:286`: cURL sample uses `https://floom.dev/api/p/competitor-lens/run`. L1/L2 preserve the flat API route as `/api/:slug/run`; this sample inserts `/p/` into the API family.

### Locked Vocabulary / Banned Copy

- `/var/www/wireframes-floom/v24/run-workspace-shell.html:263`: visible annotation contains banned `My account` and `your account`.
- `/var/www/wireframes-floom/v24/run-workspace-shell.html:265`: visible annotation contains banned `tok_••••••`.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:318`: visible annotation contains banned `tok_••••••`.
- `/var/www/wireframes-floom/v24/run-install.html:125`: visible annotation contains banned `flo_agt_`.
- `/var/www/wireframes-floom/v24/run-runs.html:151,153`: visible annotations contain banned `All your runs`.
- `/var/www/wireframes-floom/v24/run-empty-state.html:116`: visible annotation contains banned `Bring your keys`.
- `/var/www/wireframes-floom/v24/run-app-run.html:145` and `/var/www/wireframes-floom/v24/run-app-triggers.html:130`: visible annotations contain old tab label `Secrets`, even though the UI tab itself was renamed to `BYOK keys`.
- `/var/www/wireframes-floom/v24/account-settings.html:156,170,202,218`: visible copy contains `your account` inside account export and delete-account language. This is also an L3 conflict: L3’s account danger-row delta explicitly includes `your account identity`, while the prompt bans `your account` in user-facing copy.

### Copy-for-Claude Popover Compliance

- `/var/www/wireframes-floom/v24/run-runs.html:63`: `Copy for Claude` button has no popover rows, so the required `floom_agent_••••••` snippet is absent.
- `/var/www/wireframes-floom/v24/run-empty-state.html:43`: `Copy for Claude` button has no popover rows, so required `FOR WORKSPACE RUN` / `floom_agent_••••••` content is absent.
- `/var/www/wireframes-floom/v24/run-app-run.html:52`: `Copy for Claude` button has no popover rows, so the L3-required `floom_agent_••••••` snippet is absent.
- `/var/www/wireframes-floom/v24/run-app-triggers.html:39`: `Copy for Claude` button has no popover rows, so the L3-required `floom_agent_••••••` snippet is absent.
- `/var/www/wireframes-floom/v24/run-app-trigger-schedule.html:44`: `Copy for Claude` button has no popover rows, so the L3-required `floom_agent_••••••` snippet is absent.
- `/var/www/wireframes-floom/v24/run-app-trigger-webhook.html:44`: `Copy for Claude` button has no popover rows, so the L3-required `floom_agent_••••••` snippet is absent.
- `/var/www/wireframes-floom/v24/run-install.html:40`: `Copy for Claude` button has no popover rows, so the L3-required install snippet is absent.
- `/var/www/wireframes-floom/v24/settings-byok-keys-empty.html:84` and `/var/www/wireframes-floom/v24/settings-agent-tokens-empty.html:80`: empty settings pages render a `Copy for Claude` button without the inherited popover content used by their populated variants.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:286-293`: modal snippets use `$FLOOM_AGENT_TOKEN` instead of `floom_agent_••••••`; L3 says authenticated token placeholders in v24 wireframes use Agent token examples.

### Color Palette

- `/var/www/wireframes-floom/v24/_v24.css:924,926,927,940,942,944,987,989,991,993`: category gradient backgrounds remain (`banner-*`, `cat-*`), including emerald/yellow/blue category tints. This violates the single-accent and no-category-tints rule.
- `/var/www/wireframes-floom/v24/_v24.css:1012`: recommended option uses a green-tinted gradient background. The rule bans gradient elements and single-accent category/tint treatments outside neutral surfaces.
- `/var/www/wireframes-floom/v24/_v24.css:311`: `.info-card` uses `linear-gradient(135deg,var(--bg),var(--studio))`. This is neutral, but still conflicts with the stylesheet header rule “No gradient elements.”
- `/var/www/wireframes-floom/v24/_v24.css`: scan found no pure `#000` or `bg-black`.
- `/var/www/wireframes-floom/v24/`: emoji scan found no obvious emoji UI glyphs. The `⌘K` shortcut symbol in `studio-workspace-shell.html:186` is a keyboard symbol, not an emoji.

## Important Issues (fix before Round 4)

### Global / Shell

- `/var/www/wireframes-floom/v24/_v24.css:1039-1056`: workspace identity block has correct padding and divider, but rendered `.ws-identity` in `run.html` is 72.5px border-box at 1440px. The L3 spec says “40px content block”; no fixed/min content height enforces that size.
- `/var/www/wireframes-floom/v24/_v24.css:421-426`: old `.ws-switcher` button styles remain in `_v24.css`. The v24 shells do not render them, but the stylesheet still carries switcher affordance styles after L3 says the switcher is hidden in v1.
- `/var/www/wireframes-floom/v24/_v24.css:848-856`: `.me-primary-nav` styles remain. L3 says `.me-primary-nav`, `.ms-tabs`, `.ak-tabs`, and page-specific desktop tab strips are replaced by the v24 rail in authenticated workspace pages.
- `/var/www/wireframes-floom/v24/_v24.css:1072`: comment says settings shell is used by `/me/secrets`, `/me/agent-keys`, `/me/settings`. That stale URL family conflicts with v24 canonical paths, even though it is CSS-only.
- `/var/www/wireframes-floom/v24/run-workspace-shell.html:63-64` and `/var/www/wireframes-floom/v24/workspace-settings-shell.html:77-78`: Round 1 shell TopBar links point to shell reference files, not the L3 TopBar contract `./run.html` and `./studio-home.html`. These links are real for Round 1, but they are not the production page destinations.
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html:63-64`: Studio shell TopBar points to shell references; the L3 contract says `Run -> ./run.html`, `Studio -> ./studio-home.html`.
- `/var/www/wireframes-floom/v24/run-workspace-shell.html:87`, `/var/www/wireframes-floom/v24/run.html:82`, `/var/www/wireframes-floom/v24/run-apps.html:69`, `/var/www/wireframes-floom/v24/run-runs.html:64`, `/var/www/wireframes-floom/v24/run-runs-detail.html:71`, `/var/www/wireframes-floom/v24/run-empty-state.html:43`, `/var/www/wireframes-floom/v24/run-app-run.html:52`, `/var/www/wireframes-floom/v24/run-app-triggers.html:39`, `/var/www/wireframes-floom/v24/settings-byok-keys.html:81`, `/var/www/wireframes-floom/v24/settings-agent-tokens.html:106`, `/var/www/wireframes-floom/v24/account-settings.html:82`: Run/settings pages show a `+ New app` CTA in the global TopBar. L3 only defines `New app` as a primary Studio CTA; having it in Run/settings global chrome muddies mode hierarchy.
- `/var/www/wireframes-floom/v24/run-install.html:47-52`: Run rail has no active item for `/run/install`. Playwright active rail list is empty for `run-install.html`, making the page visually unanchored.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:144-147` and `/var/www/wireframes-floom/v24/settings-agent-tokens-empty.html:100-103`: `Agent tokens` active state and counts are correct, but the empty page omits counts on adjacent Run/BYOK rails while populated pages show counts. The shell contract says counts remain visible where v23 already used counts.
- `/var/www/wireframes-floom/v24/settings-byok-keys-empty.html:98-104`: empty BYOK rail shows `BYOK keys 0` but omits `Apps 5`, `Runs 142`, and `Agent tokens 2`; populated settings pages include those counts.

### Per-File Content

- `/var/www/wireframes-floom/v24/run-runs-detail.html:94,100,179`: run id is `run_a8f31c`; L3 delta specifies breadcrumb `Run / Runs / run_a8f31`.
- `/var/www/wireframes-floom/v24/run-empty-state.html:102`: mobile intro omits `and the first result appears here`; desktop line 66 has the exact L3 intro.
- `/var/www/wireframes-floom/v24/run-app-trigger-schedule.html:95-96`: helper text `retry on failure` and `notification Optional. POSTs run summary to this URL.` is workspace-neutral but terse; L3 asked to replace ownership helper text with workspace runtime copy. The key ownership copy is fixed elsewhere, but these controls lack workspace context.
- `/var/www/wireframes-floom/v24/run-app-trigger-webhook.html:91-94`: HMAC/replay helper text is preserved, but no visible workspace runtime reminder appears near the signing-secret block beyond the header scope line.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:277`: one-time modal displays a full-looking concrete token (`floom_agent_AbCd...`) rather than the canonical placeholder. It is mock data, but it reads like a real secret.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html:247`: mobile copy says `Tokens belong to {workspaceName}, not to you personally.` This avoids banned `your account`, but it still introduces a personal contrast that the rest of v24 tries to remove.
- `/var/www/wireframes-floom/v24/index.html:82-93`: Round 4/5/6 sections list pending filenames without `.html` and include names not present in `v24/`. They are not links, but the checklist’s filename-reference rule is stricter than this index copy.
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html:198`: slot note lists `studio-settings.html`; L3 production order uses `settings-studio.html`.

### Visual / Rendered Evidence

- `/var/www/wireframes-floom/v24/*`: the artifact pages render both desktop and mobile frames in one document. That is acceptable for wireframe boards, but it makes actual 390px screenshots extremely tall and horizontally overflowed. Evidence: `/tmp/v24-audit-screens/*-mobile.png`.
- `/var/www/wireframes-floom/v24/settings-agent-tokens.html`: rendered desktop includes the modal showcase directly below the page, not a separate state. It is clear as a wireframe note, but it reads as part of the page when scanning the full screenshot.
- `/var/www/wireframes-floom/v24/studio-workspace-shell.html:224-225`: mobile drawer contains a visible HTML comment fragment in source near the drawer order. It does not render as text, but the source is noisy around the mobile contract.

## Nits (defer or fix opportunistically)

- `/var/www/wireframes-floom/v24/_v24.css:2`: stylesheet header still says `FLOOM v20`, while the file is `_v24.css`.
- `/var/www/wireframes-floom/v24/_v24.css:578,632,779,900+`: many comments reference older deltas (`v3`, `v22`) and older `/me` work. These are CSS-only, but the file no longer reads as a clean v24 source.
- `/var/www/wireframes-floom/v24/_v24.css:59,76,235,499,582,643,660,785`: `/me` appears in comments. Not surface UI, but it weakens URL hygiene.
- `/var/www/wireframes-floom/v24/account-settings.html:200`: mobile description says `Profile, email, security, account deletion.` while L3 desktop description is `Profile, email, security, and account deletion.` The meaning is identical, but the copy is not exact.
- `/var/www/wireframes-floom/v24/run-app-run.html:94`: input labels `your_url` and `competitor_url` are allowed by L3 as app schema names. They still look like ownership phrasing to a fast visual scan.
- `/var/www/wireframes-floom/v24/run-app-trigger-schedule.html:89,116` and `/var/www/wireframes-floom/v24/settings-agent-tokens.html:289`: `your_url` is allowed as schema field name, but it requires discipline in surrounding copy.
- `/var/www/wireframes-floom/v24/run.html:118` and mobile line 244: `Workspace Run` appears as H1 in both the board header and the page frame. Correct by spec, but repeated in full-page screenshots.
- `/var/www/wireframes-floom/v24/run-apps.html:151-155`: mobile app rows use uniform blank icons; desktop uses `app-ic-mono`. Visually acceptable, but not as polished as the desktop app list.
- `/var/www/wireframes-floom/v24/run-runs.html:138`: mobile failure status uses inline `background:var(--danger)` while success uses `status-live`; consistent class usage would reduce drift.
- `/var/www/wireframes-floom/v24/settings-byok-keys.html:118,136,153`: provider rows use different mask patterns (`AIzaSy…`, `sk-proj…`, `sk-ant…`). This mirrors provider realities, but line lengths vary and create mild visual unevenness.

## Per-file scores (0-10)

10 = no issues. Below 8 = needs rework before Round 4.

- `index.html`: 8.0. Main issue: visible `/me/*` redirect wording and pending filename references.
- `run-workspace-shell.html`: 6.5. Broken links, visible banned vocabulary in annotations, stale `me.html`, shell link destination drift, mobile overflow.
- `workspace-settings-shell.html`: 7.5. Broken `landing.html` links, shell destination drift, mobile overflow, stale account/settings inheritance wording.
- `studio-workspace-shell.html`: 5.5. Broken Round 4 links, wrong `studio-settings.html` filename, `/studio/settings` route wording conflict, mobile overflow.
- `settings-byok-keys.html`: 7.5. Broken links and mobile overflow; core page deltas are mostly applied.
- `settings-byok-keys-empty.html`: 7.0. Broken links, no popover content, count inconsistency, mobile overflow.
- `settings-agent-tokens.html`: 6.5. Broken links, wrong API sample route, noncanonical token variables in modal snippets, real-looking token sample, mobile overflow.
- `settings-agent-tokens-empty.html`: 7.0. Broken links, no popover content, count inconsistency, mobile overflow.
- `account-settings.html`: 7.0. Broken links, `your account` conflict, mobile copy mismatch, mobile overflow.
- `run.html`: 7.0. Broken links, `app-page.html` route representation, category-gradient dependency, TopBar New app mode bleed, mobile overflow.
- `run-apps.html`: 7.0. Broken links, `app-page.html` route representation, TopBar New app mode bleed, mobile overflow.
- `run-runs.html`: 7.0. Broken links, missing popover content, visible banned annotation, mobile overflow.
- `run-runs-detail.html`: 7.0. Broken links, run id mismatch, mobile overflow.
- `run-empty-state.html`: 6.5. Broken links, missing popover content, visible banned annotation, mobile intro mismatch, mobile overflow.
- `run-app-run.html`: 6.5. Broken links, missing popover content, visible old `Secrets` annotation, public page route representation, mobile overflow.
- `run-app-triggers.html`: 6.5. Broken links, missing popover content, visible old `Secrets` annotation, mobile overflow.
- `run-app-trigger-schedule.html`: 7.0. Broken links, missing popover content, thin workspace runtime copy in controls, mobile overflow.
- `run-app-trigger-webhook.html`: 7.0. Broken links, missing popover content, workspace runtime reminder only appears in header, mobile overflow.
- `run-install.html`: 6.5. Broken links, missing popover content, no active rail item, visible banned `flo_agt_` annotation, mobile overflow.
- `_v24.css`: 6.0. Category gradients, old `/me` comments/classes, stale v20/v22/v3 comments, no enforced 40px identity content block.

## Round 4 readiness verdict

NO-GO. Round 4 is blocked by broken links to absent files, wrong Studio settings filename/route references, visible banned vocabulary, missing Copy-for-Claude popover content on multiple Round 3 pages, category-gradient CSS, and confirmed mobile horizontal overflow.

## Self-Review v1

- Verified all 19 listed HTML files and `_v24.css` were included in the audit and score list.
- Verified source scans for banned strings, `/me`, broken local links, gradients, pure black, and emoji candidates.
- Verified HTML tag balance with a parser: no unmatched or unclosed tags reported.
- Verified rendered pages with Playwright at desktop 1440x900 and mobile 390x844; all pages returned HTTP 200 and no console/page errors, but mobile overflow was present.
- Found one spec conflict in the instructions: L3 requires account danger copy containing `your account identity`, while the prompt bans `your account` in user-facing copy. This remains a product/spec decision before 10/10 compliance is possible.
