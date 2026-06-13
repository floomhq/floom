# Codex adversarial review of overnight workplan

Review date: 2026-05-27

Scope read:
- `WORKPLAN-2026-05-28-overnight.md`
- `ISSUES.md`
- `docs/audits/ui-roast-2026-05-28/design-roast.md`
- `docs/audits/ui-roast-2026-05-28/functional-roast.md`
- `docs/design/ascii-mockups-2026-05-27.md`
- `apps/api/runner_sandbox/agent_driver.py`
- `workers/research_brief/worker.yml`
- `workers/research_brief/SKILL.md`

## Executive verdict

The lane split is directionally sane. The plan is not. It is a broad "fix everything and audit everything" loop with P0 ordering mistakes, missing open issues, and an unrealistic score target. It spends early UI time on worker-card polish while current P0s still block creating workers, connecting tools, viewing worker detail reliably, avoiding single-click destructive data loss, and debugging failed runs.

Score: **4/10**.

The plan can produce visible progress overnight. It cannot honestly deliver "score >= 95/100 by 8am" with "zero P0s" from the current issue inventory. The issue tracker still records more than 50 open issues, including older security/backend items and new UI P0s. The workplan says the goal is score >= 95 and zero P0s by morning (`WORKPLAN-2026-05-28-overnight.md:21-23`), but the plan only schedules a subset of the open P0s and P1s (`WORKPLAN-2026-05-28-overnight.md:38-52`).

## 1. Lane split

The four-lane model is conceptually correct:

- Lane A owns runtime/backend failures (`WORKPLAN-2026-05-28-overnight.md:27-33`).
- Lane B owns UI implementation (`WORKPLAN-2026-05-28-overnight.md:35-52`).
- Lane C owns adversarial verification (`WORKPLAN-2026-05-28-overnight.md:53-67`).
- Lane D owns actual worker smoke (`WORKPLAN-2026-05-28-overnight.md:69-75`).

The split breaks down in execution:

- Lane A is overloaded with one real P0 runtime bug plus three opportunistic features: metrics polish, demo clone, and bundle serving (`WORKPLAN-2026-05-28-overnight.md:30-33`). Demo clone is not a P0 compared with worker execution, create-flow failure, upload validation, CORS, destructive settings action, and OAuth connect breakage.
- Lane B has 13 UI batches, many cross-cutting, with no cap or acceptance matrix (`WORKPLAN-2026-05-28-overnight.md:38-52`). That is too much for a night because several items touch the same surfaces: `/workers`, `/workers/<id>`, `/connections`, `/settings`, `/runs`.
- Lane C says "run after each batch lands" and includes launch readiness, UX review, layout-eyes, Kimi endpoint probing, Codex review, CSO, and a virgin user walk (`WORKPLAN-2026-05-28-overnight.md:55-65`). Running that whole audit stack after each UI batch will consume the night. The issue tracker itself says "Multi-agent audit waits until all P0 + the layout-eyes P1 items are addressed" (`ISSUES.md:864`). The workplan contradicts that.
- Lane D is necessary, but it is a smoke plan, not a contract test plan. Triggering workers and recording status/duration/output (`WORKPLAN-2026-05-28-overnight.md:71-75`) will catch some failures. It will not catch all schema, artifact, transcript, output-path, or citation-contract failures.

Verdict: keep the lanes, narrow the scope, and make P0 acceptance gates explicit.

## 2. Lane B ordering is wrong

The first UI batch in the plan is worker-card height/sparkline/trigger-label polish (`WORKPLAN-2026-05-28-overnight.md:38-40`). That is not first-order survival work.

The P0s that need to move ahead of card polish:

1. **`/workers/new` Generate is broken after example pill click.** The issue tracker records this as P0 and says clicking Generate after a pill does nothing (`ISSUES.md:905-911`). The functional roast also records a create-flow P0: example pills populate the textarea but leave Generate disabled, then POST fails with "Failed to fetch" after manual keystroke (`docs/audits/ui-roast-2026-05-28/functional-roast.md:18-30`). If this stays broken, new users cannot create workers.

