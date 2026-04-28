# v24 Round 4 Wireframe Audit
Date: 2026-04-27
Auditor: Codex
Scope: 14 Studio mode files

## Critical Issues (block Round 5)

### Global

- `/var/www/wireframes-floom/v24/`: Playwright mobile verification found horizontal overflow on all 14 audited Round 4 files. Evidence at 390px viewport: every file rendered `scrollWidth=407` and `clientWidth=390`; `.frame-mobile` rendered at `x=32`, `width=375`, so it extends 17px past the viewport. Screenshots and metrics are saved in `/tmp/v24-r4-audit-screens/`.
- `/var/www/wireframes-floom/v24/`: HTML tag-balance check passed for all 14 files.
- `/var/www/wireframes-floom/v24/`: TopBar `Run | Studio` with `Studio` active passed for all 14 desktop frames.
- `/var/www/wireframes-floom/v24/`: all 14 files reference `./_v24.css`.

### URL Family / Route Compliance

- `/var/www/wireframes-floom/v24/studio-empty.html:62`: visible page H1 uses `/v24/studio-empty.html` instead of a canonical `/studio/*` URL.
- `/var/www/wireframes-floom/v24/studio-apps.html:62`: visible page H1 uses `/v24/studio-apps.html` instead of `/studio/apps`.
- `/var/www/wireframes-floom/v24/studio-runs.html:62`: visible page H1 uses `/v24/studio-runs.html` instead of `/studio/runs`.
- `/var/www/wireframes-floom/v24/studio-app-overview.html:62`: visible page H1 uses `/v24/studio-app-overview.html` instead of a canonical `/studio/apps/:slug` URL.
- `/var/www/wireframes-floom/v24/studio-app-runs.html:62`: visible page H1 uses `/v24/studio-app-runs.html` instead of `/studio/apps/:slug/runs`.
- `/var/www/wireframes-floom/v24/studio-app-secrets.html:62`: visible page H1 uses `/v24/studio-app-secrets.html` instead of `/studio/apps/:slug/secrets`.
- `/var/www/wireframes-floom/v24/studio-app-access.html:62`: visible page H1 uses `/v24/studio-app-access.html` instead of `/studio/apps/:slug/access`.
- `/var/www/wireframes-floom/v24/studio-app-analytics.html:62`: visible page H1 uses `/v24/studio-app-analytics.html` instead of `/studio/apps/:slug/analytics`.
- `/var/www/wireframes-floom/v24/studio-app-source.html:62`: visible page H1 uses `/v24/studio-app-source.html` instead of `/studio/apps/:slug/source`.
- `/var/www/wireframes-floom/v24/studio-app-feedback.html:62`: visible page H1 uses `/v24/studio-app-feedback.html` instead of `/studio/apps/:slug/feedback`.
- `/var/www/wireframes-floom/v24/studio-app-triggers.html:62`: visible page H1 uses `/v24/studio-app-triggers.html` instead of `/studio/apps/:slug/triggers`.
- `/var/www/wireframes-floom/v24/studio-app-overview.html:68`, `/var/www/wireframes-floom/v24/studio-app-runs.html:68`, `/var/www/wireframes-floom/v24/studio-app-secrets.html:68`, `/var/www/wireframes-floom/v24/studio-app-access.html:68`, `/var/www/wireframes-floom/v24/studio-app-analytics.html:68`, `/var/www/wireframes-floom/v24/studio-app-source.html:68`, `/var/www/wireframes-floom/v24/studio-app-feedback.html:68`, `/var/www/wireframes-floom/v24/studio-app-triggers.html:68`: chrome URLs use `floom.dev/studio/flyfast...`; L3 routes the per-app Studio family under `/studio/apps/:slug/*`.

### Locked Vocabulary / Banned Copy

- `/var/www/wireframes-floom/v24/studio-runs.html:110`: H1 contains banned `your workspace` in `All runs across your workspace`. This also exposes a spec conflict: the Round 4 checklist bans `your workspace`, while the L3 per-file delta asks for this exact H1.
- `/var/www/wireframes-floom/v24/studio-app-secrets.html:125`: visible lock emoji `🔒` violates the no-emojis color/palette rule.

### Copy-for-Claude Popover Compliance

