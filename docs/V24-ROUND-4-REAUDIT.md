# v24 Round 4 Wireframe Re-Audit
Date: 2026-04-27
Auditor: Codex
Scope: 14 Studio mode files plus shared `_v24.css`

Screenshots and rendered metrics: `/tmp/v24-r4-reaudit/`

## Checklist Re-Run

All 15 Round 4 audit checks were re-run:

1. Exact 14-file scope exists and each file references `./_v24.css`.
2. HTML parses without parser errors.
3. Desktop TopBar shows `Run | Studio` with `Studio` active.
4. Visible board H1 paths use canonical `/studio/*` and `/settings/studio` URLs.
5. Desktop chrome URLs use canonical browser URLs, including `/studio/apps/flyfast/*`.
6. No visible `/v24/*.html` route leakage remains in the audited H1/chrome route fields.
7. Copy-for-Claude row-three labels match the Round 4 spec.
8. Copy-for-Claude snippets use `floom_agent_••••••`; `studio-runs.html` includes it plus `floom runs list --workspace`.
9. Locked vocabulary scan covers `My account`, `your account`, `your workspace`, legacy token prefixes, `BYOK keys`, `Agent tokens`, and `App creator secrets`.
10. Link integrity scan covers `href="#"`, explicit `#wireframe-inert`, and missing local `./*.html` targets.
11. No emoji UI glyphs remain in the 14 HTML files.
12. Studio sidebar identity and settings groups match the shared Studio sidebar contract.
13. `.ws-identity` desktop padding and rendered content height were measured.
14. Mobile overflow was measured at 390x844 with Playwright.
15. Mobile drawer/tabs, settings-specific deltas, and shared palette/gradient rules were re-checked.

## Critical Issues

- `/var/www/wireframes-floom/v24/studio-app-secrets.html:95-98,121`: five `href="#"` placeholders remain. Four are app-list rail rows (`opendraft`, `competitor-lens`, `pitch-coach`, `ai-readiness-audit`) and one is the primary `+ Add app creator secret` CTA. This keeps link/action integrity blocked because every other audited file now uses either a real local file target or `#wireframe-inert`.

## Important Issues

- `/var/www/wireframes-floom/v24/studio-empty.html:146`, `studio-apps.html:136`, `studio-runs.html:140`, `studio-app-overview.html:153`, `studio-app-runs.html:143`, `studio-app-secrets.html:140`, `studio-app-access.html:141`, `studio-app-analytics.html:139`, `studio-app-source.html:148`, `studio-app-feedback.html:140`, `studio-app-triggers.html:141`: mobile drawer copy still says the drawer contains workspace navigation, Studio links, Workspace settings, and Account settings. It still omits the required explicit order `Workspace`, `Run`, `Studio`, `Workspace settings`, `Account`, and still omits the `Run` group.
- `/var/www/wireframes-floom/v24/studio-app-secrets.html:139`: mobile per-app tab strip still shows only `Overview`, `Runs`, `Creator secrets`, `Access`; required Studio app tabs are incomplete.
- `/var/www/wireframes-floom/v24/studio-app-source.html:147`: mobile per-app tab strip still shows only `Overview`, `Runs`, `Creator secrets`, `Access`, `Analytics`, `Source`; `Feedback` and `Triggers` remain absent.
- `/var/www/wireframes-floom/v24/_v24.css:311,924,926,944,993,1012`: shared stylesheet still contains gradient backgrounds/category tint styles. Round 4 screenshots do not visibly use all of them, but the shared v24 stylesheet still violates the no-gradient/category-tint palette rule from the prior audit.

## Nits

- `/var/www/wireframes-floom/v24/settings-studio.html:133`: the visible v24 delta note still names `Team · 3`, `Billing`, and `v1.1`.
- `/var/www/wireframes-floom/v24/studio-home.html:160`: the visible v24 delta note still names `Team` and `Billing`.
- `/var/www/wireframes-floom/v24/_v24.css:1072`: shared CSS comment still contains `/me/secrets`, `/me/agent-keys`, and `/me/settings`. No `/me/*` string appears in the 14 audited HTML files.
- `/var/www/wireframes-floom/v24/studio-build.html:121-122`: checkmark text symbols remain in the stage rows. They did not render as emoji in the Playwright screenshots.
- `/var/www/wireframes-floom/v24/studio-home.html:105`: `Runs across all your apps` remains personal phrasing. It is not on the explicit banned list, but it keeps the previous nit alive.