2. **OAuth connect CTA is invisible in light mode.** The design roast calls `/connections/connect/googlecalendar` a first-impression trust gate and says the primary CTA renders as a featureless black bar (`docs/audits/ui-roast-2026-05-28/design-roast.md:10-21`, `docs/audits/ui-roast-2026-05-28/design-roast.md:207-210`). `ISSUES.md` records this as I-31 P0 (`ISSUES.md:960-963`). The workplan does not schedule it directly.

3. **Settings Clear runs is a single-click destructive action.** Functional roast calls it P0 (`docs/audits/ui-roast-2026-05-28/functional-roast.md:32-36`). `ISSUES.md` records I-44 P0 and the needed type-to-confirm pattern (`ISSUES.md:1014-1017`). The workplan does not include it.

4. **Worker detail false "Worker not found" race.** The design roast calls it the second-worst bug: initial navigation shows "Worker not found" and a red failed fetch toast before resolving (`docs/audits/ui-roast-2026-05-28/design-roast.md:14-21`, `docs/audits/ui-roast-2026-05-28/design-roast.md:82-84`). `ISSUES.md` records I-32 P0 (`ISSUES.md:964-967`). The workplan delays skeleton/loading states until batch 8 (`WORKPLAN-2026-05-28-overnight.md:45-46`), but this P0 is exactly a loading-state bug.

5. **Worker cards and worker detail navigation are still broken for the operator.** I-24 says the operator can only click Run on cards and still does not see tabs/side-nav on detail (`ISSUES.md:913-919`). The workplan's first batch fixes button position, not card-body navigation or detail-side-nav recognizability (`WORKPLAN-2026-05-28-overnight.md:38-40`).

6. **Theme controls are duplicated and desynced.** `ISSUES.md` records I-43 as P0 (`ISSUES.md:1010-1013`). The design roast also flags duplicate theme controls and stale labels (`docs/audits/ui-roast-2026-05-28/design-roast.md:181-187`, `docs/audits/ui-roast-2026-05-28/design-roast.md:277-281`). The workplan does not schedule it.

Correct UI ordering for overnight:

1. I-23 + I-1/I-6: create flow actually runs and surfaces real errors.
2. I-31: OAuth connect CTA visible and logo not blank.
3. I-44: Clear runs type-to-confirm.
4. I-32 + I-38: worker-detail loading race fixed via real skeleton, not false not-found.
5. I-24 + I-33: card-body navigation and mobile/detail nav readability.
6. I-43 + I-22: theme state and dark-mode sidebar regression.
7. I-47: failed-run transcript/debug access.
8. Then card-height polish I-53/I-55/I-54.

The P0 that will bite hardest if this is not reordered is **I-23 / create-flow Generate failure**. The product promise begins at "create a worker"; card polish cannot rescue a broken create action. The second hardest bite is **I-31 / invisible OAuth CTA**, because Workeros' differentiator is connected workers and the current consent page looks broken at the decisive moment.

## 3. Missing items from ISSUES.md

The plan omits multiple open items that are clearly broken:

