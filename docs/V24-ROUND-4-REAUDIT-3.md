# v24 Round 4 Wireframe Re-Audit 3

Date: 2026-04-27
Auditor: Codex
Scope: 14 Round 4 Studio files plus shared `/var/www/wireframes-floom/v24/_v24.css`

Audit path: `/tmp/v24-r4-reaudit-3/`

## Checklist Re-Run

All 15 Round 4 audit rules were re-run across the 14-file scope:

1. Exact 14-file scope exists and each file references `./_v24.css`: pass.
2. HTML tag balance: fail on `settings-studio.html`; pass on the other 13 files.
3. Desktop TopBar shows `Run | Studio` with Studio active: pass on all 14 files.
4. Visible board H1 paths use canonical `/studio/*` and `/settings/studio` URLs: pass.
5. Desktop chrome URLs use canonical browser URLs, including `/studio/apps/flyfast/*`: pass.
6. No visible `/v24/*.html` route leakage remains in audited route fields: pass.
7. Copy-for-Claude row-three labels match the accepted Round 4 labels: pass.
8. Copy-for-Claude snippets use `floom_agent_......`; `studio-runs.html` includes `floom runs list --workspace`: pass.
9. Locked vocabulary scan covers `My account`, `your account`, `your workspace`, legacy token prefixes, and `/me/*`: pass across the 14 HTML files.
10. Link integrity scan covers `href="#"`, `#wireframe-inert`, and missing local `./*.html` targets: pass.
11. No emoji UI glyphs remain in the 14 HTML files: pass.
12. Studio sidebar identity and settings groups match the shared Studio sidebar contract: pass.
13. `.ws-identity` desktop padding and rendered dimensions were measured: pass; padding is `16px 16px 12px 16px`, desktop height is `63.90625px`.
14. Mobile overflow was measured at 390x844 with Playwright: pass; every page rendered `scrollWidth=390`, `clientWidth=390`, `bodyScrollWidth=390`.
15. Mobile drawer/tabs, settings-specific deltas, and shared palette/gradient rules were re-checked: pass for rendered drawer/tabs and live CSS gradients; nit remains for stale category/gradient comments in shared CSS.

## Critical

None.

## Important

### `settings-studio.html` fails HTML tag balance

`/var/www/wireframes-floom/v24/settings-studio.html:133` has an unclosed `<code>` tag in the final annotation block:

`<li><strong>Removed</strong>: v23 <code>multi-member surfaces and transfer/delete panels (deferred).</li>`

The tag-balance scan produced six cascading errors from that line:

- line 133: expected `</code>` before `</li>`
- line 133: expected `</li>` before `</ul>`
- line 133: expected `</ul>` before `</div>`
- line 135: expected `</div>` before `</body>`
- line 136: expected `</body>` before `</html>`
- line 2: unclosed `<html>`

Playwright still renders the page, but the source fails rule 2. This blocks a 9.0+ score for `settings-studio.html`.

## Nits

### Shared CSS still contains stale category/gradient comments

`/var/www/wireframes-floom/v24/_v24.css` no longer contains `linear-gradient`, including the prior `.info-card` and `.opt.opt-recommended` failures. The live CSS gradient issue is resolved.

Stale comment residue remains:

- `_v24.css:922`: `/* Category gradient backgrounds */`
- `_v24.css:938`: `/* v22 Delta 14: category-tinted run-row icons (research/writing aliases) */`
- `_v24.css:985`: `/* -- Delta 11.4: category-tinted run-row icons -- */`

This is documentation residue inside CSS, not rendered UI.

## Previously Open Items

