# v24 Round 4 Wireframe Re-Audit 2
Date: 2026-04-27
Auditor: Codex
Scope: 14 Round 4 Studio files plus shared `/var/www/wireframes-floom/v24/_v24.css`

Screenshots and metrics: `/tmp/v24-r4-reaudit-2/`

## Checklist Re-Run

All 15 Round 4 audit rules were re-run:

1. Exact 14-file scope exists and each file references `./_v24.css`.
2. HTML tag balance passes.
3. Desktop TopBar shows `Run | Studio` with Studio active.
4. Visible board H1 paths use canonical `/studio/*` and `/settings/studio` URLs.
5. Desktop chrome URLs use canonical browser URLs, including `/studio/apps/flyfast/*`.
6. No visible `/v24/*.html` route leakage remains in audited route fields.
7. Copy-for-Claude row-three labels match the accepted Round 4 labels.
8. Copy-for-Claude snippets use `floom_agent_••••••`; `studio-runs.html` includes `floom runs list --workspace`.
9. Locked vocabulary scan covers `My account`, `your account`, `your workspace`, legacy token prefixes, `/me/*`, and emoji candidates.
10. Link integrity scan covers `href="#"`, `#wireframe-inert`, and missing local `./*.html` targets.
11. No emoji UI glyphs remain in the 14 HTML files.
12. Studio sidebar identity and settings groups match the shared Studio sidebar contract.
13. `.ws-identity` desktop padding and rendered dimensions were measured.
14. Mobile overflow was measured at 390x844 with Playwright.
15. Mobile drawer/tabs, settings-specific deltas, and shared palette/gradient rules were re-checked.

## Critical

None found in this pass.

The prior critical `href="#"` issue in `studio-app-secrets.html` is resolved. Current scan shows zero `href="#"` entries across the 14 audited files; `studio-app-secrets.html:95-98,121` now uses `#wireframe-inert`.

## Important

### Six per-app mobile screens still lack the 8-tab app strip

The fix pass expanded the mobile app tab strip in `studio-app-secrets.html:139` and `studio-app-source.html:147`, but six of eight per-app mobile screens still render no `m-tab-strip` and no full app tab set:

- `/var/www/wireframes-floom/v24/studio-app-overview.html:152`
- `/var/www/wireframes-floom/v24/studio-app-runs.html:142`
- `/var/www/wireframes-floom/v24/studio-app-access.html:140`
- `/var/www/wireframes-floom/v24/studio-app-analytics.html:138`
- `/var/www/wireframes-floom/v24/studio-app-feedback.html:139`
- `/var/www/wireframes-floom/v24/studio-app-triggers.html:140`

Verified source count: only `studio-app-secrets.html` and `studio-app-source.html` contain `m-tab-strip`. Playwright mobile screenshots confirm the six files render the page title and drawer card without the Overview, Runs, Creator secrets, Access, Analytics, Source, Feedback, Triggers strip.

### Mobile drawer explanatory copy remains stale on 11 files

Actual mobile drawers now include the Run group and render in the correct order: workspace identity, Run, Studio, Workspace settings, Account. However, the visible explanatory card still says `Drawer contains {workspaceName} workspace navigation, Studio links, Workspace settings, and Account settings.` This omits Run and does not state the required order.

Affected files:

- `/var/www/wireframes-floom/v24/studio-empty.html:146`
- `/var/www/wireframes-floom/v24/studio-apps.html:136`
- `/var/www/wireframes-floom/v24/studio-runs.html:140`
- `/var/www/wireframes-floom/v24/studio-app-overview.html:153`
- `/var/www/wireframes-floom/v24/studio-app-runs.html:143`
- `/var/www/wireframes-floom/v24/studio-app-secrets.html:140`
- `/var/www/wireframes-floom/v24/studio-app-access.html:141`
- `/var/www/wireframes-floom/v24/studio-app-analytics.html:139`
- `/var/www/wireframes-floom/v24/studio-app-source.html:148`
- `/var/www/wireframes-floom/v24/studio-app-feedback.html:140`
- `/var/www/wireframes-floom/v24/studio-app-triggers.html:141`

### Shared CSS still contains gradient/category residue

`/var/www/wireframes-floom/v24/_v24.css` still violates the no-gradient/category-tint rule:

- `_v24.css:922`: `/* Category gradient backgrounds */`
- `_v24.css:938`: `/* v22 Delta 14: category-tinted run-row icons... */`
- `_v24.css:985`: `/* Delta 11.4: category-tinted run-row icons */`
- `_v24.css:1012`: `.opt.opt-recommended{border:1.5px solid var(--accent);background:linear-gradient(180deg,rgba(4,120,87,0.06),transparent 60%)}`

The `.info-card` gradient residue is gone. The `.opt.opt-recommended` gradient remains live CSS.

