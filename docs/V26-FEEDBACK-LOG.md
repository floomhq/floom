# v26 / launch feedback log — 2026-04-27

Federico's running feedback as he reviews `mvp.floom.dev` and `v26.floom.dev`. This is the source of truth so nothing falls through cracks. Each item: source screenshot (path), description, status (OPEN/IN-FLIGHT/FIXED), agent owning it.

## MVP redesign — locked 2026-04-27 (Federico's vision)

Spec doc: `/root/floom/docs/MVP-LAUNCH-PLAYBOOK-2026-04-27.md`. Federico's call: "for mvp why dont you hjust have one big box where you can get agent tokens and thats it? maybe plus instructions on how to get MCP and CLI running"

Full vision: ONE PAGE post-auth = your agent token + MCP install snippet + CLI install snippet. NO rail, NO tabs, NO Studio/BYOK/Members/Billing.

| # | Item | Status | Owner |
|---|---|---|---|
| MVP-R1 | One-box agent-token redesign (kill tabbed shell, kill rail, slim header) | IN-FLIGHT | a21a527cab0694309 |
| MVP-R2 | Restore landing context (M5 was over-cut) — hero + 2-3 paragraphs + 3-step + apps preview | SUPERSEDED by R2-v2 | a21a527cab0694309 (built bare-bones, wrong direction) |
| MVP-R2-v2 | Trim V17 landing to 7 sections (KEEP: TopBar slim, Hero + HeroDemo, WorksWithBelt, AppStripe, HowItWorks 3-step, DiscordCta, slim PublicFooter; DROP: ThreeSurfacesDiagram, CliReference, WorkedExample, PublishCtaBox, DualAudiences, FitBand, PricingTeaser, WhosBehind). Federico locked 2026-04-27. | FIXED | Option A: `variant="mvp"` prop on LandingV17Page. LandingMVPPage is a thin wrapper. |
| MVP-R3 | One subtitle on landing — "Ship AI apps fast." + sub "The protocol and runtime for agentic work." (drop "Vibe-coding speed...") | FIXED | Kicker hidden via `!isMvp` guard in LandingV17Page. Same commit as MVP-R2-v2. |
| MVP-R4 | Drop "Claude" bias from button labels ("Copy for Claude" → "Copy install" / "Get install snippet") | IN-FLIGHT | a21a527cab0694309 |
| MVP-R5 | Header nav slim — drop GitHub badge from primary; anon = floom + Apps + Docs + Help + Sign in/up | IN-FLIGHT | a21a527cab0694309 |
| MVP-R6 | Docs vs Help separate links (currently same URL — bug) | IN-FLIGHT | a21a527cab0694309 |
| MVP-R7 | Drop "I want to run apps" vs "I want to publish apps" choice on signup | IN-FLIGHT | aa70d4ff785e9b4a1 (codex) |
| MVP-R8 | Email/password form visible on /signup (currently shows only Google) | IN-FLIGHT | aa70d4ff785e9b4a1 (codex) |
| MVP-R9 | OAuth redirect_uri fix (BETTER_AUTH_URL env mismatch) | IN-FLIGHT | aa70d4ff785e9b4a1 (codex) |
| MVP-R10 | v26 sign-in "server hiccuped" investigate | IN-FLIGHT | aa70d4ff785e9b4a1 (codex) |
| MVP-R11 | CLI symlink fix + token format double-prefix | IN-FLIGHT | a5b788d02973e59ce |
| MVP-R12 | Book-a-call form next to feedback button | OPEN | needs Federico's cal.com link |
| MVP-R13 | GitHub OAuth setup — Federico needs to create OAuth app + provide creds | OPEN | Federico |
| MVP-R14 | Test stack: claude + codex + kimi cli for cross-validation | OPEN | next round |
| MVP-R-FOOTER | Footer visual density — tighter column spacing, larger/colored social icons, tagline, verify v26 tokens | OPEN | a3fc585cecf411cb7 (item 10) |
| MVP-R-SHARE-OWNER | Share modal visibility section hidden from non-owners (real bug: disabled radio buttons + misleading "PRIVATE" pill) | OPEN | a3fc585cecf411cb7 (item 11) |
| MVP-R-OG | OG image enriched with app name + description + sample output preview + branding (currently flat geometric) | OPEN | a3fc585cecf411cb7 (item 12) |

## v26 track (defer fixes, just document — MVP is P0 today)

Federico: "/run/apps looks exactly like before, where are the ui/ux updates that we made? maybe not pushed? not just for this page but for whole https://v26.floom.dev/"

Possible deploy state issue — confirmed assets are landing (asset hash refreshed), but visual changes may not be visible due to: (a) browser cache, (b) build pipeline didn't rebuild a specific component, (c) CSS scoped wrong, (d) v26 still using old layout components on some pages.

Documented separately:
- v26 header nav too busy (Apps · Docs · Pricing · GitHub 6 · Copy for Claude · Publish · Sign in · Sign up) — needs trim
- v26 visual regressions to investigate post-MVP

## launch-mvp track (mvp.floom.dev)