- `/var/www/wireframes-floom/v24/studio-apps.html:77`: row-three label is `LIST WORKSPACE APPS`; required label is `STUDIO APPS`.
- `/var/www/wireframes-floom/v24/studio-runs.html:77`: row-three label is `WORKSPACE RUNS`; required label is `STUDIO RUNS`. The row-three snippet also omits `floom_agent_••••••`.
- `/var/www/wireframes-floom/v24/studio-app-overview.html:77`: row-three label is `FOR FLYFAST`; required label is `FOR THIS APP` or `STUDIO APP`.
- `/var/www/wireframes-floom/v24/studio-app-runs.html:77`: row-three label is `FLYFAST RUNS`; required label is `STUDIO APP RUNS`.
- `/var/www/wireframes-floom/v24/studio-app-secrets.html:77`: row-three label is `APP CREATOR SECRETS`; required label is `MANAGE APP CREATOR SECRETS`.
- `/var/www/wireframes-floom/v24/studio-app-access.html:77`: row-three label is `APP ACCESS`; required label is `STUDIO APP ACCESS`.
- `/var/www/wireframes-floom/v24/studio-app-analytics.html:77`: row-three label is `APP ANALYTICS`; required label is `STUDIO APP ANALYTICS`.
- `/var/www/wireframes-floom/v24/studio-app-source.html:77`: row-three label is `APP SOURCE`; required label is `STUDIO APP SOURCE`.
- `/var/www/wireframes-floom/v24/studio-app-feedback.html:77`: row-three label is `APP FEEDBACK`; required label is `STUDIO APP FEEDBACK`.

### Link / Action Integrity

- `/var/www/wireframes-floom/v24/studio-app-secrets.html:121`: primary CTA `+ Add app creator secret` is an anchor with `href="#"`, not a real file, canonical route, modal trigger, or explicit inert wireframe marker.

## Important Issues (fix before Round 5)

### Global / Shell

- `/var/www/wireframes-floom/v24/_v24.css:1041-1044`: `.ws-identity` uses `padding:8px 16px 8px`; L3 requires desktop padding `16px 16px 12px`. Rendered desktop evidence shows border-box height `57px` for `.ws-identity` on all 14 files.
- `/var/www/wireframes-floom/v24/_v24.css:924-944,993,1012`: old gradient/category tint styles remain in the shared stylesheet. Round 4 screenshots do not visibly use category-tint app banners, but the stylesheet still violates the no-category-tint/no-gradient palette rule.
- `/var/www/wireframes-floom/v24/studio-home.html:153`, `/var/www/wireframes-floom/v24/studio-empty.html:146`, `/var/www/wireframes-floom/v24/studio-apps.html:136`, `/var/www/wireframes-floom/v24/studio-runs.html:139`, `/var/www/wireframes-floom/v24/studio-app-overview.html:153`, `/var/www/wireframes-floom/v24/studio-app-runs.html:143`, `/var/www/wireframes-floom/v24/studio-app-secrets.html:140`, `/var/www/wireframes-floom/v24/studio-app-access.html:141`, `/var/www/wireframes-floom/v24/studio-app-analytics.html:139`, `/var/www/wireframes-floom/v24/studio-app-source.html:148`, `/var/www/wireframes-floom/v24/studio-app-feedback.html:140`, `/var/www/wireframes-floom/v24/studio-app-triggers.html:141`: mobile drawer text says the drawer contains workspace navigation, Studio links, Workspace settings, and Account settings, but it does not show the required order or include `Run`.
- `/var/www/wireframes-floom/v24/settings-studio.html:121`: mobile Studio settings description drops `Workspace credentials live in BYOK keys and Agent tokens.`

### Placeholder Links

- `/var/www/wireframes-floom/v24/studio-home.html:81-84,120-123,149-150`, `/var/www/wireframes-floom/v24/studio-empty.html:94-97`, `/var/www/wireframes-floom/v24/studio-apps.html:95-98`, `/var/www/wireframes-floom/v24/studio-runs.html:94-97`, and `/var/www/wireframes-floom/v24/studio-app-overview.html:95-98`: app-list entries use `href="#"`.
- `/var/www/wireframes-floom/v24/studio-build.html:102-104`: example source cards use `href="#"`.
- `/var/www/wireframes-floom/v24/studio-app-overview.html:121`: `Edit` uses `href="#"`.
- `/var/www/wireframes-floom/v24/studio-app-access.html:126`: invite action uses `href="#"`.
- `/var/www/wireframes-floom/v24/studio-app-source.html:134`: `Edit manifest` uses `href="#"`.

### Mobile / Visual Evidence

- `/tmp/v24-r4-audit-screens/contact-mobile.png`: rendered mobile boards show the same overflow root cause across all files. The mobile frame is visually shifted right, leaving the page clipped at 390px.
- `/tmp/v24-r4-audit-screens/contact-mobile.png`: several mobile app pages collapse the per-app tab strip rather than showing the full Overview, Runs, Creator secrets, Access, Analytics, Source, Feedback, Triggers set. Concrete examples: `/var/www/wireframes-floom/v24/studio-app-secrets.html:139` shows only four tabs; `/var/www/wireframes-floom/v24/studio-app-source.html:147` shows six tabs.

## Nits (defer or fix opportunistically)

- `/var/www/wireframes-floom/v24/studio-build.html:121-122`: checkmark glyphs render as text symbols in the stage rows. They are not emoji-rendered in the screenshot, but icon components would keep the no-emoji rule cleaner.
- `/var/www/wireframes-floom/v24/settings-studio.html:108`: v1.1 Team/Billing note remains visible. It is not a Team/Billing panel, but it reintroduces launch-hidden concepts on the v1 settings screen.
- `/var/www/wireframes-floom/v24/studio-home.html:105`: `Runs across all your apps` is not on the explicit banned list, but it keeps personal phrasing inside the Studio dashboard.

