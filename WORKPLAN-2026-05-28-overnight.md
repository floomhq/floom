# Overnight Workplan — Federico asleep, 2026-05-28

Federico is asleep. He left these instructions:

> "You work on the UI, codex work on the backend, and maybe take a step right
> now to just do a workplan of how you will work. You can work ten hours,
> twenty hours, doesn't matter. I just want perfect UI, agent interface, and
> backend when I wake up, and everything should be tested by different agents
> in every way possible. We want to leverage different skills that we have."

This file IS that plan. I (Claude, Opus 4.7) am driving.

Federico's specific newest complaints (from message just before sleep):
- I-52 research_brief run `run_59f3013d9468` failed with `Output schema violation: Missing declared output 'brief'` after 8 agent iterations. Cards say "manual" everywhere or "cron" with a cryptic value. I never actually ran the workers to verify.
- I-53 Worker card sparkline makes cards too tall.
- I-54 Trigger labels broken (cryptic cron string, generic "manual").
- I-55 "Run worker" button position inconsistent across cards (cards have variable heights).
- I-56 Need a demo / clone-per-person sharing flow.
- "You don't seem to have the intelligence... maybe you're not invoking the right skills." — invoke skills hard. Multi-agent everything.

## Goal

Multi-agent score ≥ 95/100 by 8am tomorrow. Zero P0s. Every flow end-to-end tested by at least two different agents. Workers actually triggered and verified.

## Lanes

### Lane A — Backend (Codex)
Codex is back. Dispatch focused codex briefs one at a time (not in parallel — codex shares one cli-config).

1. **I-52 + worker contract audit** — root-cause `research_brief` schema violation. Likely: agent driver doesn't enforce or signal the declared output names to the LLM. Fix path: include the declared `outputs:` schema in the system prompt + a finishing tool that requires those keys. Then audit every other agent-mode worker for the same bug.
2. **/system/metrics polish** — add `runs_failed_24h`, per-worker last_error so the UI can flag failures inline.
3. **Demo-clone-per-person endpoint** (I-56) — `POST /demo/clones` that spawns a fresh isolated demo workspace (in-process for v0; document the design). Returns a unique URL + secret. Stub if too big.
4. **Run-detail snapshot serving** — verify S12-BE actually persists per-run bundle snapshots and `/runs/<id>/bundle/<file>` serves them.

### Lane B — UI (Claude, me)
Continue in tight batches, each commits + Vercel-builds before moving on. Pull main between batches to absorb backend fixes.

Order:
1. **I-53 + I-55**: rework worker card layout. Drop sparkline by default (show on hover). Pin "Run worker" button to the bottom of the card via flex (so cards equalize). Trigger label gets a real translation (cron → human, composio → "When new Gmail thread", etc).
2. **I-46 URL-sync sweep**: /runs filter, /workers search/folder (partially done), /connections/browse — all state to URL params.
3. **I-48 + I-49**: Worker > Connections > Configure routes properly. /connections/browse Connect routes through pre-confirm + flags already-connected.
4. **I-36 token mask polish**: `XXXX...XXXX` not 60 asterisks.
5. **I-27**: merge /connections + /connections/browse into ONE page with Connected / Explore toggle + search.
6. **I-39 label drift**: pick one canonical phrase per verb. Audit every CTA. Update.
7. **I-42 /cli-auth**: move to its own route group, strip the app chrome, show scopes/expiry/fingerprint.
8. **I-38 skeleton sweep**: every fetching page has a proper skeleton block matching its content shape.
9. **I-50 Overview stat cards**: drill-in OR remove hover styles (decide via test).
10. **I-51 tag filter indicator**: when a tag is clicked, render an active-tag chip above results with an `X`.
11. **I-28 setup commands redesign**: bigger token + cleaner snippet boxes + syntax highlight.
12. **I-26 hover/transitions sweep**: every hoverable surface gets `transition-colors duration-150`. No layout shift on hover.
13. **I-45 doubled <a>+<button> sweep**: switch to `<a className={buttonVariants(...)}>` from shadcn helpers across all `<Link><Button>` call sites.

### Lane C — Testing / verification (multi-agent)

Run after each batch lands. Cross-agent rule: never let the agent that built something audit its own work.

| Skill / agent | Trigger | Output |
|---|---|---|
| `/launch-readiness` | After each batch | 0-100 score + P0/P1 ranked |
| `/ux-review-everywhere` | After UI batch | 4-viewport × 3-state screenshots + bug report |
| `/layout-eyes` | After UI batch | Adversarial UI bugs |
| `kimi-agent` | Hard mode | Probe every endpoint + UI element, score, repeat |
| `/codex review` | Each PR before merge | Adversarial code review |
| `/cso` | Once tonight | OWASP + STRIDE pass |
| `claude-virgin` agent | After all batches | Real-user 22-step UI walk |

Each agent writes to `docs/audits/overnight-2026-05-28/<agent>/findings.md`. I aggregate findings into a delta tracker and fix loop.

### Lane D — Actually run workers (Federico's biggest gripe)

I never actually triggered workers to verify they work. Tonight:
1. Trigger research_brief, weekly_update, csv_enricher, dach_compliance, reverse_match_crm, cv_writeup, gmail_intake_brief — every stock worker — with realistic inputs.
2. Capture status, duration, output of each. Save to `docs/audits/overnight-2026-05-28/worker-smoke.md`.
3. Any failure → root-cause and fix (likely Codex lane).
4. Re-trigger until all pass.

## Iteration loop

Until score ≥ 95 AND zero new findings:

```
for batch in lanes_AB:
  - implement batch
  - commit + push
  - wait for Vercel green
  - merge PR
  - alias to prod
  - run lane C agents
  - aggregate findings → ISSUES.md
  - run lane D worker smoke
  - if (P0 found) inject into next batch
```

Stop conditions:
- Score ≥ 95 + 0 P0s + 0 P1s = ship
- 5 consecutive batches with no new findings = ship at current score
- Federico wakes up

## Promote / share path (I-56 demo access)

Brutally simple v0: a "Demo" button on `/settings` that creates a snapshot of the current worker bundles + a fresh database file, archives them, and hands the user a URL like `workers.floom.dev/d/<token>` that boots an isolated sub-instance. For v0 demo without infra:

- Document the design in `docs/demo-clone-design.md` and code a stub `POST /demo/clones` endpoint.
- Actual implementation (separate Vercel project + per-clone Cloudflare alias + isolated SQLite) is a 4-hour build — defer if time runs short.

## Reporting

When I finish (or when Federico wakes, whichever first), this file gets a `## Outcome` section appended with:
- Final score
- PRs landed (with commit SHAs)
- Worker smoke results
- Outstanding P1s/P2s
- Cost: tokens used per lane

## Now

Starting at 06:45 UTC 2026-05-28. First action: merge codex's PR #70 (R5 CORS + uploads). Then lane B batch 1 (worker card layout). Then lane D worker smoke #1. Then lane C audit #1. Then lane B batch 2.
