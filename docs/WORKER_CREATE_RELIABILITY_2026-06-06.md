# Worker Create Reliability - 2026-06-06

Branch: `fix/worker-create-reliability`
Worktree: `/tmp/workeros-create-rel`
PR: #482

## Scope

This pass only touched worker CREATE, worker-author generation, post-author registration normalization, and generated-worker smoke/repair timing. It avoided the separate worker update/disable and Slack Listener lane.

## Latency Breakdown

The create UI path is already async through `POST /workers/new/from-prompt`: it starts a `worker-author` run and returns a run id. The slow work happens after that, inside the worker-author sandbox run and the post-completion registration/smoke hook.

Measured local profile with model and sandbox stubbed:

- Worker-author context read, worker scan, prompt assembly, JSON parse, and bundle validation: `0.0132s`
- Worker-author registration from `bundle.json` to worker files + DB row: `0.4390s` total, including a fresh temporary DB migration; direct file/DB registration logged `0.04s`
- Registration stages logged by the new code: artifact lookup, bundle parse, manifest normalization, and file/DB registration

External live smoke was blocked in this session:

- `OPENAI_API_KEY=unset`
- `E2B_API_KEY=unset`
- `e2b_code_interpreter` import failed with `ModuleNotFoundError`

Conclusion from verified local timing: the ~120s live delay is not in YAML parsing, prompt assembly, or registration. It is in external model calls, E2B startup/execution, and the prior smoke/repair retry budget.

## Fixes

1. Worker-author now rejects valid-looking but non-functional generated bundles before returning them:
   - A prompt without schedule intent cannot accept a `schedule`/`cron` trigger.
   - `exec.entry: run.py` requires non-empty syntactically valid Python.
   - Placeholder run.py logic is rejected.
   - Every declared output name must appear in `run_code`.
   - `exec.entry: SKILL.md` requires a substantive `skill_md`.

2. Worker-author latency is now visible and bounded:
   - Logs context-read, worker-scan, prompt-build, per-model-attempt, and total generation timings.
   - Reduces generation attempts from 3 to 2 after deterministic bundle validation.

3. Registration normalization now fixes additional generated schema drift:
   - Fields with `path`/`media_type` but no `kind` are normalized to `kind: file`.
   - File fields with stray scalar `type` values drop that scalar type.
   - File outputs with `media_type` but no `path` receive a deterministic `out/<name>.<ext>` path.
   - `select` scalar fields without options/enum degrade to `string` so registration does not dead-end.

4. Generated-worker smoke/repair latency is now visible and bounded:
   - Smoke timeout cap reduced from 180s to 90s.
   - Generated-code repair budget reduced from 3 repairs to 1 repair.
   - Logs smoke budget, per-smoke-attempt duration, repair model duration, and total smoke duration.

## Verification

Passed:

```bash
python3 -m py_compile workers/worker-author/run.py apps/api/run_service.py
```

```bash
python3 -m pytest tests/test_worker_author_temperature.py apps/api/tests/test_batchj_gate.py tests/test_wedge_prompt_to_worker_creates.py tests/test_wedge_smoke_gating.py -q
# 43 passed, 5 warnings in 18.39s
```

```bash
python3 -m pytest tests/test_worker_author_temperature.py apps/api/tests/test_batchj_gate.py tests/test_wedge_smoke_gating.py -q
# 25 passed, 5 warnings in 15.50s
```

Broader create/draft regression command:

```bash
python3 -m pytest tests/test_worker_author_temperature.py apps/api/tests/test_batchj_gate.py tests/test_wedge_prompt_to_worker_creates.py tests/test_wedge_smoke_gating.py apps/api/tests/test_emily_create_runnable.py tests/test_pr_s9_draft_and_create.py tests/test_workers_draft_from_prompt.py -q
```

Result: `104 passed`, `6 failed`, `35 warnings` in `87.64s`.

All 6 failures are in worker update tests and fail with:

```text
update_worker_files() missing 1 required positional argument: 'request'
```

Those failures are outside this create reliability lane and overlap the separate worker UPDATE/DISABLE lane called out in the assignment.

## Live Smoke Status

The requested real simple worker end-to-end smoke could not be completed in this session because the active environment lacks OpenAI/E2B credentials and the E2B SDK import. I did not claim a real sandbox run. The local profile and tests use stubs and temporary isolated storage only.