## Per-file scores (0-10)

10 = no issues. Below 8 = needs rework before Round 5.

- `studio-home.html`: 7.0. Mobile overflow, workspace identity padding drift, drawer-order omission, and multiple `href="#"` app links.
- `studio-build.html`: 7.0. Mobile overflow, workspace identity padding drift, `href="#"` example cards, and text-symbol checkmarks.
- `settings-studio.html`: 7.5. Mobile overflow, workspace identity padding drift, mobile description missing the credential sentence, and visible v1.1 Team/Billing note.
- `studio-empty.html`: 6.5. Visible `/v24/studio-empty.html` page H1, mobile overflow, drawer-order omission, and placeholder app links.
- `studio-apps.html`: 6.0. Visible `/v24/studio-apps.html` page H1, wrong Copy-for-Claude row-three label, mobile overflow, drawer-order omission, and placeholder app links.
- `studio-runs.html`: 5.5. Visible `/v24/studio-runs.html` page H1, banned `your workspace`, wrong Copy-for-Claude label, missing `floom_agent_••••••` in row three, mobile overflow, and drawer-order omission.
- `studio-app-overview.html`: 5.5. Visible `/v24/studio-app-overview.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, placeholder edit link, mobile overflow, and drawer-order omission.
- `studio-app-runs.html`: 5.5. Visible `/v24/studio-app-runs.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, mobile overflow, and drawer-order omission.
- `studio-app-secrets.html`: 5.0. Visible `/v24/studio-app-secrets.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, emoji, dead primary CTA href, partial mobile tab strip, mobile overflow, and drawer-order omission.
- `studio-app-access.html`: 5.5. Visible `/v24/studio-app-access.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, placeholder invite action, mobile overflow, and drawer-order omission.
- `studio-app-analytics.html`: 5.5. Visible `/v24/studio-app-analytics.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, mobile overflow, and drawer-order omission.
- `studio-app-source.html`: 5.5. Visible `/v24/studio-app-source.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, placeholder edit-manifest action, partial mobile tab strip, mobile overflow, and drawer-order omission.
- `studio-app-feedback.html`: 5.5. Visible `/v24/studio-app-feedback.html` page H1, chrome URL missing `/apps`, wrong Copy-for-Claude label, mobile overflow, and drawer-order omission.
- `studio-app-triggers.html`: 6.0. Visible `/v24/studio-app-triggers.html` page H1, chrome URL missing `/apps`, mobile overflow, and drawer-order omission. Row-three `RUN TRIGGERS` is acceptable only if product accepts it as the allowed reasonable variant.

## Round 5 readiness verdict

NO-GO. Round 5 is blocked by confirmed mobile horizontal overflow on all 14 files, visible noncanonical `/v24/*.html` page H1 URLs, per-app chrome URLs missing `/studio/apps/:slug/*`, incorrect Copy-for-Claude row-three labels, a banned `your workspace` string, and an emoji in `studio-app-secrets.html`.

## Self-Review v1

- Verified all 14 requested files were read fully: `studio-home.html`, `studio-build.html`, `settings-studio.html`, `studio-empty.html`, `studio-apps.html`, `studio-runs.html`, `studio-app-overview.html`, `studio-app-runs.html`, `studio-app-secrets.html`, `studio-app-access.html`, `studio-app-analytics.html`, `studio-app-source.html`, `studio-app-feedback.html`, and `studio-app-triggers.html`.
- Verified source scans for URL-family markers, banned vocabulary, Copy-for-Claude labels/snippets, per-app tab labels, local href targets, emoji candidates, and L3 per-file deltas.
- Verified rendered desktop and mobile screenshots with Playwright at 1440x900 and 390x844. Screenshots: `/tmp/v24-r4-audit-screens/*.png`; contact sheets: `/tmp/v24-r4-audit-screens/contact-desktop.png` and `/tmp/v24-r4-audit-screens/contact-mobile.png`; metrics: `/tmp/v24-r4-audit-screens/metrics.json`.
- Verified no page-level JavaScript errors. One transient font/resource console error appeared on one screenshot pass and did not affect loaded UI content.
- Verified HTML tag balance passed for all 14 files.
- Verified no missing local file targets among non-placeholder `./*.html` links. Placeholder `href="#"` entries remain listed above.
- Verified `pnpm --filter @floom/web typecheck` exited 0.
- Verified `pnpm --filter @floom/server typecheck` exited 0.
- Adversarial pass found one checklist conflict: L3 requires `All runs across your workspace`, while the locked vocabulary checklist bans `your workspace`. I treated the locked vocabulary rule as blocking because the audit prompt explicitly defines banned user-facing copy.
