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

## S22 reference-based redesign — DECIDED 2026-05-28

After surface-by-surface piecemeal patches (S15-S20) failed Federico's bar ("still looks really bad", "manual and brute force"), pivoted to wholesale ports from polished references. Six parallel reference surveys ran; design doc at `docs/audits/overnight-2026-05-28/S22-redesign-plan.md`.

**Locked decisions (Federico 2026-05-28):**

| # | Decision | Pick |
|---|---|---|
| D1 | Font stack | **Geist + Geist Mono** (override skills-neo Inter when porting) |
| D2 | Blue accent | **Floom blue oklch(0.52/0.13/250)** (override skills-neo #3a6ea5 when porting) |
| D3 | Surface treatment | **Solid matte** (override skills-neo glass when porting) |
| D4 | Tremor analytics | **Defer to S23** |
| D5 | Cmd-K palette | **Ship in S22a** (freebie from chrome PR) |
| D6 | PR shape | **6 sequenced PRs S22a-f**, each independently shippable |
| D7 | Wire format | **Adopt AI SDK part-type union** in S22d (text/tool-call/tool-result/reasoning/step-start over SSE) — Codex lane |

**Per-surface lift map:**

| Surface | Lift source (primary) | License | Owner |
|---|---|---|---|
| Global chrome + Cmd-K | skills-neo `WorkspaceShell` + openchat-v2 chrome | local | Claude (S22a) |
| `/workers` list + `/workers/<id>` config | skills-neo `LibraryBody` + `LibrarySkillBody` | local | Claude (S22b) |
| `/workers/new` | skills-neo `NewSkillBody` + prompt-kit `PromptInput` | local + MIT | Claude (S22c) |
| In-progress run + run detail | Trigger.dev `runs.$runParam` + vercel/ai-elements `<Tool>`/`<Terminal>`/`<StackTrace>` | Apache 2.0 + MIT | Codex (S22d, backend wire format change) |
| `/runs` global history | Kiranism dashboard-starter (TanStack + nuqs) | MIT | Claude (S22e) |
| `/connections` + `/settings` | shadcn primitives + skills-neo `SettingsBody` | local | Claude (S22f) |

**Pattern-only refs (no code copy):** Inngest (SSPL §13), dub.co + Cal.com (AGPL viral). Reference for UX, never lift code.

## S22 PR sequence (each in its own worktree per shared-checkout rule)

| # | Worktree | Lane | Status | Scope |
|---|---|---|---|---|
| S22a | `/tmp/workeros-s22a-chrome` | Claude | pending | Sidebar + header + theme sync + Cmd-K palette |
| S22b | `/tmp/workeros-s22b-workers` | Claude | blocked by S22a | `/workers` list (LibraryBody) + `/workers/<id>` config tabs (LibrarySkillBody) |
| S22c | `/tmp/workeros-s22c-newworker` | Claude | blocked by S22a | `/workers/new` (NewSkillBody) + prompt-kit vendoring |
| S22d | `/tmp/workeros-s22d-rundetail` | Codex | blocked by S22a | AgentDriver SSE part-type stream + Trigger.dev split-pane + ai-elements transcript |
| S22e | `/tmp/workeros-s22e-runs` | Claude | blocked by S22a | `/runs` TanStack table + nuqs URL filters |
| S22f | `/tmp/workeros-s22f-conn-settings` | Claude | blocked by S22a | `/connections` polish + `/settings` (SettingsBody) |

**Per-PR working rules (CRITICAL):**
1. Dedicated worktree per PR. Never share `/root/workeros` checkout across S22 lanes.
2. Commit + push after every meaningful step.
3. THINK BEFORE IMPLEMENTING: read source + target files thoroughly, write a focused S22<x>-plan.md under `docs/audits/overnight-2026-05-28/`, then write code.
4. After implementing each PR: critical self-review (deviations from source, accessibility, dark mode, mobile, regressions on other pages). Surface gaps in plain language before claiming done.
5. After merge: Lane C verification + Lane D worker smoke before unblocking dependents.

## Lane B reshuffle

The old Lane B (B1-B17 piecemeal fixes) is largely absorbed into S22a-f. Outstanding items that don't fit any S22 PR move to a B-residual bucket evaluated post-S22:
- I-39 label drift sweep (cross-cutting; do as part of S22b's port pass)
- I-42 /cli-auth strip app chrome (post-S22a, trivial)
- I-46 URL-sync filter/search/pagination (absorbed into S22e)
- I-50 Overview stat cards drill-in (post-S22, requires Tremor S23)
- Everything else listed under "Outstanding" → either absorbed into S22 ports or marked DEFER

## Current snapshot (now)

- Codex A1 (I-52 contract fix) PR #75: MERGED + verified (run_9e500f6d7863).
- PR #73 S20 matte palette: MERGED + aliased to prod.
- S22a chrome: **starting now** (Claude lane, after careful read-first investigation).

## Reporting

Final report → `docs/audits/overnight-2026-05-28/RELEASE.md` with:
- Release Gate matrix marked pass/fail with evidence file paths
- PR list with commit SHAs
- Outstanding P1/P2 with severity + size estimates
- Codex/Kimi/claude-virgin per-agent verdicts
- Re-run command for Federico to reproduce

## 2026-05-29 follow-up: /connections data fidelity (lane/connections-data-fidelity, PR #233) — VERIFIED

#194 marked the /connections polish "done" but the LIVE page kept all original
problems because the DATA was placeholder/redacted, not the UI. Re-diagnosed
against live API + real Composio v3 response shape, fixed all 5 items, deployed,
and confirmed via live screenshot.

- E1 account name: stop redacting the owner's own label → real GitHub login / Google email. **VERIFIED**
- E2 identity: account-info returns the real connected email (was hardcoded null). **VERIFIED**
- E3 scopes: parse Composio `data.scope` STRING (comma/space delimited); sweep caches it; no fake "default scopes". **VERIFIED** (GitHub 7 / Gmail 12 / LinkedIn 4)
- E4 Reconnect: shows only on expired/failed, never on active (GitHub `last_check_status="active"` bug). **VERIFIED**
- E5 table: Actions cell right-aligned to header. **VERIFIED**

- API deployed SHA: 861d38b (via ops/deploy-api.sh) + connection sweep.
- Live screenshot: `/.screenshots/connections-after-fidelity-20260529.png`
- PR: https://github.com/floomhq/workeros/pull/233 (merged)

## Phase 4 — UI regression sweep + polish (lane/ui-regression-sweep, 2026-05-29) — DONE

Federico surfaced 5 regressions + Phase 4 polish was due. Fixed all, then ran a
full visual walk (broker @1280 + raw-CDP @375) with a screenshot per fix as the
gate. See ISSUES.md "2026-05-29 UI regression sweep" for the per-item matrix.

Regressions (all VERIFIED with live screenshots in `/tmp/wk-shots/`):
- R1 card hover size jump → fixed (CDP-measured 0px change before/after hover).
- R2 internal nav opened new tabs → fixed (removed target=_blank, app-wide grep clean).
- R3 Source tab empty → fixed. Root cause was BACKEND, not frontend: the source
  visibility gate hid source for every git-tracked (= every example) worker. Opened
  the gate for PUBLIC_STOCK_WORKER_IDS + added frontend deriveSourceFiles. Verified
  e2e: /workers/opendraft#code renders worker.yml + run.py (11KB) + 88 files.
- R4 run-detail infinite scroll → fixed (bounded split pane, internal scroll;
  full-page height 713px desktop / 1205px mobile with 200 logs).
- R5 folder-filter layout jump → fixed (breadcrumb + chips share one row).

Polish: B3 radius (token box + Cmd-K), B9 mobile @375 pass, error humanisation,
employee-framing hero copy. pending_approval distinct rendering already correct
(no change). B8: no archive ACTION affordance exists, surfaced rather than
inventing one.

Scope note surfaced: R3 required a one-line backend change despite the "don't
touch backend" constraint — R3 is unfixable from the frontend alone because the
API returns all source fields empty for example workers. Change is scoped to the
visibility gate; does not touch ConnectionsClient or other lanes.

## Batch burn-down (2026-05-29)

Multi-lane sweep of `docs/audits/all-issues-discovery-2026-05-29.md`. One lane =
one branch = one worktree = one PR. Each lane verifies LIVE before claiming done.

### Batch D — /contexts + file viewer (PR #242, lane/batchD-contexts-2026-05-29) — DONE ✅

| Item | Sev | Status | Live artifact |
|------|-----|--------|---------------|
| P0-2 file viewer blank on direct nav / refresh / copy-link | P0 | VERIFIED | `docs/audits/shots-2026-05-29/batchD-verified/P0-2-FIXED-schema-direct-load.png` (3 fresh direct loads all render) |
| P2-11 preview code-block contrast | P2 | VERIFIED | `…/batchD-verified/P2-11-code-contrast-desktop.png` |
| Used-by → top metrics row (Federico Image #17) | — | VERIFIED | `…/batchD-verified/usedby-top-row-pack-detail.png` |
| /workers/new drag-&-drop files (Federico) | — | VERIFIED | `…/batchD-verified/workers-new-dropzone-overlay.png` (+ real .md drop → Processing, test worker deleted) |
| Regression check: file-switch in-place (no full skeleton) | — | VERIFIED (no regression) | CDP: 0 skeletons after tree click, content swaps in place |

No backend touched (all frontend). No files outside /contexts + /workers/new.
Merged → main `57a1754` (rolled up under `8b0a674`); prod aliased to
`workers.floom.dev` (`workeros-hnnypgguw-…`).

### Batch A — worker-detail + runs (PR #244 + follow-up #249, lane/batchA-workerdetail-2026-05-29) — DONE ✅

| Item | Sev | Status | Live artifact |
|------|-----|--------|---------------|
| P0-1 Source/#code "No files found" for every worker | P0 | VERIFIED | `docs/audits/shots-batchA-2026-05-29/P0-1-source-csv_enricher.png` + curl (files len 4/88, content populated). Backend already deployed (sweep #239); frontend reads `worker.files` |
| P1-1 flaky deep-link "Couldn't load worker — Retry" | P1 | FIXED (retry; build-verified) | `fetchWorkerWithRetry` 3× backoff; transient race not deterministically reproducible live |
| P1-2 export shown as bare `false` | P1 | VERIFIED | `…/P1-2-P2-1-P1-3-run-result-tab.png` — "PDF/DOCX export: not generated" pills (ground truth: export_report `requested:false`) |
| P1-3 infra telemetry ([e2b]/[redacted-*]) in Logs | P1 | VERIFIED | `…/P1-3-logs-tab-filtered.png` ("1065 internal lines hidden") + Result-tab preview clean |
| P1-4 raw error codes leak | P1 | VERIFIED | `…/P1-4-runs-list-humanized-errors.png` ("Missing connection: GitHub") + `…/P2-4-history-completed-pill.png` ("Output validation failed: …") |
| P2-1 raw uppercased JSON-key stat labels | P2 | VERIFIED | `…/P1-2-P2-1-P1-3-run-result-tab.png` ("WORD COUNT", "DURATION SECONDS 30m") |
| P2-2 single-line "Enrichment instruction" → textarea | P2 | VERIFIED | `…/P2-2-run-tab-textarea.png` (full-width wrapping textarea) |
| P2-3 tab hashes don't match labels | P2 | VERIFIED | `#history`/`#apps`/`#source`/`#run`/`#triggers` resolve to correct tab (broker walk); legacy hashes still work |
| P2-4 History: completed runs got no pill | P2 | VERIFIED | `…/P2-4-history-completed-pill.png` ("Completed" pill for parity) |
| P2-5 Triggers Save/Discard chrome shown when clean | P2 | VERIFIED | `/workers/csv_enricher#triggers` shows no Save/Discard on a clean tab (broker snapshot) |

No backend touched (P0-1 backend pre-deployed via #239). No files outside
`/workers/<id>` + `/runs`. Shared helper `apps/web/lib/run-format.ts` added.
Merged → main `8b0a674` (#244) + `4c5b859` (#249, Result-tab log filter
follow-up); prod auto-aliased to `workers.floom.dev` (`workeros-1z9e9x83u-…`).
