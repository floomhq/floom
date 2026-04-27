# v26 / launch feedback log — 2026-04-27

Federico's running feedback as he reviews `mvp.floom.dev` and `v26.floom.dev`. This is the source of truth so nothing falls through cracks. Each item: source screenshot (path), description, status (OPEN/IN-FLIGHT/FIXED), agent owning it.

## launch-mvp track (mvp.floom.dev)

| # | Source | Issue | Status | Agent |
|---|---|---|---|---|
| M1 | SS 10.57.37 | Login page primitive: empty right column + awkward "No password" copy + "you are in the right place" line | OPEN — held until M2/M3 verified, agent ac487988 stalled, M1 separate run needed | next round |
| M2 | SS 10.58.01 | Stubbed pages should redirect to `/me/agent-keys`, not show ComingSoon card | FIXED — 16 redirect commits c409dd5a..a1af0e01, mvp container redeployed asset B61LaRdr | a3e424eb2b8121df1 |
| M3 | (implied) | Post-auth default landing should be `/me/agent-keys`, not `/run/apps` | FIXED — 84d63da3 LoginPage L70 safeNext default → /me/agent-keys | a3e424eb2b8121df1 |
| M4 | (implied) | UX audit of all MVP-visible pages | OPEN — held until M2/M3 verified | next round |
| M5 | (verbal Q) | mvp.floom.dev / landing is the FULL marketing landing — too full for MVP scope (sign up → mint MCP token). Should be slim landing with one big hero CTA + brief explanation. | FIXED a3e17fc9 — `LandingMVPPage.tsx` created; `main.tsx` on `launch-mvp` wires `/` → `LandingMVPPage`, `/marketing` → `LandingV17Page`; hero + 3-step explainer + mini footer | this session |

## v26 polish track (v26.floom.dev, branch `ui/v23-p-slug-runsurface`)