## Nits

- `/var/www/wireframes-floom/v24/studio-home.html:160`: the visible v24 delta note still names Team and Billing.
- `/var/www/wireframes-floom/v24/settings-studio.html:133`: the visible v24 delta note still names `launch-hidden member/billing surfaces` and `v1.1`.
- `studio-app-secrets.html` and `studio-app-source.html` now contain all eight mobile app tabs, but the 390px screenshots only show the left portion of the horizontally scrollable strip by default. Source and `overflow-x:auto` verify all eight links exist.

## Previously Open Items

- `studio-app-secrets.html href="#" final cleanup`: resolved.
- `studio-app-secrets.html` mobile app tabs: resolved, 8/8 tabs present.
- `studio-app-source.html` mobile app tabs: resolved, 8/8 tabs present.
- Legacy `/me/*` comments in `_v24.css`: resolved, no `/me/` lines remain in `_v24.css` or the 14 audited HTML files.
- Mobile drawer copy: unresolved, visible stale card text remains on 11 files.
- Shared CSS gradient/category residue: unresolved, `.opt.opt-recommended` still uses `linear-gradient`.

## New In This Re-Audit

No newly introduced route, overflow, console, emoji, `/me/*`, or `href="#"` regression was verified.

Newly listed by this pass: six per-app mobile pages still lack the 8-tab app strip. The prior re-audit listed only `studio-app-secrets.html` and `studio-app-source.html`; current source and screenshots show the broader residual gap.

## Per-File Scores

10 = no remaining issue. Round 5 requires every file at 9.0 or higher.

- `studio-home.html`: 8.8. Shared CSS gradient/category residue and visible Team/Billing note remain.
- `studio-build.html`: 9.0. Shared CSS gradient/category residue remains.
- `settings-studio.html`: 8.8. Shared CSS gradient/category residue and visible billing/v1.1 note remain.
- `studio-empty.html`: 8.2. Stale mobile drawer copy and shared CSS gradient/category residue remain.
- `studio-apps.html`: 8.2. Stale mobile drawer copy and shared CSS gradient/category residue remain.
- `studio-runs.html`: 8.2. Stale mobile drawer copy and shared CSS gradient/category residue remain.
- `studio-app-overview.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.
- `studio-app-runs.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.
- `studio-app-secrets.html`: 8.5. Prior critical link issue fixed and mobile tabs fixed; stale mobile drawer copy and shared CSS gradient/category residue remain.
- `studio-app-access.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.
- `studio-app-analytics.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.
- `studio-app-source.html`: 8.5. Mobile tabs fixed; stale mobile drawer copy and shared CSS gradient/category residue remain.
- `studio-app-feedback.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.
- `studio-app-triggers.html`: 7.8. Mobile 8-tab app strip missing, stale mobile drawer copy, and shared CSS gradient/category residue remain.

## Round 5 Readiness Verdict

NO-GO.

All 14 files are not at 9.0+. Round 5 remains blocked by the missing mobile app tab strip on six per-app files, stale mobile drawer explanatory copy on 11 files, and shared `_v24.css` gradient/category residue.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r4-reaudit-2/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r4-reaudit-2/*-mobile.png`
- Contact sheets with embedded screenshots: `/tmp/v24-r4-reaudit-2/contact-desktop.png`, `/tmp/v24-r4-reaudit-2/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r4-reaudit-2/metrics.json`
- Mobile overflow: every audited file rendered `scrollWidth=390`, `clientWidth=390`, `bodyScrollWidth=390`.
- `pnpm --filter @floom/web typecheck`: passed.
- `pnpm --filter @floom/server typecheck`: passed.
- `pnpm typecheck`: passed; Turbo reported `7 successful, 7 total`.
- HTML tag balance: passed for all 14 files.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 14 files: `studio-home.html`, `studio-build.html`, `settings-studio.html`, `studio-empty.html`, `studio-apps.html`, `studio-runs.html`, `studio-app-overview.html`, `studio-app-runs.html`, `studio-app-secrets.html`, `studio-app-access.html`, `studio-app-analytics.html`, `studio-app-source.html`, `studio-app-feedback.html`, and `studio-app-triggers.html`.
- Verified screenshots show rendered wireframes, not loading states or broken contact-sheet images. The first contact-sheet generation had broken image refs; it was regenerated with embedded screenshot data and re-opened visually.
- Verified source scans for canonical route fields, Copy-for-Claude labels/snippets, banned vocabulary, emoji candidates, `/me/*`, `href="#"`, missing local links, mobile drawer text, mobile tab strips, and shared CSS gradient/category rules.
- Verified the prior critical item and two prior mobile-tab examples are fixed.
- Verified residual issues listed above have concrete source-line or screenshot evidence.
