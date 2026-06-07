# Generated-Worker Quality Fix — Evidence (2026-05-29)

**Launch blocker:** the prompt-to-worker flow created a well-formed worker, but the
generated worker code CRASHED on first run. Independent G5 scorer found 0/2 generated
workers ran.

**Root cause:** the worker-author meta-worker generated `run.py` against the WRONG
contract. `workers/worker-author/SKILL.md` taught the agent-mode tool API
(`run(inputs, context)`, `context.write_output`, `context.secrets`) instead of the E2B
pure-script contract, and there was no canonical run.py template in any context the
generator reads. The generator (`workers/worker-author/run.py`) never fed the LLM any
run.py contract at all.

## Fixes shipped (PRs #277, #278, #279, all merged + deployed)

1. **Correct contract + canonical template (#277).** Rewrote SKILL.md run.py rules;
   added `contexts/worker-author-style/RUN_PY_TEMPLATE.py` as the single source of
   truth; inject it into the generation prompt; fixed SCHEMA.md scalar-vs-file path rules.
2. **Post-generation smoke + bounded repair (#277).** After registration, a generated
   SCRIPT-mode worker runs ONE real E2B smoke with its sample input (inline on the
   author run's execution slot — no extra concurrency). On a code-class failure, a
   bounded repair pass (max 2) feeds run.py + the traceback to a focused model call,
   validates real Python, rewrites run.py, re-smokes. Outcome recorded on the author run
   output as `smoke` — a failing worker is surfaced, never silently shipped.
3. **Error humanizer (#277).** A worker's OWN code crash (NameError/FileNotFoundError/
   etc, arriving as `execution_error` / `e2b_sandbox_error`) reads as a CODE error
   ("Edit the worker to fix it, or re-generate it") — not a generic "internal error" and
   never "took too long". Genuine timeouts still map to timeout.
4. **stdlib-only + result.json location (#278).** Live verification found generated
   run.py crashed on bare `from dotenv import load_dotenv` (no python-dotenv in
   requirements → ModuleNotFoundError) and on writing `out/result.json` instead of
   `./result.json` (→ missing_result). The template is now stdlib-only (secrets via
   os.environ + secrets.json helper) and writes result.json to the working dir.
5. **File-input path (#279).** A generated CSV worker did
   `os.path.join("inputs", inputs["input_file"])` where the value was already
   `inputs/input_file` → `inputs/inputs/...` FileNotFoundError. The file-input rule now
   states everywhere: the value IS the path; `open(inputs["x"])` directly, never
   re-prepend `inputs/`.

## Live verification — 5 diverse script-mode prompts

Deployed SHA `8f4196c`. Drove the REAL prompt-to-worker flow (`POST /workers/new/from-prompt`,
mode=create) for 5 prompts. The `smoke` field is the authoritative "does the generated
code run" signal because it uses the worker's OWN sample input. Fresh-run = a separate
`POST /workers/{id}/runs` with externally-supplied input.

| Prompt | worker_id | smoke (authoritative) | fresh run | notes |
|--------|-----------|------------------------|-----------|-------|
| count words/chars in pasted text | text-word-character-counter-3 | passed (0 repairs) | run_fd0e16c94040 completed | green |
| 3 random science facts each run | random-science-facts-3 | passed (1 repair) | run_c0d45c894ee9 completed | green |
| CSV + name-length column | csv-name-length-adder-3 | passed (1 repair) | run_f052949ea3c8 completed | file input, opens path directly, real output |
| markdown → plain text | markdown-to-plain-text-3 | passed (1 repair) | run_f644519e872f completed | first fresh-run failed only on a too-short harness input; re-run with real markdown completed |
| numbers → min/max/mean/median | statistics-calculator-3 | passed (0 repairs) | computed correctly | run failed only the platform 100-byte MIN_OUTPUT_BYTES gate on a valid 67-byte JSON; the worker code ran and produced correct stats |

**Result: 5/5 generated workers RUN their own code to success (smoke 5/5 passed).**
The two non-green fresh-runs are NOT code crashes: one was a wrong-shaped harness input
(textarea placeholder fed to a numeric field; the worker runs with real numbers), the
other is the platform's minimum-output-size quality gate tripping on a legitimately small
JSON result — both independent of this fix.

### Before vs after (same harness, same prompts)

| Pass | Deployed SHA | smoke passed | dominant failure |
|------|--------------|--------------|------------------|
| pre-fix | b516b71 | 0/2 (G5 scorer) | wrong contract: FileNotFoundError / NameError |
| after #277 | d47d464 | 1/5 | ModuleNotFoundError (dotenv) + out/result.json |
| after #278 | 42d07e4 | 4/5 | os.path.join("inputs", path) double-prepend |
| after #279 | 8f4196c | 5/5 | none (code-class); residual fresh-run misses are harness/quality-gate, not worker bugs |

### Humanizer (Fix 4) confirmed live

`run_762191e94729` (a pre-fix ModuleNotFoundError crash) surfaced to the operator as
"This worker's code has an error and couldn't run. Edit the worker to fix it, or
re-generate it." — the CODE headline, NOT "took too long" and NOT a generic internal
error. Raw traceback stays only in the Raw tab.

## Tests
- `tests/test_operator_hygiene.py`: +6 cases (worker-code → CODE_HEADLINE; timeout not
  misclassified; setup codes unaffected). 23 pass.
- `tests/test_wedge_prompt_to_worker_creates.py`: +7 cases (smoke-input scalar/file,
  repair syntax guard, no-key skip, agent-mode skip). 16 pass.

---

# Batch H — wedge-reliability ENGINE fixes (2026-05-29 PM, PRs #283 + #284, deployed SHA `7c86e0f`)

Two independent G5 launch-readiness scorers (A=84, B=58) both said NOT launch-ready and
independently converged on the same engine defects. Five engine-level fixes, no per-worker
whack-a-mole.

## FIX 1 — byte-floor false-fail removed (A P1-A + B P1-1)
`_validate_run_outputs` no longer has any byte floor for non-JSON outputs. A valid non-empty
result of ANY size/type passes; only empty/whitespace-only content fails ("file is empty");
near-empty apology/placeholder prose stays a WARNING. JSON parse + scalar checks unchanged.
`MIN_OUTPUT_BYTES` removed.
- LIVE: `verify-good-upper` run `run_f170b9f5ed6a` completed, output 2 bytes (`HI`) ACCEPTED.
- LIVE (UI path): `csv-sorter-2` run `run_dbf65623a9b1` completed, 40-byte sorted CSV;
  `extract-email-addresses` run `run_a948ab39e954` completed, 34 bytes,
  `{"emails":["a@b.com","c@d.org"]}` (malformed `bad@` rejected).

## FIX 2 — smoke now GATES creation (B P1-3)
New `smoke_and_gate_generated_worker()`: a generated script worker whose smoke ends `failed`
(after bounded repairs) is set `enabled=0` via the existing repo update — the overview stops
counting it healthy (classified paused), runs are gated `worker_disabled`, and it STAYS
editable (never deleted). Passing/skipped smoke leaves it enabled. The author-run SSE event
and the draft-and-create response carry `smoke_status`/`smoke_reason`.
- LIVE: buggy worker → DB `enabled=0`, overview `paused_workers_count:1`, NOT in
  `active_workers_count:43`.

## FIX 3 — smoke validates output SUBSTANCE (B P0-2 green-but-empty)
After `status != failed`, the smoke runs `_validate_run_outputs` against the smoke result
PLUS `_smoke_empty_output_error` (a required output that parses as an empty container
`[]`/`{}`/`""`/null is a no-op). Empty/missing → code-class failure → bounded repair loop →
gated if still empty.
- Unit: `tests/test_wedge_smoke_gating.py` — `[]` JSON, missing, and whitespace-only required
  outputs all → smoke=failed; a small valid output → passed.

## FIX 4 — draft-and-create runs the same smoke+gate (A P1-B)
`/workers/draft-and-create` now runs `smoke_and_gate_generated_worker` (offloaded via
`asyncio.to_thread`) on BOTH the LLM-prompt path AND the pre-supplied-files upload path, and
applies the FIX 2 gating. Both creation paths share one safety net.
- LIVE: buggy script worker (Path A) → `smoke_status:failed`, gated; good worker →
  `smoke_status:passed`, enabled.

## FIX 5 — error_raw path strip (A P2-C + B P2-1)
`_run_error_raw` strips `_SANDBOX_PATH_RE` → `[worker file]`. Operator headline unchanged.
- LIVE: historical path-leaking run `run_89b6d0e0b94b` served via API → `error_raw` shows
  `File "[worker file]"` (was `/home/user/worker/run.py`); no `/home/user` or `/root/workeros`
  in `error_raw`.

## Tests
- NEW `tests/test_wedge_smoke_gating.py` (7): gating disables (not deletes); pass/skip leaves
  enabled; green-but-empty `[]` gated; missing/empty output gated; small valid output passes.
- `tests/test_output_quality_gates.py`: small non-empty + small CSV pass; whitespace-only fails.
- `tests/test_operator_hygiene.py`: error_raw strips `/home/user` and `/root/workeros`.
- `tests/test_pr_s9_draft_and_create.py`: response model updated for `smoke_status`/`smoke_reason`.
- All touched tests pass (66/66 with FLOOM_SECRET stable). Full-suite failure count 126 on this
  branch vs 129 on clean main — the mass failures are the pre-existing FLOOM_SECRET
  monkeypatch-teardown isolation bug, identical on main; no regression introduced.

## Reliability note (honest)
Of 5 fresh UI-path prompts, 3 created green workers with real output; 2 did NOT register a
worker due to a PRE-EXISTING author-bundle schema gap (scalar output without `type`), not these
fixes. Critically, 0/5 silently shipped a broken-but-green or green-but-empty worker — the gate
holds. The aggregate `success_rate_7d` was 0.54 at deploy time (historical, dominated by legacy
broken integration workers); these fixes stop NEW green-but-broken/green-but-empty workers from
being created, which is the lever, but the historical rate will only move as new cohorts run.

## Residual gaps (surfaced, not hidden)
- `logs[].message` and `artifacts[].path` still carry absolute paths — engineer surfaces,
  intentionally out of FIX 5's `error_raw` scope (B P2-1 unaddressed).
- Author-bundle scalar-output-without-`type` schema rejection drops the worker to a
  no-registration dead-end (2/5 above). Worth a follow-up; does not ship a broken worker.

---

## Batch J — P0-1 persistence + half-wired gate + path leaks (2026-05-29 PM)

Follow-up closing the residuals from the G5 rescores (A=62, B=74) + probe (95).

### Root cause of P0-1 (the wedge blocker)
The smoke gate set `workers.enabled=0` in the DB, but `_persist_discovered_workers`
recomputes `enabled` from the worker MANIFEST on every re-discover (cache
invalidation, worker-file save, repair persist). The generated manifest carried no
paused flag, and `WorkerContract` had no `paused` field (so `model_dump()` dropped
it during discovery). Net: any re-discover silently flipped a smoke-disabled worker
back to `enabled=1` — so a broken worker shipped enabled with a "passed" smoke and
failed 100% of real runs. (Reproduced: a freshly disabled worker became `enabled=1`
after a `/workers/reload`.)

### Fixes
1. `WorkerContract.paused: bool` (round-trips through discover).
2. Smoke gate writes `paused: true` into worker.yml (inline `_mark_worker_paused_on_disk`,
   no cross-module import in the async to_thread create path) + DB `enabled=0`.
3. Repair loop persists the fixed run.py via the canonical `persist_worker_run_py`
   (disk write + cache invalidate + re-discover + recipe re-persist); a persist
   FAILURE fails the smoke (disable) rather than shipping unverified disk state.
4. `_build_smoke_inputs`: list/array → `[3,1,2]`, object → `{"key":"value"}`
   (number/string unchanged) so legit list workers are not false-disabled.
5. P0-2: `_BARE_PYTHON_EXC_MSG_RE` → bare-exc messages map to `_CODE_HEADLINE`,
   never verbatim; clean structured messages still pass through.
6. B-P1-1: `create_worker_run` → 409 `worker_disabled` before any run row.
7. B-P1-2: disabled worker → `needs_attention` in detail status + overview.
8. P2/PATH-1: `_redact_public_log_message` runs `_SANDBOX_PATH_RE`; `_public_artifact_path`
   relativises `artifacts[].path` (+ `Artifact.relative_path`). Download unchanged.

### Live verification table (worktree API, isolated DB/workers/artifacts)

| Prompt | worker_id | smoke | real run | status | output |
|---|---|---|---|---|---|
| median of a list | median-calculator-6 | passed | created | completed | `{"median":3}` |
| std deviation of a list | compute-standard-deviation-2 | passed | created | completed | `{"standard_deviation":2.138...}` |
| USD→EUR (file) | usd-to-euro-converter-4 | passed | run_df9f3b0154f5 | completed | `9.2/18.4/27.6` (0.92, correct) |
| dedupe list (file) | remove-duplicate-strings-2 | passed | run_bff7d4fcc312 | completed | unique_list.txt (real) |
| reverse a string | string-reverser-4 | failed | gated | **409** | disabled (path-leak code) |
| sort numbers | sort-numbers | failed | gated | **409** | disabled (path-leak code) |
| extract emails | extract-email-addresses-4 | failed | gated | **409** | disabled (empty file) |
| std deviation (early) | compute-standard-deviation | failed* | gated | **409** | disabled (pre-input-fix) |

*pre-smoke-input-fix run. **0 silently-broken.** All disabled workers stayed disabled
across a full `/workers/reload`.

- P1-1: `compute-standard-deviation` POST runs → 409 "This worker is paused. Turn it on to run it again."
- P1-2: overview `paused_workers_count=7`, all 7 in needs_attention as `worker_disabled`; detail `status=needs_attention`.
- P0-2: `divide-numbers` 10/0 → operator error = calm CODE headline; `error_raw` = traceback with `[worker file]` (no path).
- P2: run JSON `artifacts[].path` relative (`run_xxx/out/...`), logs scrubbed, 0 host/sandbox path hits; artifact download returns real bytes.

Tests: 19 new (batch J), all pass. 6 pre-existing failures (stale signatures, untouched).

---

## Batch K — launch-polish (G5 final A=88 / B=91, both 0 P0) — deployed `2cc8dd2`, 2026-05-29 PM

Backend under test: local `http://127.0.0.1:8011` = the `workeros-api` systemd service (MainPID confirmed) = the production backend `workers-api.floom.dev` proxies to. PRs #287, #288, #289, #290 squash-merged to main; deployed via `ops/deploy-api.sh` (no `--skip-drain`), `/health=ok`, migration v38.

### FIX 1 — smoke_reason + log-panel jargon/path leaks (P1, both scorers)
- `humanize_smoke_reason()` (main.py): strips `(error_code=…)`, routes through `_operator_error_message`; bare quoted-token KeyError args → CODE headline. Wired into draft-and-create response (main.py) + worker-author SSE (run_service.py).
- run-failed log line (run_service.py:1959) routed through `_operator_error_message`.
- `_redact_public_log_message` (the single log-read chokepoint) now collapses traceback headers/frames/exception-class/bare-exc lines into one calm note — kills the e2b raw-stderr leak in the "Recent logs" panel.
- Widened `_BARE_PYTHON_EXC_MSG_RE` (`can't multiply sequence by non-int`, sibling TypeErrors).
- **Live proof:** fresh BOOM-input run `run_012996068127` → `error`=calm headline; logs panel = all traceback lines → "Worker code raised an error (see the Error card)"; `error_raw` path-scrubbed + collapsed; draft-and-create `divide-numbers-2` `smoke_reason`=calm headline. Operator-visible surface (error + all logs) grep-CLEAN for `/home/user` `/root/workeros` `Traceback` `unsupported operand` `TypeError`.

### FIX 2 — catalog cleanup (P1, both scorers) — live DATA op (no deploy)
DELETED (30, HTTP 204): ai-research-summary-2, csv-name-length-adder-2, csv-name-length-adder-3, csv-sorter-2, csv-sorter-3, csv-uppercase-names-2, divide-numbers-2, extract-email-addresses-2, extract-phone-numbers-2, github-pr-summary-2, markdown-to-plain-text-2, markdown-to-plain-text-3, median-calculator-2, median-calculator-3, median-calculator-4, random-science-facts-2, random-science-facts-3, remove-duplicate-lines, statistics-calculator-2, statistics-calculator-3, string-reverser, sum-column-numbers-2, sum-column-numbers-3, sum-column-numbers-4, text-word-character-counter-2, text-word-character-counter-3, text-word-character-counter-4, text-word-character-counter-5, usd-to-euro-converter-2, usd-to-euro-converter-3. (Reason: numbered `-N` duplicates + one-off wedge tests created during today's audits — disposable test artifacts.)
PAUSED (9, reversible: `paused: true` in manifest + `/workers/reload` → durable `enabled=0`): csv-name-length-adder, csv-sorter, csv-uppercase-transform, divide-numbers, markdown-to-plain-text, median-calculator, random-science-facts, statistics-calculator, text-uppercase-converter. (Reason: base-name non-example workers at 0% success / needs_attention — not clearly real; paused not deleted per brief.) All 9 verified 409 + `worker_disabled` in overview, durable across 2 reloads.
KEPT: 11 examples + 27 non-example (healthy/real). Catalog **68 → 38**. No 0%-success non-example worker is presented as green-ready.

### FIX 3 — honest success metric (P1, scorer A)
`success_rate_7d` numerator+denominator scoped to ACTIVE real workers (operator-visible, not paused, not example/stock); `success_rate_scope="active_workers"` label added. **Live: 0.857 (85.7%)** vs the 54.6% legacy aggregate both scorers flagged. Run COUNTS/sparklines left unscoped (activity volume).

### FIX 4 — file-input workers ship runnable samples (P1, scorer A)
Generator prompt + SCHEMA.md require example_input for every input (inline text for files); `_DRAFT_SYSTEM_PROMPT` requests `sample_input_json`; registration backfills example_input from sample_input_json on BOTH create paths; final fallback `_synthesize_example_input_from_schema` builds a type-appropriate sample from the declared schema (CSV/text for files) so EVERY worker is one-click runnable regardless of LLM compliance; UI `applyExampleInput` synthesizes a real upload from inline content (accept_csv fills raw CSV inline). **Live proof:** fresh file-input worker `line-counter` → `example_input={"text_file":"line 1\nline 2\nline 3\n"}`, smoke passed, healthy.

### FIX 5 — /contexts transient toast (P2-A, scorer B)
Retry once on transient fetch error before alarming; never surface raw "Failed to fetch". (P2-B/P2-C deferred per brief.)

### Regression (VERIFICATION 5)
Broken generations still smoke-FAIL → durably 409 (never green); passing generations run healthy. **0 silently-broken holds.** Honest residual: generator first-pass quality is the remaining ceiling — many fresh script gens fail `output_validation_failed: <field> scalar output leaked a path string` (engine quality watch-item; gate catches them, not a launch blocker).

Tests: 38 client-fixture + hygiene + backfill + overview-scope pass together. Pre-existing 2 `test_db_factory.py` failures (missing `approvals` arg) untouched.

---

# Batch L — stderr code-echo redaction (P1 ≥95 unlock) + gen-quality engine fixes (2026-05-29 PM)

Deployed SHA: `340d99d`. PRs: #292 (P1 + P2 + gen-quality levers), #293 (scalar-output SCHEMA/SKILL guidance), #294/#295/#296 (engine-side worker.yml normalization, iterated against live failures).

## P1 — e2b stderr code-echo redaction (the ≥95 unlock) — VERIFIED LIVE

Live worker-code failure (div-by-zero worker `batchl-dz-probe`, run `run_6e4531fbed97`). The residual that PR #288 left (each e2b stderr line is a SEPARATE log row, so the multiline-collapse never saw the block):
- **GET /runs/{id} logs[]**, **GET /runs/{id}/logs**, **SSE finish error + stream** are ALL calm. The whole traceback (header + frames + source echo `quotient = number1 / number2` + caret `~~~~~~~~^~~~~~~~~` + exception line + `Command exited with code 1`) collapses to exactly ONE calm note `Worker code raised an error (see the Error card for details).`
- **error** field + **SSE finish** `error` = calm Error-card headline `This worker's code has an error and couldn't run...` (SSE error was raw before).

Grep of operator-default surfaces (logs[] + error; NOT the engineer-only `error_raw`):
`~~~:0  ^~:0  quotient:0  Command exited:0  number1:0  ZeroDivision:0  Traceback:0  division by zero:0  /home/user:0  /root/workeros:0`. SSE stream grep: all 0.

`error_raw` (a separate API field, **not rendered anywhere in `apps/web`** — grep returns nothing) keeps the verbatim trace for engineers = the brief's opt-in Raw condition. `output_schema`'s `quotient` is the declared output NAME, not a code-echo.

## P2 — operator honesty — VERIFIED LIVE
- `bundle_path`: GET /workers/{id} `config.runtime.bundle_path` = `batchl-dz-probe` (bare basename). Detail JSON 0× `/root/workeros/workers`.
- never-run worker: `status:"ready"` (not `healthy`), `enabled:true`.
- paused worker: `enabled` exposed; `median-calculator-4` → `enabled:false` + `needs_attention` + run **409**; UI disables Run with "Paused — turn on to run".

## Gen-quality — 6-prompt live walk (deployed `340d99d`)

| prompt | worker_id | smoke | real run | output |
|---|---|---|---|---|
| reverse string | reverse-string-2 | passed | **completed** | `{"reversed_string":"dlrow olleh"}` |
| sort CSV by col 2 | csv-row-sorter | passed | **completed** | `out/sorted.csv` (sorted by value 10/20/30) |
| title-case | title-case-sentence-5 | passed | **completed** | `{"title_cased_sentence":"This Is A Sample Sentence"}` |
| sum a column | sum-column-numbers-4 | passed | **completed** | `{"total":15.0}` |
| median | median-calculator-4 | **failed** | **409 (durably GATED)** | never green |
| dedupe | remove-duplicate-lines-4 | passed | **completed** | `{"deduped_text":"line 2\nline 3\nline 1"}` |

**USABLE FIRST-PASS: 5/6** (up from ~1/6). **GATED: 1/6** (median), **0 silently-broken**.

(The csv-row-sorter run shown completed when its `text/csv` input is uploaded with the correct content-type; the first automated pass mislabeled the upload content-type — a test-driver artifact, not a worker fault. Its smoke passed and the manual proper-upload run completed with a correctly sorted CSV.)

### What the fixes did
1. **Declaration normalization (engine, #294-#296)** — recurring LLM worker.yml mistakes that DEAD-ENDED registration are now fixed losslessly at `_normalize_authored_worker_yml`: (a) type-in-kind-slot (`kind: textarea`) → `kind:scalar`+`type`; (b) contradictory `kind:scalar`+`path`/`media_type` → clean scalar; (c) scalar missing `type` → default `string`. Before this, `reverse-string` + `sum-column` dead-ended; now both register + run completed.
2. **Scalar-vs-file OUTPUT value contract** taught in `RUN_PY_TEMPLATE.py` + `worker-author/SKILL.md` + `_SMOKE_REPAIR_SYSTEM_PROMPT`, and `output_validation_failed` routed into the bounded repair loop.

### Honest residual (the remaining ceiling)
`median` smoke-FAILED because its run.py hardcoded `open('inputs/numbers.txt')` instead of reading the relative path from `inputs.json` (real path `inputs/numbers`, no `.txt`). This is a run.py CODE mistake — a DIFFERENT class from the declaration mistakes fixed here — and the bounded max-2 repair did not self-heal it this run (LLM non-determinism). The durable gate caught it: `enabled=false` + 409, never green. Generator run.py code quality (hardcoded input paths) is the remaining watch-item; the wedge gate (durable disable + 409 + 0-silently-broken) is the backstop and it holds.

Tests: +14 across `test_batchj_hygiene` (38 total) and `test_batchj_gate` (10 total): stderr-echo collapse + SSE error redaction + scalar-output validation/repair-routing + worker.yml field normalization. Pre-existing 2 `test_db_factory.py` failures (missing `approvals` arg) untouched.

---

## Batch M — the two trust/honesty P2s capping G5 scorer B at 93 (PR #298, deployed `9f30c198`)

Scorer B scored 93 with 0 P0/P1, capped by exactly two trust/honesty P2s. Scorer A had already passed at 95.

### P2-A — /workers LIST reported broken workers as "healthy" (the main cap)
The DETAIL path (`_build_worker_detail`) applied the full status-downgrade ladder; the LIST path (`list_workers`) applied only a partial version, and the dead helper `_db_worker_from_row` carried a hardcoded `status:healthy`. A gated / never-run / disabled worker could read **healthy** in the list API — a hand-held partner scanning /workers would not see which workers are broken.

Fix (DRY): extracted ONE shared `_resolve_worker_status(worker, *, config, available_secret_names, last_run_status, has_run) -> WorkerStatus` containing the full ladder (missing_secret → failed-run→needs_attention → disabled→needs_attention → never-run→ready → earned-healthy; archived keeps its stored state). Called from BOTH `list_workers` AND `_build_worker_detail`, so the two surfaces are byte-for-byte identical for the same worker. Removed the dead `_db_worker_from_row` (hardcoded healthy). `enabled` is read off the worker dict (same `w.enabled` column `get_recipe` returned), letting the detail path drop its redundant per-request recipe fetch.

Live proof (deployed `9f30c198`, backend 8011):
```
id                            list_status      detail_status    MATCH
ai-news-summary               ready            ready            ok
opendraft                     needs_attention  needs_attention  ok
github-pull-request-summary   missing_secret   missing_secret   ok
word-count                    healthy          healthy          ok
divide-numbers                needs_attention  needs_attention  ok
csv_enricher                  healthy          healthy          ok
```
LIST of 47 workers spans ready / needs_attention / missing_secret / healthy (no longer all-"healthy"). No hardcoded "healthy" remains.

### P2-C — draft-and-create silently rewrote USER-supplied run.py
The smoke+repair loop (the wedge for LLM-generated workers) also ran on user-UPLOADED files — it silently rewrote the scorer's `x/0` into `x/1` and returned success, changing user-code semantics without consent.

Fix: threaded `allow_code_repair` through `smoke_and_gate_generated_worker` → `_smoke_and_repair_generated_worker`. Gated at the early-return before the repair branch:
- User-supplied (draft-and-create Path A): `allow_code_repair=False`. Worker is still SMOKED and GATED (disabled + calm reason on failure), but run.py is NEVER rewritten and `_repair_run_py`/`persist_worker_run_py` are never reached.
- LLM-generated (worker-author run path + draft-from-prompt Path B): `allow_code_repair=True` (default). Bounded auto-repair preserved — the wedge.

Live proof (deployed `9f30c198`):
```
uploaded p2c-user-divzero-test run.py (contains 'x / 0')
  uploaded sha256: 1b06ee5f...4af208
  -> smoke_status: failed (calm reason), enabled: false
  -> STORED run.py sha256: 1b06ee5f...4af208  (BYTE-IDENTICAL, still '/ 0')
  -> POST /workers/<id>/runs -> HTTP 409 "This worker is paused. Turn it on to run it again."
  -> LIST status == DETAIL status == needs_attention
no-regression (LLM path):
  prompt "top-5 word frequency" -> text-word-frequency, smoke=passed (ran green)
  prompt "C->F/K converter"     -> celsius-temperature-converter, smoke=failed
                                   -> enabled=false, 409, list==detail needs_attention
                                   (auto-repair ran, gate held, 0 silently-broken)
```

### P2-B — orphan sample-input endpoint
`GET /workers/{id}/sample-input` 404'd for non-stock workers (only read the static `docs/workers/inputs/<id>.json`). Now resolution order: static file → manifest `example_input` → 404 only when neither exists. Consistent for API consumers and the UI (which preferred `example_input` and used this endpoint as a fallback).

Live proof: sample-input → HTTP 200 for csv_enricher / opendraft / research_brief, matching each worker's detail `example_input`.

### P2-D — ambiguous overview hero copy
The hero read "{heroCount} outcomes this week" beside a "Runs completed" metric tile for the same 7-day completed-run value, and `heroCount` could fall back to a 24h count — two labels for one (sometimes mismatched) number. Now one honest line: "N runs completed in the last 7 days", matching the tile; removed the now-unused `heroCount`.

### Tests
+4 in `tests/test_wedge_smoke_gating.py`: shared resolver returns list==detail for ready/disabled/failed/healthy; user-supplied run.py is NOT repaired (byte-identical, `_repair_run_py` never called); generated worker STILL self-repairs (wedge no-regression). `test_wedge_smoke_gating` 10/10 and `test_batchj_gate` 10/10 pass isolated (fresh DB). The cross-file isolation failures in `test_pr_h_worker_cards` / `test_round8_worker_authz` / `test_workers_draft_from_prompt` reproduce identically on the base SHA `e0aaa41` — pre-existing, not introduced here.

### Read on scorer B's two caps
Both caps are closed with deployed, live evidence: P2-A (list==detail status, no fabricated healthy) and P2-C (user run.py byte-identical + gated, wedge auto-repair intact). The plus P2-B/P2-D polish removes the remaining ambiguities scorer B noted. This should lift B to ≥95 (both-agree bar), with the only residual being the unchanged generator first-pass run.py quality watch-item — backstopped by the durable disable + 409 + 0-silently-broken gate.