## Verified Fixed

- H1 paths are canonical across all 14 files.
- Desktop chrome URLs are canonical across all 14 files; all 8 per-app pages now include `/studio/apps/flyfast/*`.
- Copy-for-Claude row-three labels match the Round 4 accepted labels across all 14 files.
- `studio-runs.html` row-three snippet includes `floom_agent_••••••`.
- No audited HTML file contains `your workspace`, `My account`, `your account`, `tok_`, `flo_agt_`, or a visible lock emoji.
- Mobile overflow is fixed. At 390x844 every file rendered `scrollWidth=390`, `clientWidth=390`, and `.frame-mobile` at `x=0`, `width=390`, `right=390`.
- `.ws-identity` source padding is `16px 16px 12px`; Playwright measured desktop content height at `34.90625px` and border-box height at `63.90625px` across the audited samples.
- No missing local `./*.html` targets were found.
- No Playwright console or page errors were recorded across the 28 screenshot captures.

## Per-File Scores

10 = no remaining issue. Scores include shared CSS debt where the page imports `_v24.css`.

- `studio-home.html`: 8.5. Shared gradient CSS, visible Team/Billing note, and personal `your apps` phrasing remain.
- `studio-build.html`: 9.0. Shared gradient CSS and text-symbol checkmarks remain.
- `settings-studio.html`: 8.5. Shared gradient CSS and visible `Team · 3` / `Billing` / `v1.1` note remain.
- `studio-empty.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-apps.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-runs.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-overview.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-runs.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-secrets.html`: 6.0. Five `href="#"` placeholders remain, mobile tab set is partial, mobile drawer order is incomplete, and shared gradient CSS remains.
- `studio-app-access.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-analytics.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-source.html`: 7.5. Mobile tab set is partial, mobile drawer order is incomplete, and shared gradient CSS remains.
- `studio-app-feedback.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.
- `studio-app-triggers.html`: 8.0. Mobile drawer order omission and shared gradient CSS remain.

## Round 5 Readiness Verdict

NO-GO.

Round 5 remains blocked by the `href="#"` placeholders in `studio-app-secrets.html`. Even after that is fixed, the Round 4 surface is not at 10/10 until the remaining mobile drawer order omissions, partial mobile app tabs, shared gradient/category-tint CSS, and visible launch-hidden notes are cleared.

## New Issues Introduced By The Fix Pass

No new rendered overflow, console error, route regression, chrome URL regression, Copy-for-Claude regression, or emoji regression was detected.

The fix pass missed `studio-app-secrets.html` link placeholders and did not clear the prior mobile drawer, mobile tab, shared CSS, and visible note debt listed above.

## Self-Review

- Confirmed this self-review was performed before finalizing.
- Re-checked all 14 files: `studio-home.html`, `studio-build.html`, `settings-studio.html`, `studio-empty.html`, `studio-apps.html`, `studio-runs.html`, `studio-app-overview.html`, `studio-app-runs.html`, `studio-app-secrets.html`, `studio-app-access.html`, `studio-app-analytics.html`, `studio-app-source.html`, `studio-app-feedback.html`, and `studio-app-triggers.html`.
- Saved Playwright screenshots at desktop 1440x900 and mobile 390x844 to `/tmp/v24-r4-reaudit/`, including `contact-desktop.png`, `contact-mobile.png`, and `metrics.json`.
- Verified HTML parse succeeded for all 14 audited files.
- Verified `pnpm --filter @floom/web typecheck` exited `0`.
- Verified `pnpm --filter @floom/server typecheck` exited `0`.
- Verified source scans for canonical H1 paths, chrome URLs, Copy-for-Claude labels/snippets, banned vocabulary, `/me/*`, emoji candidates, `href="#"`, missing local links, mobile drawer text, mobile tabs, settings notes, and shared CSS gradient rules.