- **I-20 CORS prod credential risk.** `ISSUES.md` records localhost origin plus credentials in prod as HIGH-4 (`ISSUES.md:870-875`). The workplan says first action is merge PR #70 for CORS/uploads (`WORKPLAN-2026-05-28-overnight.md:115-117`), but the plan body does not include a verification gate for prod CORS behavior.
- **I-21 upload validation.** Arbitrary files, no validation, no size limit, disk exhaustion risk (`ISSUES.md:876-885`). Not in Lane A, Lane B, or Lane D.
- **I-22 dark-mode sidebar regression.** the operator explicitly wants sidebar darker than content and still blue-accented (`ISSUES.md:897-904`). Not in the plan.
- **I-23 broken Generate after example pill.** P0 create-flow failure (`ISSUES.md:905-911`). Not in the plan.
- **I-24 card body click and worker detail tabs/side-nav.** P0 regression (`ISSUES.md:913-919`). Partially adjacent to I-55, but not actually scheduled.
- **I-25 slow worker detail navigation.** the operator called out long load time (`ISSUES.md:921-925`). Not in the plan.
- **I-30 `/runs` page did not get S12-UI updates.** Runs page still does not match locked spec (`ISSUES.md:949-953`). The workplan only does URL-sync for `/runs` and stat-card behavior; it does not align `/runs` with the locked spec.
- **I-31 invisible connect CTA.** P0 (`ISSUES.md:960-963`). Missing.
- **I-34 duplicate provider rows.** Two Google Calendar rows need human account labels (`ISSUES.md:972-975`). The workplan touches connections routing but not duplicate account distinction.
- **I-35 Notifications placeholders in production.** Two "Soon" toggles are recorded as production credibility leaks (`ISSUES.md:976-979`). Missing.
- **I-37 shared status/pill/card/button conventions.** Design system inconsistency is recorded (`ISSUES.md:984-987`) and echoed by the design roast's cross-page surface/pill/button findings (`docs/audits/ui-roast-2026-05-28/design-roast.md:256-273`). The workplan has label drift and hover sweeps, but not primitive consolidation.
- **I-43 duplicate theme controls.** P0 (`ISSUES.md:1010-1013`). Missing.
- **I-44 single-click Clear runs.** P0 (`ISSUES.md:1014-1017`). Missing.
- **I-47 failed runs lose Transcript tab / debug access.** This matters directly for I-52 debugging (`ISSUES.md:1029-1032`). Missing.
- **Older connection health/projection items.** `ISSUES.md` still records scopes unavailable, unknown account labels, Composio backend config route problems, test connection, and last-checked status as open (`ISSUES.md:129-205`). The overnight plan does not have a connection-health backend lane.
- **CSV/file upload and multi-file worker support.** File upload for CSV worker remains open (`ISSUES.md:78-91`), bundle upload remains open (`ISSUES.md:340-352`), and arbitrary worker files remain open (`ISSUES.md:551-564`). Worker smoke will expose some of this only if it includes real file inputs.
- **Webhook URL and multiple triggers.** Open items #31 and #33 record missing webhook URL and single-trigger schema (`ISSUES.md:568-584`, `ISSUES.md:612-638`). The plan only improves labels.

## 4. Iteration loops and 8-hour realism

The loop is not realistic:

- The plan commits, pushes, waits for Vercel, merges PRs, aliases to prod, runs Lane C agents, aggregates findings, and runs worker smoke after each batch (`WORKPLAN-2026-05-28-overnight.md:77-92`). With 13 UI batches plus backend fixes, this is not an 8-hour loop.
- Older issue sequencing already estimated 12-16 hours for the first 15 issues (`ISSUES.md:261-279`), 10-14 hours for Round 2 (`ISSUES.md:486-507`), 8-12 hours for Round 3 (`ISSUES.md:642-655`), and 4-6 hours for PR Q alone (`ISSUES.md:741-749`). The overnight plan tries to absorb a meaningful fraction of all of that plus fresh P0s.
- The plan has stop condition "5 consecutive batches with no new findings = ship at current score" (`WORKPLAN-2026-05-28-overnight.md:94-97`). That is dangerous because the planned batch size is arbitrary. It can stop with known open P0s if those P0s never enter a batch.
- "Every flow end-to-end tested by at least two different agents" (`WORKPLAN-2026-05-28-overnight.md:21-23`) is incompatible with adding new endpoints, worker runtime changes, UI rewrites, Vercel deploys, security pass, worker smoke, and all route audits in one night.

Realistic overnight target:

- Zero known P0s on the top five user flows: create worker, run worker, inspect failed run, connect tool, clear-runs safety.
- Worker contract tests green for all stock workers.
- UI screenshot proof for desktop/mobile on `/workers`, `/workers/<id>`, `/workers/new`, `/connections/connect/<app>`, `/settings?tab=danger`, `/runs/<failed>`.
- Score in the 75-85 range, not 95, unless scope gets aggressively cut and several issues are already fixed but unverified.

## 5. Highest-risk item and silent failure mode

Highest risk: **I-52 / AgentDriver output contract and transcript failure path.**

Why this is highest risk:

