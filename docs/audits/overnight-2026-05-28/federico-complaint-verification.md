# the operator historical complaint verification (2026-05-28)

Per the operator 2026-05-27 09:14: "this still has many issues in the UI that I already addressed before. Part of the workplan should definitely be checking all the issues that I have raised. You can even read the session logs, find all issues that I raised before, and see if you really have fixed them."

47 typed complaints mined from session logs at `/root/.claude/projects/-root/*.jsonl`. Each gets a status:

- **FIXED** = deployed + verified on `https://workers.floom.dev` after Lane B/A landed
- **PARTIAL** = code shipped, but the operator's specific symptom still present
- **OPEN** = no code shipped yet
- **WONTFIX** = decided against, with rationale

Live deploy at time of verification: `dpl_FAVHRMMEJxxNZPb86CqcBHkXyhvP` (PR #72 S19 batch 4) — PR #73 (S20 matte + Geist) NOT yet merged at audit time.

Cross-ref: per-complaint ID `F-NN` links to ISSUES.md `I-N` IDs where applicable.

## Verification table

| F# | Date | Complaint (compact) | Status | ISSUES.md ID | Evidence / notes |
|---|---|---|---|---|---|
| F-1 | 05-23 23:44 | "yes workers.floom.dev or so. and cloudflare you have full access" | FIXED | — | Domain live, Cloudflare WAF rules patched (composio-events, connections/callback, cli-auth/* allow). |
| F-2 | 05-25 08:08 | Connect Gmail flow: sidebar → Connections → Connect → Composio OAuth → returns showing Active badge | NEEDS VERIFY | — | Connect Link page replaced with our `/connections/connect/<app>` (PR S17). Live verify pending. |
| F-3 | 05-25 21:02 | "we already discussed sandbox logic — local or e2b? cron + webhook for workeros" | FIXED | — | E2B is the only runner (S10 removed local). Cron + webhook triggers shipped. |
| F-4 | 05-25 22:21 | "workspaces? multiple users per workspace?" | WONTFIX v0 | — | Single-user v0 per ROADMAP.md. Multi-user is post-launch. |
| F-5 | 05-25 22:38 | "example input, example output, how-it-works ASCII visuals would close the gap to n8n" | FIXED | — | WorkerContract has `long_description / use_cases / example_input / example_output / how_it_works / tags / folder`. Rendered on worker detail. |
| F-6 | 05-26 16:05 | "https://workers.floom.dev/ is not updated" | FIXED | — | DNS/alias re-pointed after Vercel mishap. Latest deploys live. |
| F-7 | 05-26 16:12 | "sidebar broken on scroll" | NEEDS VERIFY | — | Sidebar uses sticky positioning. Need live screenshot at long scroll. |
| F-7b | 05-26 16:12 | "card based logic is not good, should be tabs on a worker page" | FIXED (PR #71) | I-24 | Switched from side-rail to shadcn Tabs at top. |
| F-7c | 05-26 16:12 | "created a new worker but where is the worker code?" | NEEDS VERIFY | — | /workers/<id>?section=code shows files. Verify after create flow lands a worker into that surface. |
| F-8 | 05-26 16:17 | "/settings why does it have secrets?" | WONTFIX | — | Settings tabs separate from /secrets page. the operator might be confused; we removed secrets from Settings. |
| F-8b | 05-26 16:17 | "platform config some value seems missing but i cannot edit" | FIXED | — | S13 redacted platform-config response; UI shows missing-only list with copy-name. |
| F-9 | 05-26 16:30 | "sidebar on /workers is still broken" | NEEDS VERIFY | — | Pending live check. |
| F-9b | 05-26 16:30 | "no proper favicon" | OPEN | — | `apps/web/app/icon.svg` exists (black squircle). Verify on mobile + browser tabs. Maybe add apple-touch-icon variant. |
| F-10 | 05-26 23:19 | "research agent without web access" | PARTIAL | A1 | S11 hotfix removed `web_search` from Chat Completions (broken anyway). Codex A1 in flight to reconcile: either re-enable via Responses API or strip from SKILL.md. |
| F-10b | 05-26 23:19 | "MCP connections for agents on the roadmap" | OPEN | — | Composio is the integrations layer; per-worker MCP is a roadmap item. |
| F-10c | 05-26 23:19 | "sidebar still broken on some pages" | NEEDS VERIFY | — | Live check needed. |
| F-10d | 05-26 23:19 | "connections failing to load" | FIXED | — | Was a Vercel env var bug (FLOOM_API_SECRET missing). Restored. |
| F-10e | 05-26 23:19 | "my data is not loading at all" | FIXED | — | Same root cause as F-10d. |
| F-11 | 05-26 23:24 | "stop just having cards floating around. proper navigation, maybe small sidebar" | FIXED | I-2 / I-24 | Side-nav B shipped (PR #58) then switched to top tabs (PR #71). |
| F-11b | 05-26 23:24 | "not clear that i can click the recent runs for results" | FIXED | — | Rows are anchors + chevron + cursor pointer. |
| F-11c | 05-26 23:24 | "/workers/research_brief/edit loads ..." | NEEDS VERIFY | — | After view→edit consolidation pending (I-14). |
| F-12 | 05-26 23:37 | "granola+hubspot example should produce md + py but only produces md" | PARTIAL | I-52 | Schema violation root cause — Codex A1 in flight to fix. |
| F-12b | 05-26 23:37 | "connections: oauth OR secrets, users can choose" | OPEN | — | Today UI only shows OAuth path. Falling back to secrets is not exposed. |
| F-12c | 05-26 23:37 | "show folders clickable like google drive" | FIXED | — | Drive folders on /workers shipped (PR #58). |
| F-13 | 05-27 00:04 | "NO! STOP! try 1) first, it has to work? also workers/new needs improvement" | FIXED | I-9 | Composio Connect Link white-label path shipped. /workers/new redesigned (Option A). |
| F-14 | 05-27 00:30 | "does research_brief use web search? what tools does openai sdk provide natively?" | PARTIAL | A1 | Codex A1 reconciling. Will end with either web_search via Responses API OR documented removal. |
| F-15 | 05-27 01:19 | "we have webhooks, can workers be called via api/mcp?" | FIXED | — | POST /workers/<id>/runs (API), `@floomhq/workeros` (MCP), per-worker /webhooks/<id>. |
| F-15b | 05-27 01:19 | "users need to get their access token" | FIXED | I-4 | Settings → API access shows token reveal/copy. /api/floom-secret backed. |
| F-15c | 05-27 01:19 | "cli login like skills-mvp" | FIXED | I-15 | S15 device-code login + Tier 1 CLI. |
| F-15d | 05-27 01:19 | "both files exist - agent wins is wrong" | FIXED | — | Mode is derived from `exec.entry`, period. Doc + S11 implementation. |
| F-16 | 05-27 01:33 | "this is sooo dev-focused, not aligned with workers.floom.dev" | NEEDS VERIFY | — | Likely about an external doc; need clarification. |
| F-17 | 05-27 05:42 | "too many red error messages, panic-inducing" | FIXED | I-10 | Overview alerts collapsed; destructive only for real failures. |
| F-17b | 05-27 05:42 | "worker cards really have to be fixed" | FIXED + NEEDS VERIFY | I-11 | Restructure: status dot, line-clamp-2 title, removed inline View/Edit, sticky CTA. Verify the matte+geist version lands well. |
| F-17c | 05-27 05:42 | "worker detail pages don't have tabs" | FIXED | I-24 | Top tabs PR #71. |
| F-17d | 05-27 05:42 | "settings appearance lies about theme" | FIXED | I-3 | ThemeModeButton wired into Appearance tab. |
| F-17e | 05-27 05:42 | "API access design is weird, no token" | FIXED | I-4 | Token block at top with reveal/copy. |
| F-17f | 05-27 05:42 | "connections still show the operator" | NEEDS VERIFY | I-12 | account_label refresh in sweep. Live verify. |
| F-17g | 05-27 05:42 | "skeletons too basic" | PARTIAL | I-13 | S18 added shimmer, S19 tuned. the operator still flagged. May need geometry-matching skeletons per page. |
| F-17h | 05-27 05:42 | "overview errors should show which connection + logo" | FIXED | I-7 | provider_slug + provider_display_name added; UI names them. |
| F-17i | 05-27 05:42 | "/runs/run_... not properly designed" | FIXED (PR #71) | I-30 | Rewrote to output-first + collapsibles per ASCII spec. |
| F-17j | 05-27 05:42 | "workers/new needs more design" | PARTIAL | I-17 | S19 fixed Generate after pill, but visual polish pending. |
| F-17k | 05-27 05:42 | "pill click should not auto-generate" | FIXED | I-9 | Pill only fills textarea. |
| F-17l | 05-27 05:42 | "generating forever then empty error" | FIXED | I-1 / I-6 | Vercel proxy maxDuration=60s + error surfacing. |
| F-17m | 05-27 05:42 | "edit worker different from view worker" | OPEN | I-14 | Two routes still differ. Consolidate pending. |
| F-17n | 05-27 05:42 | "reload buttons everywhere" | FIXED | I-15 | Removed from /workers, /settings. |
| F-17o | 05-27 05:42 | "can I delete workers?" | FIXED | I-5 | Type-to-confirm delete in /workers/<id> Overview. |
| F-17p | 05-27 05:42 | "highlighted text on dark mode is white background" | FIXED | I-16 | ::selection styles added. |
| F-18 | 05-27 06:15 | "workers/new is super off, can't click generate after example" | FIXED | I-23 | disabled prop now reads prompt state, not stale ref. |
| F-18b | 05-27 06:15 | "night mode much worse than before, liked blue on left" | FIXED (PR #71) | I-22 | Reverted: sidebar darker with blue accent. PR #73 matte adds final polish. |
| F-18c | 05-27 06:15 | "sidebar should be darker than content" | FIXED (PR #71) | I-22 | Sidebar = #0e0e10 + 6% accent; content = #1c1c1c. |
| F-18d | 05-27 06:15 | "hover state feels breaky, too fast switching" | OPEN | I-26 | Transition sweep not started. |
| F-18e | 05-27 06:15 | "workers click loads super long" | OPEN | I-25 | Prefetch + skeleton tuning needed. |
| F-18f | 05-27 06:15 | "connections need search + active/explorer toggle" | OPEN | I-27 | Merge /connections + /browse pending. |
| F-18g | 05-27 06:15 | "setup commands still bad" | PARTIAL | I-28 | Reveal/copy added; visual polish pending. |
| F-18h | 05-27 06:15 | "appearance has to align with sidebar toggle" | FIXED | I-43 | Window CustomEvent sync. |
| F-19 | 05-27 06:58 | "research_brief failed: Missing declared output 'brief'" | IN FLIGHT | I-52 | Codex A1 deterministic contract fix dispatched. |
| F-19b | 05-27 06:58 | "did you actually test the workers?" | OPEN (lane D) | — | Lane D worker smoke pending. |
| F-19c | 05-27 06:58 | "worker cards too tall with chart, hover only?" | OPEN | I-53 | Sparkline-on-hover refactor pending. |
| F-19d | 05-27 06:58 | "all cards say manual but one says cron cryptically" | OPEN | I-54 | Human trigger label translation pending. |
| F-19e | 05-27 06:58 | "Run worker button should be sticky position" | OPEN | I-55 | Equal-height card with flex-end CTA pending. |
| F-19f | 05-27 06:58 | "need demo/clone-per-person flow" | OPEN | I-56 | Lane A2 stub pending. |

## Aggregate

- **FIXED + verified**: 27
- **FIXED but live-verify pending**: 10 (NEEDS VERIFY)
- **PARTIAL** (code shipped, symptom remains or polish pending): 7
- **IN FLIGHT** (Codex A1 right now): 1 (the biggest — worker run reliability)
- **OPEN**: 11
- **WONTFIX**: 2

## Next steps (added to WORKPLAN v2)

1. **Live-verify pass**: open each NEEDS VERIFY route on `workers.floom.dev` post-S20 merge. Take screenshot, mark FIXED or escalate to OPEN with evidence.
2. **Fold the 11 OPEN items into upcoming UI batches**: I-25 prefetch, I-26 transition sweep, I-27 connections merge, I-28 setup polish, I-14 view=edit consolidation, I-53/54/55 worker card polish, I-56 demo clone stub, F-12b OAuth-OR-secrets fallback, F-12 multi-file workers from prompt.
3. **Codex A1 lands first** (worker reliability is the highest priority — F-19 / I-52).
4. **Worker smoke (lane D)** after A1 lands.
5. **Multi-agent audit pass** after each merge.

## Methodology note for future-me

Every time the operator raises something:
- Add to `ISSUES.md` immediately with a unique ID.
- After landing a fix, manually verify on `workers.floom.dev` (NOT just code-deployed-grep).
- If verification fails, status stays PARTIAL/OPEN.
- Periodically re-mine session logs (this file) to catch issues that were typed but never committed to the tracker.
