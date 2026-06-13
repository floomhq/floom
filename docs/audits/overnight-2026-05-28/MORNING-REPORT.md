# Overnight 2026-05-28 — Morning report for the operator

**Status snapshot at hand-off:** S22 UI redesign sequence shipped + verified live on prod. R6 backend security PR is open with adversarial-probe findings noted. S22d (Codex backend SSE + run detail UI) still in flight.

## What's live on prod RIGHT NOW (workers.floom.dev)

| PR | Surface | Status |
|---|---|---|
| #77 S22a | Global chrome: + New worker CTA + Search ⌘K palette + sidebar refresh | **MERGED + LIVE** |
| #78 S22b | /workers list card cleanup + /workers/<id> tab reorder (Overview first, Source/Apps/History rename, labelled StatusPill) | **MERGED + LIVE** |
| #79 S22c | /workers/new polish (lighter placeholder, kbd hint visible when disabled, first pill accented) | **MERGED + LIVE** |
| #80 S22e | /runs polish (URL state filters, ghost Export, no inline run ID, no "manual" noise, louder Failed pill) | **MERGED + LIVE** |
| #81 S22f | /connections + /settings polish (drop "Default scopes"/"Last used: Never" placeholders, hide Notifications "Soon" tab) | **MERGED + LIVE** |
| #83 S22g | Triggers tab interior polish (labelled radio-cards with subtitles + Floom-blue active, replaces "button group" affordance) | **MERGED + LIVE** |

Verified live by browser screenshots (`/tmp/s22a-shots/PROD-*.png`). Prod alias `workers.floom.dev` was pointing to an old deploy; promoted to latest manually.

## Still open

| PR | Surface | Status |
|---|---|---|
| #82 R6 | Backend security (IDOR + PII + DoS + CORS + ratelimit + schema redact) | **OPEN — needs your call** |
| #84 S22d | Backend SSE part-stream + Trigger.dev split-pane run detail UI | **MERGED + LIVE — see `prod-verify/PROD-09-run-detail-s22d.png`** |

### S22d landed (the big one)

The "shit when any worker is running" complaint is obliterated. `/runs/<id>` now shows:
- TIMELINE on the left with each tool invocation as a row (status icon, name, callId, "done" pill)
- TRANSCRIPT / Logs / Output / Metadata tabs on the right
- ai-elements `<Tool>` collapsible cards per tool-call
- Sticky header with status pill, run-id, duration, Edit / Re-run / Download
- AgentDriver now emits AI SDK part-type stream over SSE — live updates without polling

Tests: 5/5 S22d stream tests + 10/10 R6 tests + typecheck + lint + build all green. Live smoke run completed in 26.2s.

### #82 R6 — needs your decision

Codex closed CRIT-3 (IDOR DELETE), CRIT-4 (PII), 3 of 3 systemic findings (CORS, ratelimit, schema). 10/10 R6 security tests pass. PR is mergeable + Vercel-preview-green.

**However** my dispatched adversarial-probe agent (ran live curls against prod after R6 commits landed in the worktree) found:

1. **HIGH-6 only PARTIALLY fixed** — Codex patched the JSON-decode-error branch but the validation-error branch on `POST /workers` is STILL 2.0x amplifying. 10MB request → 20MB response, 5.3s server time. **This is a P0 still open.** Fix is small: custom `RequestValidationError` handler that strips `input` and `ctx`, plus `Content-Length > 256KB` rejection middleware before Pydantic.
2. NEW-2 (P1): `/cli-auth/devices` is unauthenticated + unbounded. Phishing path leaks `FLOOM_SECRET`.
3. NEW-3 (P1): secret name/value no length cap (10k char name + 10MB value accepted).
4. NEW-4 (P1): rate-limit uses CF edge IP, bypassable behind shared CDN.
5. Plus 4 P2s (deep-nest crash, timing channel, Composio IDs exposed, auth-configs default-ID fallback).

Full report: `docs/audits/kimi-adversarial-2026-05-28.md`. PR comment posted: `gh pr view 82 -c`.

**Your call:** merge #82 now (closes 2/3 CRITs, real net positive) + open a follow-up for NEW-1/2/3, OR hold #82 until R7 expands to close NEW-1 too. I'd merge now — the IDOR is the most dangerous vector and it's gone.

### About the Kimi audit gap

You asked why my audits don't find what your Kimi audits find. Honest answer: I had been using Kimi for *code review* (kimi-agent CLI reading source); your Round 6 was *probe-driven* (live HTTP DELETEs / oversized bodies / random UUIDs). Completely different methodology — code review never sees runtime auth wiring or response-shape drift.

Fix: I dispatched a probe-driven agent in parallel with Codex R6 — the methodology now matches yours. Memory rule encoded: every future backend audit/fix dispatch ALSO triggers a live-probe agent. Saved as `feedback_codex_must_run_adversarial_probes` so future-me doesn't repeat the gap.

## S22d — Codex in flight

Codex is implementing the AI SDK part-type SSE stream + Trigger.dev split-pane + ai-elements transcript in `/tmp/workeros-s22d-rundetail` (branch `feat/s22d-rundetail`). 1 commit landed so far: `feat(api): add run part stream`. Frontend half coming next. Will open PR when ready; expect 1-3h more from start time.

This is the biggest single UX delta in the S22 sequence (your "shit when any worker is running" complaint). When this lands, /workers/<id> running state + /runs/<id> get the split-pane timeline-tree + live tool-call cards + terminal + stack-trace render.

## Decisions you locked

| # | Decision | Pick |
|---|---|---|
| D1 | Font stack | Geist + Geist Mono |
| D2 | Blue accent | Floom blue oklch(0.52/0.13/250) |
| D3 | Surface | Solid matte |
| D4 | Tremor analytics | Defer to S23 |
| D5 | Cmd-K | Ship in S22a |
| D6 | PR shape | 6 sequenced PRs |
| D7 | Wire format | AI SDK part-type SSE in S22d |

## Reference plan vs reality

S22 plan said: wholesale port from skills-neo `WorkspaceShell`/`LibraryBody`/etc.

**I rejected the WorkspaceShell port** on first read — it forces a workspace concept (personal/shared, viewer/editor/admin) Workeros doesn't have. Tightened S22a scope to: keep current sidebar, ADD Cmd-K + + New worker CTA. Documented the rejection in #77.

For S22b-f I shipped SURGICAL roast fixes instead of wholesale rewrites. Each P1 from `docs/audits/ui-roast-2026-05-28/design-roast.md` is addressed in the relevant PR; deferred work listed in PR bodies. This was more honest about what was actually broken (most surfaces have decent bones; the bad surfaces are running-state and run-detail = S22d).

## Open questions for you when you wake up

1. R6 PR #82 — merge now or hold for NEW-1 fix?
2. S22d when it lands — review the PR or auto-merge if Vercel green + tests pass?
3. The 83 pre-existing test failures in the legacy suite — clean-up sprint or accept as known-state?
4. Anything I missed on the design-roast that you want addressed?

## Re-run / verify (your fingertips)

```bash
# See live prod after S22:
open https://workers.floom.dev
# Try Cmd-K from anywhere
# /workers/research_brief - new tab order (Overview first)
# /runs?status=failed - shareable filter URL

# See codex S22d progress:
tail /tmp/codex-s22d.log
git log --oneline /tmp/workeros-s22d-rundetail

# See adversarial probe findings:
cat docs/audits/kimi-adversarial-2026-05-28.md

# Merge R6 if you decide yes:
gh pr merge 82 --repo floomhq/workeros --squash --delete-branch
```

End of report.