- It hits the actual worker execution promise.
- It already failed on production data: `run_59f3013d9468` has eight agent iterations and then `Output schema violation: Missing declared output 'brief'`.
- The current failure path returns before writing `transcript.jsonl`. In `AgentDriver`, schema validation happens at `apps/api/runner_sandbox/agent_driver.py:258-265`, but transcript writing happens only after that at `apps/api/runner_sandbox/agent_driver.py:267-276`. A schema failure therefore loses the transcript artifact.
- `_validate_output_schema` only reports after the loop is over (`apps/api/runner_utils.py:148-206`). It does not guide the model back into producing missing keys.
- The loop exits when the model returns no tool calls (`apps/api/runner_sandbox/agent_driver.py:221-222`). A model can write final prose in assistant content, omit `write_output`, and the runtime only notices after it is too late.

Silent failures to watch:

- A worker "passes" status with the right top-level output key but wrong artifact path. `research_brief` declares `path: out/brief.md` (`workers/research_brief/worker.yml:88-94`), but `AgentDriver._write_output` always writes `outputs/<name>.txt` (`apps/api/runner_sandbox/agent_driver.py:545-558`). That loses declared file path and media type semantics.
- Research quality silently fails because the worker's skill says `web_search` is available and mandatory for factual claims (`workers/research_brief/SKILL.md:13-27`), but `AgentDriver` removed `web_search` from Chat Completions tools (`apps/api/runner_sandbox/agent_driver.py:410-415`). Existing tests still assert that `web_search` exists (`tests/test_agent_driver.py:129-138`, `tests/test_pr_s11_tools_and_exec.py:190-217`). This is a contract mismatch, not cosmetic.
- Failed worker runs remain hard to debug because failed schema runs lack artifacts/transcript, and the UI also hides or changes failed-run transcript access according to I-47 (`ISSUES.md:1029-1032`).

## 6. Lane D worker smoke

Lane D is necessary but not sufficient.

The current smoke says to trigger every stock worker with realistic inputs, capture status/duration/output, fix failures, and re-trigger until all pass (`WORKPLAN-2026-05-28-overnight.md:71-75`). That will catch the current I-52 if `research_brief` fails again. It will not catch the root cause reliably because the failure is nondeterministic and LLM-behavior dependent.

Lane D needs these hard assertions:

- For every declared output in `worker.yml`, output JSON contains the exact required key.
- For every declared output path/media type, artifact storage matches the declared path or a documented normalized mapping.
- Every failed run persists a transcript artifact.
- `research_brief` output contains a markdown brief and a `## Sources` section because the skill requires it (`workers/research_brief/SKILL.md:41-44`).
- Agent tool schemas include the tools advertised by `SKILL.md`, or `SKILL.md` is changed to only advertise real tools.
- There is a deterministic fake-model test where the model first returns final prose with no tool call; the driver forces output completion or fails with transcript preserved.
- There is a deterministic fake-model test where the model calls `write_output` with a wrong key; the tool response guides correction and final output succeeds or fails with transcript preserved.

Without those assertions, Lane D can report "all stock workers pass" while leaving the same class of failure alive.

## 7. Research brief schema-violation hypothesis

Hypothesis from the workplan: AgentDriver does not include the declared `outputs:` schema in the system prompt, and does not provide a `finish_with_outputs` tool that enforces the keys.

Verdict: **mostly right, but incomplete.**

Verified facts:

- `research_brief` declares required output `brief` as a markdown file at `out/brief.md` (`workers/research_brief/worker.yml:88-94`).
- The skill explicitly tells the model to call `write_output` with `name: brief` and complete markdown content (`workers/research_brief/SKILL.md:39-44`).
- `AgentDriver` puts only output names into the user JSON as `outputs_required` (`apps/api/runner_sandbox/agent_driver.py:152-166`). It does not append a full output schema to the system prompt.
- `_load_system_prompt` appends only a generic instruction: "Call write_output once for each declared output before finishing" (`apps/api/runner_sandbox/agent_driver.py:296-310`).
- `write_output` accepts arbitrary `name: string`, not an enum of declared keys, although `_write_output` rejects undeclared names at runtime (`apps/api/runner_sandbox/agent_driver.py:350-358`, `apps/api/runner_sandbox/agent_driver.py:541-545`).
- There is no `finish_with_outputs` tool. The tool schema list only includes `list_dir`, `read_file`, `write_output`, `run_command`, `invoke_worker`, `log`, and Composio tools (`apps/api/runner_sandbox/agent_driver.py:312-440`).
- The loop exits when no tool calls are returned (`apps/api/runner_sandbox/agent_driver.py:221-222`), then validates outputs (`apps/api/runner_sandbox/agent_driver.py:258-265`). That is exactly how a model can spend iterations researching/thinking, return final prose, and still produce `Missing declared output 'brief'`.