| # | Source | Issue | Status | Agent |
|---|---|---|---|---|
| V1 | (verbal) | `/run/apps` + `/studio/apps` need UX work (empty states, stat rows, mode-specific CTAs) | IN-FLIGHT | a50aa3eea1abdc340 |
| V2 | SS 10.59.51 | Rail-bottom avatar+sign-out should not exist (avatar lives in TopBar only per §12.5) | IN-FLIGHT | a5c369123e7f99eb2 |
| V3 | SS 10.59.51 | No black terminal backgrounds — use `#1b1a17` warm dark | IN-FLIGHT | a5c369123e7f99eb2 |
| V4 | SS 11.00.53 | Studio Build "Run sample" fails with "App not found: example-api" | IN-FLIGHT | a5c369123e7f99eb2 |
| V5 | SS 11.01.36 | Sidebar + content containers shift between pages — should be static | IN-FLIGHT | ad00414ed0b97c8ed |
| V6 | SS 11.02.31 | "Copy for Claude" stacks 3 install methods, overwhelming — refactor to tabs (Claude/Cursor/Codex/CLI) | IN-FLIGHT | aff6d47e69f9fcc05 |
| V7 | (verbal) | `/p/:slug` not updated to v26 chrome | IN-FLIGHT (may already be v26 — check SS 11.04.35) | aff6d47e69f9fcc05 |
| V8 | (verbal) | No "+ Install in workspace" CTA on `/p/:slug` for authed users | IN-FLIGHT | aff6d47e69f9fcc05 |
| V9 | SS 11.04.16 | Footer cluttered: 13 links across 3 columns, redundancy (Cookies/Legal, Status/Changelog), wrong tag "Built in SF" | FIXED 074f467a — slim 3-col (Product: Apps/Docs/Pricing/Changelog, Company: About/GitHub/Status, Legal: Terms/Privacy); dropped Cookies, Legal, Runtime limits, Security | this session |
| V10 | SS 11.04.35 | Run on `/p/ai-readiness-audit` fails with `run_8wda96xryr1d` — `floom_internal_error` | FIXED cfc2d085 — root cause: `listen EADDRNOTAVAIL 172.25.0.1` (gateway IP not available inside server container); fix: connect server container to run network, listen 0.0.0.0, expose container IP; verified run_jry5mxd5cgg8 success | this session |
| V11 | SS 11.05.45 | Header nav not clean — `Studio` + `My runs` + GitHub `6` badge shouldn't be in TopBar (per §12.5: slim TopBar = floom + Copy-for-Claude + + New app + avatar) | FIXED 074f467a — removed authed centre nav (Studio/My runs) and GitHub badge from authed state; anon TopBar unchanged | this session |
| V12 | SS 11.06.40 | Click on app card on `/run/apps` goes to `/p/:slug` (public) — should go to private workspace view `/run/apps/:slug` | FIXED a860a79c — `SlugToRunRedirect` component in `main.tsx` routes `/run/apps/:slug` → `/run/apps/:slug/run`; AppsList href fixed by ee51dd14 | this session |
| V13 | SS 11.06.40 | Counter mismatch: rail says "Apps 0", content stat says "Apps 1 installed" — different sources of truth | FIXED a860a79c — `RunRail` now uses `useMyRuns` hook (run history) instead of `useMyApps` (creator apps); count = unique app_slugs in run history | this session |
| V14 | SS 11.06.40 | Auto-install on first run: ran public app once → it now appears in workspace as "installed" without explicit claim. Either: (a) language wrong (call it "recently used" not "installed"), or (b) require explicit Install action | FIXED ee51dd14 — stat label changed from "installed" to "in workspace" | this session |
| V15 | SS 11.06.40 | Stat "RUNS 7D" shows `—` despite "last run just now" on the same page — stat not refreshing after new run | FIXED ee51dd14 — `runs7d` computed from already-fetched `useMyRuns` data (filter by started_at >= now-7d); no separate fetch needed | this session |
| V16 | (verbal) | Black-bg sweep must cover ALL pages incl `/docs`, `/apps`, `/pricing`, marketing — not just app surfaces | FIXED dd8b23a4 — `--terminal-bg` in wireframe.css updated #0e0e0c→#1b1a17; swept all TSX/CSS: zero pure #000/bg-black/bg-zinc-950 anywhere; deployed v26 verified | this agent |
| V17 | (verbal) | `/docs` has the same sidebar/content shift bug as /run/studio (layout shifts based on content width) | FIXED dd8b23a4 — `DocsPageShell` (flex + fixed 260px sidebar, mirrors WorkspacePageShell); DocsLandingPage+DocsPage migrated; deployed v26 verified | this agent |
| V18 | GH #850 #856 | MCP rejects JSON-only clients — `Accept: application/json` without `text/event-stream` returns 406 Not Acceptable | FIXED e8566da9 — patch incoming POST request to add `text/event-stream` to Accept header before handing off to SDK transport; `enableJsonResponse: true` already ensures JSON response | this session |
| V20 | GH #849 | Email signup broken — returns `token: null` + subsequent sign-in returns `403 EMAIL_NOT_VERIFIED` | FIXED 1992f43c — set `requireEmailVerification: false` + `autoSignIn: true` in Better Auth config; v1.1 will re-enable verification with full UX | this session |
| V22 | GH #852 | `/api/healthz` returns 404 everywhere (floom.dev, v26, mvp) | FIXED 73c71080 — new GET `/api/healthz` route returning `ok`, `deploy_enabled`, `uptime_seconds`, `version`; exempt from FLOOM_AUTH_TOKEN gate | this session |
| R1 | GH #882 | Analytics tab shows "Coming v1.1" — backend data exists | FIXED fac199e6+f8253d1c — GET /api/hub/:slug/analytics endpoint + 5 stat cards + 7-day sparkline UI | this session |
| R2 | GH #881 | /studio/:slug/feedback returns 404 | FIXED fac199e6+2e144411 — GET /api/hub/:slug/feedback endpoint (owner-only, returns app_reviews with summary) + feedback list UI | this session |
| R3 | GH #883 | App version not displayed on /p/:slug | ALREADY DONE — hub.ts:977 returns `version: manifestVersion \|\| '0.1.0'`; AppPermalinkPage.tsx:902 renders `v{app.version}` chip in hero-version-meta row. No code change needed. | this session |
| X5 | (verbal) | MCP testing scope = unauth (public store directory + run public apps) + authed (user-specific apps, create app, workspace switching) | IN-FLIGHT | a800539bb5a2eab58 (claude) + codex (codex bg) |
| X7 | (verbal) | Run MCP/CLI tests with BOTH claude AND codex independently, diff findings | IN-FLIGHT | claude=a800539bb5a2eab58, codex=bg |
| X6 | (verbal Q→confirmed) | Any public-visibility app is runnable at `/p/:slug` for anyone — by design. Private apps (only_me) return 404 to outsiders. | CONFIRMED | n/a |

## Cross-cutting

| # | Source | Issue | Status | Owner |
|---|---|---|---|---|
| X1 | SS 10.59.51 | "Built in SF" tag misleading — Federico in Hamburg moving to SF | FIXED 074f467a — removed location tag, footer now just "Ship AI apps fast." | this session |
| X2 | (verbal) | ICP scenarios A/B/C/D/E full headless testing on v26 + mvp | IN-FLIGHT | a33659defe804b805 |
| X3 | (verbal) | Schema additions ADR-34 (`unlisted` tier) + ADR-35 (`password_hash`) | OPEN | awaiting Federico's approval |
| X4 | (verbal) | Triage 16 P1/P2 ICP-test issues (#829-#844) | OPEN | Federico AM triage |

## Agents currently running

| Agent | Track | Files |
|---|---|---|
| ac487988005004b26 | mvp UX | LoginPage + stubbed pages → redirects |
| a50aa3eea1abdc340 | v26 dashboards | MeAppsPage, StudioHomePage / StudioAppsPage |
| a5c369123e7f99eb2 | v26 fixes | RunRail, StudioRail, MobileDrawer, Studio Build flow |
| ad00414ed0b97c8ed | v26 layout | WorkspacePageShell migration |
| aff6d47e69f9fcc05 | v26 UX | CopyForClaudeButton + AppPermalinkPage |
| a33659defe804b805 | testing | scenario A-E across v26 + mvp |

## How to use this log
- Update on every Federico screenshot/feedback.
- Each item gets a unique ID (M1, V1, X1) for cross-reference.
- Agent IDs are short hex from the Task tool.
- Mark FIXED only after redeploy + Federico ack.
