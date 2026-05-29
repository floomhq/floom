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