| # | Source | Issue | Status | Agent |
|---|---|---|---|---|
| M1 | SS 10.57.37 | Login page primitive: empty right column + awkward "No password" copy + "you are in the right place" line | IN-FLIGHT | ac487988005004b26 |
| M2 | SS 10.58.01 | Stubbed pages should redirect to `/me/agent-keys`, not show ComingSoon card | IN-FLIGHT | ac487988005004b26 |
| M3 | (implied) | Post-auth default landing should be `/me/agent-keys`, not `/run/apps` | IN-FLIGHT | ac487988005004b26 |
| M4 | (implied) | UX audit of all MVP-visible pages | IN-FLIGHT | ac487988005004b26 |

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
| V9 | SS 11.04.16 | Footer cluttered: 13 links across 3 columns, redundancy (Cookies/Legal, Status/Changelog), wrong tag "Built in SF" | FIXED | this session |
| V10 | SS 11.04.35 | Run on `/p/ai-readiness-audit` fails with `run_8wda96xryr1d` — `floom_internal_error` | FIXED | this session |
| V11 | SS 11.05.45 | Header nav not clean — `Studio` + `My runs` + GitHub `6` badge shouldn't be in TopBar (per §12.5: slim TopBar = floom + Copy-for-Claude + + New app + avatar) | FIXED | this session |

## Cross-cutting

| # | Source | Issue | Status | Owner |
|---|---|---|---|---|
| X1 | SS 10.59.51 | "Built in SF" tag misleading — Federico in Hamburg moving to SF | FIXED | this session (removed, footer now just "Ship AI apps fast.") |
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

## Fixed in this session (2026-04-27)

- **V11** (TopBar regression): Removed `Studio` + `My runs` links from authenticated centre nav and GitHub badge from authenticated right rail. Per §12.5 spec. Commits: `074f467a`. Files: `apps/web/src/components/TopBar.tsx`.
- **V9** (Footer): Slimmed from 13 links to 9 (Product: Apps/Docs/Pricing/Changelog, Company: About/GitHub/Status, Legal: Terms/Privacy). Dropped Cookies, Legal, Runtime limits, Security. Commit: `074f467a`. Files: `apps/web/src/components/public/PublicFooter.tsx`.
- **X1** ("Built in SF"): Removed location tagline from footer, now just "Ship AI apps fast." Commit: `074f467a`.
- **V10** (ai-readiness-audit `floom_internal_error`): Root cause: `prepareDockerNetworkPolicy` called `server.listen(0, gateway)` where `gateway` (e.g., `172.25.0.1`) is a Docker bridge gateway on the HOST, not inside the server container. Fix: detect container mode via `HOSTNAME` env var (12-char hex), connect server container to run network, listen on `0.0.0.0`, expose container's IP on the run network as proxy URL. Verified: `run_jry5mxd5cgg8` succeeded (status=success). Commit: `cfc2d085`. Files: `apps/server/src/services/network-policy.ts`.
- **MVP-R2-v2** (trim V17 landing to 7 sections): Added `variant?: 'full' | 'mvp'` prop to `LandingV17Page`. MVP variant wraps all 8 dropped sections with `{!isMvp && ...}`. `LandingMVPPage` is now a thin re-export wrapper (`<LandingV17Page variant="mvp" />`). Route `/` still uses `LandingMVPPage`; `/marketing` still shows full V17. typecheck + build both pass. Files: `apps/web/src/pages/LandingV17Page.tsx`, `apps/web/src/pages/LandingMVPPage.tsx`.
- **MVP-R3** (one subtitle on landing): "Vibe-coding speed. Production-grade safety." kicker hidden in MVP variant via `{!isMvp && ...}`. Same commit as MVP-R2-v2.

## launch-mvp branch — Items 1-9 (2026-04-27, sole-owner pass)

| # | Item | Status | Commit |
|---|---|---|---|
| 1 | Email-verify regression: `autoSignIn=true` restored (env-gated via `FLOOM_REQUIRE_EMAIL_VERIFY`) | FIXED | 42e0992e |
| 2 | Install snippets auto-update after minting token (state lifted to MvpHomePage) | FIXED | 42e0992e |
| 3 | Sign-out redirects to `/` (already correct — confirmed in TopBar, RunRail, MePage, StudioLayout) | VERIFIED | N/A |
| 4 | `floom apps list` + `floom run <slug>` CLI commands implemented | FIXED | 42e0992e |
| 5 | `--device` flag removed from CLI hints and docs | FIXED | 42e0992e |
| 6 | `floom auth login --help` crash fixed | FIXED | 42e0992e |
| 7 | Invalid `floom_agent_*` tokens now return 401 (not silent 200) | FIXED | 42e0992e |
| 8 | Email signup auto-login verified correct (Item 1 fix covers this) | VERIFIED | 42e0992e |
| 9 | `/p/:slug` v26 parity: Install (3 cards), Source (repo+spec+self-host), About (2-col + aside meta), footer cards (descriptions + CTAs) | FIXED | pending |

## How to use this log
- Update on every Federico screenshot/feedback.
- Each item gets a unique ID (M1, V1, X1) for cross-reference.
- Agent IDs are short hex from the Task tool.
- Mark FIXED only after redeploy + Federico ack.
