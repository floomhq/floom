# Overnight Workplan v2 — revised after Codex 4/10 review

Codex graded the v1 plan **4/10** at `docs/audits/overnight-2026-05-28/codex-workplan-review.md`. Three substantive criticisms accepted; this v2 addresses all three.

## What changed from v1
1. **UI order reflows by P0 gate, not "card polish first"** — though batches 1-4 already shipped most of those P0s; this doc now reflects reality + queues what's left.
2. **I-52 promoted to a deterministic contract fix** (per Codex root-cause analysis). Smoke alone won't validate the agent contract.
3. **The "95/100 by 8am" promise is replaced by a Release Gate** with 6 named flows + an acceptance matrix + hard evidence per flow.

## Release Gate (replaces the "95/100" target)

Six flows. Each must pass with hard evidence in `docs/audits/overnight-2026-05-28/release-evidence/`.

| # | Flow | Acceptance | Evidence |
|---|---|---|---|
| 1 | **Create worker from prompt** | Click example pill → fills textarea (no auto-submit). Click Generate → completes within 60s OR shows the real error. | screenshot of created worker `/workers/<new_id>/edit` + run_id |
| 2 | **Run a worker, see output** | Trigger every stock worker (12 of them). All return `status=completed`. Output panel shows real content. | `worker-smoke.md` with run_id, status, duration per worker; output preview screenshot for one |
| 3 | **Debug a failed run** | Force a failure (bad input). Failed run detail shows the inline Error panel + the raw error + transcript artifact (transcript MUST persist on failure). | run_id of forced-fail + screenshot of error panel + transcript file path |
| 4 | **Connect a new tool** | `/connections/connect/<app>` Connect button visible in both themes. Click → opens OAuth tab. Returns to `/connections` showing the new connection with the correct email. | screenshot light + dark + post-connect `/connections` row with email |
| 5 | **Clear runs safety** | `/settings → Danger zone → Clear runs` requires typing `DELETE ALL RUNS`. No single-click destructive path. | screenshot of locked button + screenshot of typed-confirm + 200 from `/runs/clear` |
| 6 | **Theme controls sync** | Sidebar Light/Dark/System toggle and `Settings → Appearance` toggle. Click either → both update + page re-themes. No drift. | short video / 3-step screenshot proof of click-here-update-both |

**SHIP when all 6 flows pass + zero open P0s + agent contract tests green.**

## Lanes

### Lane A — Backend (Codex)
Codex is back. Briefs go one at a time (shared cli-config).

**A1 — I-52 deterministic agent contract fix (THE P0)** — per Codex's review section 7:
- Inject the full declared `outputs:` schema into AgentDriver system prompt (not just names)
- Add `finish_with_outputs` terminal tool with JSON schema generated from `config.outputs`
- Restrict `write_output` `name` property to an enum of declared outputs (was free string)
- Move transcript persistence BEFORE schema validation (currently lost on failure — `agent_driver.py:258-276`)
- Reconcile `web_search`: it's in SKILL.md but stripped from runtime. Either re-enable via Responses API or strip from SKILL.md.
- Fix path mismatch: `worker.yml` declares `out/brief.md`; driver writes `outputs/brief.txt`. Either honour declared paths OR document the normalization and update workers.
- Deterministic fake-model tests: (a) model returns prose-only with no tool call → driver retries via `finish_with_outputs` or fails-with-transcript; (b) model calls wrong output name → driver returns corrective tool error.

**A2 — Backend follow-ups, only if A1 lands clean and tested**:
- `/system/metrics`: add `runs_failed_24h` + per-worker last_error
- `/runs/<id>` API: include `bundle_snapshot_path` so the UI can show code-at-run-time

### Lane B — UI (Claude)
Status (truth after batches 1-4 deployed):
- ✅ Shipped P0s: I-23 (Generate), I-31 (Connect CTA), I-44 (Clear runs), I-32 (race), I-43 (theme sync), I-22 (dark mode), I-11/I-24 (cards + tabs)
- 🔄 In flight: S20 matte palette (PR #73)
- ❌ Outstanding from ISSUES.md, in order of release-gate priority:

```
B1: openchat-v2 polish port (deeper than colours — fonts, scale, spacing, skeleton, Card padding, tighter Button sizes). [opensource the references]
B2: I-47 failed-run transcript surface (paired with A1 — UI needs to show what A1 persists)
B3: I-30 /runs page align with locked ASCII spec
B4: I-34 connection rows show email/account_label prominently
B5: I-35 hide /settings Notifications "Soon" toggles in production
B6: I-36 token mask 4-and-4 pattern
B7: I-37 status/pill/card/button conventions consolidated
B8: I-27 /connections + /connections/browse merged with Connected/Explore + search
B9: I-38 skeleton sweep (matches content shape, no flip-flash)
B10: I-39 label drift sweep
B11: I-42 /cli-auth strip app chrome
B12: I-46 URL-sync filter/search/pagination
B13: I-48 Configure routes correctly
B14: I-49 /connections/browse Connect via pre-confirm + flag already-connected
B15: I-50 Overview stat cards drill-in or remove hover styles
B16: I-51 tag-click → active-tag chip indicator
B17: I-53/I-54/I-55 worker card polish (sparkline hover-only, sticky Run, human trigger labels)
```

### Lane C — Verification (multi-agent)
Run AFTER each PR merges, per the loops in `docs/audits/overnight-2026-05-28/assessment-loops.md`. Gemini free tier OK (Federico re-authorised).

### Lane D — Hard worker smoke (replaces "trigger and check status")
Per Codex section 6:
- For each declared output in `worker.yml`, response MUST contain exact required key
- For each declared output path/media type, artifact path matches declared OR documented normalization
- Failed runs MUST persist a transcript artifact (this is also A1 acceptance)
- `research_brief` output MUST contain `## Sources` (since SKILL.md asserts citations)
- Tool list in agent driver MUST be a superset of tools advertised in SKILL.md
- Two fake-model regression tests added (see A1)

## Iteration loop (concrete)

```
for batch in [A1, B1, B2, A2, B3, ...]:
  - implement
  - commit + push, wait Vercel
  - merge
  - alias to prod
  - run Lane C loops (ui or backend depending on what shipped)
  - run Lane D for backend changes
  - aggregate findings → ISSUES.md
  - if any release-gate flow fails: STOP the loop, fix the flow, then resume
end when: all 6 release-gate flows green AND zero open P0s
```

## Stop conditions (replaces "score >= 95")

1. All 6 Release Gate flows pass with evidence files.
2. Zero open P0s in `ISSUES.md`.
3. Lane D agent contract tests green (the 2 fake-model regression tests + worker smoke).
4. Codex final-gate review of the merged release branch (composed of all overnight PRs) returns no P0s.

If any of those fail, the morning report names which flow failed and the residual P0s — no "fake green".

## Current snapshot (07:25 UTC)

- Codex workplan review: **DONE** (4/10). All criticisms folded into this v2.
- PR #73 S20 matte palette: open, awaits Vercel. Once green, merge + alias.
- Codex A1 (I-52 contract fix): dispatching now.
- B1 openchat-v2 polish: starting after A1 dispatch + matte merge.

## Reporting

Final report → `docs/audits/overnight-2026-05-28/RELEASE.md` with:
- Release Gate matrix marked pass/fail with evidence file paths
- PR list with commit SHAs
- Outstanding P1/P2 with severity + size estimates
- Codex/Kimi/claude-virgin per-agent verdicts
- Re-run command for Federico to reproduce
