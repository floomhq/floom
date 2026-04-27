# Floom launch status — 2026-04-27

Single source of truth. Updated as work lands. Last update: 2026-04-27 00:30 UTC.

## TL;DR

11 v23 PRs merged this weekend. **Real coverage of the agreed-scope is partial**, not complete. Honest assessment of every priority route + every user-flow gap below.

Backend e2e green (41/0). Wireframes locked at v23. UI implementation: **incomplete** until the gaps below close.

---

## Route status (12 P0 routes from agreed scope)

| Route | Wireframe | Decision doc | Implementation PR | Phase 4 verified | State |
|---|---|---|---|---|---|
| `/` (landing) | v23 | landing-decision.md | #808 | partial | ⚠️ chrome unchanged on most sections (11/23 KEEP_CODE) |
| `/apps` | v23 | apps-decision.md | #810 | partial | ✅ showcase + browse banners shipped |
| `/p/:slug` (5 states) | v23 | p-slug-decision.md | #809 | partial | ⚠️ idle chrome unchanged (KEEP_CODE call); only running/output/rate-limited states ported |
| `/login` + `/signup` | v23 | auth-decision.md | #812 | partial | ✅ mode toggle + emerald CTA + AuthCard |
| `/me` | v23 | me-decision.md | #811 | partial | ✅ apps-led IA + banners |
| `/me/apps` | v23 | me-apps-decision.md | #818 | partial | ✅ banners + tag filter |
| `/me/runs` + `:id` | v23 | me-runs-decision.md | #819 | partial | ✅ list + detail + per-app renderers |
| `/me/secrets` + `/me/agent-keys` | v23 | keys-decision.md | #814 | partial | ✅ vocabulary lock + display-once modal |
| `/studio` home | v23 | studio-decision.md | #815 | partial | ✅ global TopBar + sparklines |
| `/studio/build` | v23 | studio-build-decision.md | #816 | partial | ✅ 10-state machine |
| `/studio/:slug/*` (**8 sub-tabs**) | v23 | **NONE** | **NONE** | ❌ NEVER TOUCHED | ❌ **0 commits since 2026-04-25** |
| `/embed/:slug` | v23 | (deferred) | (deferred) | n/a | DEFERRED to v1.1 |

**Routes 404 entirely** (server route missing):
- `/studio/:slug/source` → 404
- `/studio/:slug/feedback` → 404

**TopBar precursor** (#806) MERGED but has 3 known bugs (see User-flow gaps).

---

## User-flow gaps (flagged by Federico in the last 4 hours)

### 1. Copy-for-Claude popover (3 bugs)
**Source**: Federico screenshot 2026-04-26 15:18
- Bug A: count badge "(c) 6" rendering on centre-nav "My account" (should only be on dropdown items)
- Bug B: MCP server config snippet truncated (`"url": "https://flo` cut off)
- Bug C: No agent-token wiring; user can't actually use the snippet because token mint flow isn't connected
**Status**: PR in flight (`fix/copy-for-claude-fixes`, agent a94d981736a21ef10)

### 2. `/install-in-claude` only covers using apps, not publishing
**Source**: Federico 2026-04-27 00:18
The page tells users how to install Floom apps in Claude. Doesn't tell creators how to publish their own apps. Creator ICP first-impression gap.
**Status**: not started

### 3. `/p/:slug` idle chrome unchanged
**Source**: Federico 2026-04-27 ~00:00
Decision doc was too aggressive on KEEP_CODE — wireframe spec uses `ap-head`/`ap-tabs`/`ap-foot-card`/`ap-wrap` chrome but React code keeps `permalink-*` classes. Page looks identical to V18.
**Status**: not started — needs re-reconciliation pass

### 4. `/studio/:slug/*` is V18 chrome, not v23
**Source**: Federico 2026-04-27 00:30 ("v23 is so much better")
8 sub-tabs never reconciled, never implemented.
**Status**: not started

---

## Backend status

✅ **Launch-ready end-to-end**:
- 7 backend feature PRs merged (#794-801)
- E2E smoke 41/0 PASS against preview (`docs/BACKEND-LAUNCH-READINESS.md`)
- 130 tests in CI

🔴 **Open backend gaps** (all P1):
- `/embed/:slug` route missing (defer to v1.1 — wireframe explicitly marked)
- `FLOOM_STORE_HIDE_SLUGS` env var not set on prod (curates /apps from 50 → 13). Federico action.
- Sentry/Resend/Discord/B2 env vars: assumed set, need verification before prod promote
- `/me/api-keys` URL deprecated (PR #806 added redirect to `/me/agent-keys`); old URL still mentioned in `floom.json`, server `better-auth` config, `MeSettingsTokensPage.tsx` filename. Cleanup PR needed.

---

## Documentation

- `docs/BACKEND-LAUNCH-READINESS.md` — backend status (kept current)
- `docs/LAUNCH-STATUS.md` (this file) — overall status
- `/tmp/wireframe-react/*-decision.md` — Phase 1 reconciliation docs (10 of 12, **2 missing**: studio sub-tabs cluster, refined /p/:slug)
- `/tmp/wireframe-to-react/SKILL.md` — production workflow skill (Federico needs to copy to `~/.claude/skills/`)

---

## Plan to close the gaps (sequenced)

### Wave A — fix surfaced bugs (~4-6 hours wall-clock, parallel)
1. ✅ Copy-for-Claude bugs (PR in flight, lands tomorrow)
2. `/install-in-claude` rewrite to cover both use AND publish flows
3. `/p/:slug` idle chrome port: ap-head + ap-tabs + ap-foot-card + tag chips + rate-hint
4. agent-token quick-mint flow from anywhere (button in /me/agent-keys empty state)

### Wave B — close studio sub-tabs (~30-50 hours total, ~12-16h parallel)
5. Phase 1 reconciliation for 8 studio sub-tabs (1 doc, ~3 hours)
6. Phase 2 implementation per sub-tab (8 PRs, ~3-6 hours each)
7. Wire `/studio/:slug/source` and `/feedback` server routes (currently 404)

### Wave C — backend cleanup (codex)
8. `/embed/:slug` route OR explicit defer page (currently 404)
9. Server-side `LAUNCH_LISTED_SLUGS` filter (replaces env var ask)
10. URL cleanup: `/me/api-keys` references in `floom.json`, server config, file rename

### Wave D — pre-launch
11. Phase 4 visual parity verification (real screenshot diff per route)
12. Set env vars (Federico)
13. ICP scenario walkthroughs end-to-end (creator publishes / consumer runs / returning user)
14. Promote preview → prod

---

## Non-negotiables (per Federico)

- No emojis, no `#000`, no category tints on banners (single neutral palette)
- Vocabulary: BYOK keys + Agent tokens (NEVER "API keys")
- App roster: competitor-lens, ai-readiness-audit, pitch-coach (inactive: lead-scorer, competitor-analyzer, resume-screener)
- "Match Wireframes Unless Current Is Better" — but document the call per section so audits aren't surprised
- Codex does backend heavy lifting; Claude does UI

---

## Versioning

This doc is updated each time a PR lands or a gap closes. If the table goes stale, my fault — flag it.