The hypothesis is incomplete because the worker contract is also inconsistent on tools and artifacts:

- `research_brief/SKILL.md` says `web_search` is available and required for factual claims (`workers/research_brief/SKILL.md:13-27`), but `AgentDriver` removed `web_search` from the Chat Completions tool list (`apps/api/runner_sandbox/agent_driver.py:410-415`).
- `worker.yml` declares `brief` at `out/brief.md` (`workers/research_brief/worker.yml:88-94`), but `AgentDriver._write_output` writes `brief.txt` under the runtime output directory (`apps/api/runner_sandbox/agent_driver.py:545-558`).
- The web-search mismatch is a separate verified blocker for the `research_brief` contract. Fixing output keys alone leaves the worker instruction/tool surface inconsistent.

Proposed fix:

1. Add an explicit output-contract block to the AgentDriver system prompt. Include each declared output name, type, required flag, columns/json keys where relevant, and declared path/media metadata. `WorkerOutput` currently stores only name/label/type/columns/json keys (`apps/api/models.py:58-64`), while contract projection drops output path/media/kind (`apps/api/models.py:609-618`). Preserve those fields or pass the full contract through.

2. Add `finish_with_outputs` as the terminal tool. Its JSON schema must be generated from `config.outputs`: top-level object properties named exactly after required outputs, `required` set to all required output names, `additionalProperties: false`. For `research_brief`, the tool schema becomes effectively `{ "brief": "markdown string" }`. On call, write all outputs and stop the loop.

3. Keep `write_output` for streaming/multi-file behavior, but restrict its `name` property to an enum of declared output names. This turns "wrong key" into an immediate model-visible tool-schema problem instead of a late schema failure.

4. If the model returns a final assistant message with no tool calls and required outputs are missing, do not immediately break into schema validation. Append a corrective message saying the required outputs are missing and force one more tool call to `finish_with_outputs`. If it still fails, return schema violation with transcript preserved.

5. Persist transcript before schema validation. Move transcript writing before `_validate_output_schema`, or write it in both success and failure paths. The current order loses the only evidence needed for root cause (`apps/api/runner_sandbox/agent_driver.py:258-276`).

6. Reconcile `web_search`. Either migrate AgentDriver to an API surface that supports OpenAI web search, or provide a real `web_search` function tool. Until then, remove the promise from `SKILL.md`. The current state tells the worker to use a tool that the runtime intentionally removed.

7. Add deterministic tests:
   - fake model returns final text/no tool call -> driver recovers via `finish_with_outputs` or fails with transcript artifact.
   - fake model calls wrong output name -> driver returns corrective tool error and succeeds on retry.
   - `research_brief` tool list includes every tool advertised in `SKILL.md`.
   - failed schema run stores transcript artifact.
   - output artifact filename/path matches declared output metadata or documented normalization.

## 8. Top 3 changes that move the plan to 10/10

1. **Replace the UI batch order with a P0 gate.** The first UI gate is: create worker works, OAuth connect CTA visible, Clear runs protected, worker detail race gone, worker cards navigate, theme controls synced, failed-run debug visible. Only after that comes card polish, labels, URL-sync, and hover sweeps.

2. **Turn I-52 into a deterministic contract fix, not a smoke-only chase.** Implement output-contract prompt injection, `finish_with_outputs`, enum-restricted `write_output`, transcript persistence on failure, web_search/runtime reconciliation, and fake-model regression tests.

3. **Cut the overnight promise from "95/100 everything" to a verifiable release gate.** Define six flows, one acceptance matrix, and hard evidence per flow: screenshots, worker run IDs, transcripts/artifacts, test command output, and known-open residual issues. The current target invites a fake "green" report.

## Final score

**4/10.**

The plan has the right instincts: lanes, multi-agent review, actual worker smoke, and a named runtime root-cause lane. It loses six points because it orders polish before P0s, omits known open blockers, over-promises 95+ in a scope that already carries dozens of open issues, and treats worker smoke as enough to validate a broken agent contract.