- Legacy `Drawer contains...` copy from 11 files: resolved. Source scan found zero matches across the 14 files.
- Six per-app mobile screens missing the 8-tab app strip: resolved. Playwright and source scans show `Overview`, `Runs`, `Creator secrets`, `Access`, `Analytics`, `Source`, `Feedback`, and `Triggers` on all eight per-app mobile pages.
- Final live CSS `linear-gradient` instances in `.info-card` and `.opt.opt-recommended`: resolved. `_v24.css` contains zero `linear-gradient` matches.
- Visible Team/Billing/v1.1 references in `studio-home.html` and `settings-studio.html`: resolved. Source scan found no `Team`, `Billing`, or `v1.1` matches in the two softened annotations.
- Prior `href="#"` issue in `studio-app-secrets.html`: resolved. Source scan found zero `href="#"` matches across the 14 files.

## New In This Re-Audit

- `settings-studio.html:133` now fails tag balance due to the unclosed `<code>` tag listed above.

No new route, overflow, console, emoji, `/me/*`, Copy-for-Claude, drawer-order, mobile-tab, missing-link, or live CSS gradient regression was verified.

## Per-File Scores

10 = no remaining issue. Round 5 requires every file at 9.0 or higher.

- `studio-home.html`: 9.5. Prior Team/Billing note is gone; only shared stale CSS comment residue remains.
- `studio-build.html`: 9.6. No file-specific issue found; only shared stale CSS comment residue remains.
- `settings-studio.html`: 8.8. HTML tag balance fails at line 133; prior Team/Billing/v1.1 note is gone.
- `studio-empty.html`: 9.7. Drawer copy/order issue is resolved; no file-specific issue found.
- `studio-apps.html`: 9.7. Drawer copy/order issue is resolved; no file-specific issue found.
- `studio-runs.html`: 9.7. Drawer copy/order issue is resolved; no file-specific issue found.
- `studio-app-overview.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-runs.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-secrets.html`: 9.6. Prior `href="#"`, mobile 8-tab strip, and drawer copy/order issues are resolved.
- `studio-app-access.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-analytics.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-source.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-feedback.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.
- `studio-app-triggers.html`: 9.6. Mobile 8-tab strip and drawer copy/order issues are resolved.

## Round 5 Verdict

NO-GO.

All 14 files are not at 9.0+. `settings-studio.html` is at 8.8 because rule 2, HTML tag balance, fails at line 133.

## Verification Evidence

- Playwright desktop screenshots: `/tmp/v24-r4-reaudit-3/*-desktop.png`
- Playwright mobile screenshots: `/tmp/v24-r4-reaudit-3/*-mobile.png`
- Contact sheets: `/tmp/v24-r4-reaudit-3/contact-desktop.png`, `/tmp/v24-r4-reaudit-3/contact-mobile.png`
- Render/source metrics: `/tmp/v24-r4-reaudit-3/metrics.json`
- Playwright console/page errors: zero across 28 captures.
- Mobile overflow: every audited file rendered `scrollWidth=390`, `clientWidth=390`, `bodyScrollWidth=390`.
- `pnpm typecheck`: passed; Turbo reported `7 successful, 7 total`.

## Self-Review

Confirmed this self-review was performed before finalizing.

- Re-checked all 14 files: `studio-home.html`, `studio-build.html`, `settings-studio.html`, `studio-empty.html`, `studio-apps.html`, `studio-runs.html`, `studio-app-overview.html`, `studio-app-runs.html`, `studio-app-secrets.html`, `studio-app-access.html`, `studio-app-analytics.html`, `studio-app-source.html`, `studio-app-feedback.html`, and `studio-app-triggers.html`.
- Verified screenshots show rendered wireframes, not loading states or blank pages.
- Verified source scans for canonical H1 paths, chrome URLs, Copy-for-Claude labels/snippets, banned vocabulary, emoji candidates, `/me/*`, `href="#"`, missing local links, mobile drawer text, mobile tab strips, settings annotations, and shared CSS gradient rules.
- Verified the issues from `V24-ROUND-4-REAUDIT-2.md` are resolved.
- Verified the remaining issue has concrete source-line evidence.
- Verified `pnpm typecheck` passed.
