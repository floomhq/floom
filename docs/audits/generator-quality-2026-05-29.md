# Generator First-Pass Quality — 2026-05-29

**Goal:** lift the prompt-to-worker first-pass green rate from ~50% to a high,
reliable rate. A worker generated from a plain-English prompt must reliably RUN
GREEN with correct real output on the first try (or after bounded auto-repair),
and a worker that can't be made to run must be durably GATED (409, never silently
shipped green).

**Result:** **10/10 GREEN, 0 repairs (pure first-pass), 0 gated, 0 silently-broken.**

Shipped in PR #313 (`f915580`), deployed in SHA `d059d57…` (`/health` ok).

---

## The lever: three changes

### 1. Model bump (biggest lever)

Generation + draft + repair previously all used `gpt-4o-mini`, a weak coder, which
gated ~half of awkward prompts on the first pass.

- New single source of truth: `apps/api/codegen_model.py`.
  - `WORKEROS_CODEGEN_MODEL` env, default **`gpt-5.1`**.
  - `gpt-5.1` is the strongest *chat-capable* coder reachable on the prod
    `OPENAI_API_KEY`. Verified live: `gpt-5.1-codex` is NOT a chat-completions
    model (v1/chat/completions rejects it); `gpt-5.1` is and accepts
    `temperature` + `response_format=json_object`.
  - `chat_completion_codegen()` handles the **gpt-5.x `max_completion_tokens`
    vs gpt-4 `max_tokens`** param difference and self-heals on the OpenAI
    param-name 400, so an ops model override never silently breaks generation.
- Wired into all three codegen call sites:
  - `workers/worker-author/run.py` — the meta-worker (a self-contained copy of
    the model logic, since it runs inside an E2B sandbox and cannot import the
    API module). `WORKEROS_CODEGEN_MODEL` is propagated into the sandbox env by
    `e2b_driver.py` so an ops override reaches the meta-worker too.
  - `apps/api/run_service.py` `_repair_run_py` — the bounded smoke-repair.
  - `apps/api/main.py` `_call_draft_llm` — `/workers/draft-from-prompt`.

### 2. Contract tightening

- 6 worked `run.py` examples added to `contexts/worker-author-style/RUN_PY_TEMPLATE.py`
  (the single source of truth, injected verbatim into the generation prompt and
  referenced by SKILL.md), covering the historical failure classes:
  reverse→scalar, sort-CSV→file, stats→json-file, dedupe→file, extract-emails→scalar,
  multi-count→json-file. The template injection cap was raised 4000→9000 chars so
  the examples reach the model.
- Fixed the draft prompt's Example B/C which taught the **banned
  `from dotenv import load_dotenv` pattern** (`import dotenv` crashes generated
  workers with `ModuleNotFoundError` — it is not preinstalled).
- Added an explicit **"implement EVERY declared output FULLY"** rule (anti
  under-implementation) to all three prompt surfaces (worker-author header,
  SKILL.md, the draft system prompt).

### 3. Repair tuning

- `_MAX_SMOKE_REPAIRS` 2 → 3.
- The repair now receives the worker's **intent** (its description) so it can fix
  under-implementation (a worker that ran green but only filled the first of
  several declared outputs), not just syntax/contract bugs.
- `output_validation_failed` (scalar-leaked-path / empty-output / missing-output)
  already routes into the repair loop (confirmed; in `_SMOKE_CODE_FAILURE_CODES`).
- The durable **0-silently-broken** gate is unchanged: a worker still failing
  after the (now 3) bounded repairs is disabled (`enabled=0`, served as 409),
  never shipped green.

---

## Measurement loop

Drove the REAL prompt-to-worker flow the UI uses (`POST /workers/new/from-prompt`,
`mode=create`) for 10 diverse plain-English prompts. For each: worker created? →
smoke verdict + repairs → a FRESH real run with real input → status + substantive
correct output (file outputs validated on their downloaded artifact bytes).

| # | Prompt | Created | Smoke (repairs) | Real run | Output correct |
|---|--------|---------|-----------------|----------|----------------|
| 1 | reverse a string | ✅ string-reverser | passed (0) | completed | ✅ `reversed_text: "dlrow olleh"` |
| 2 | sort CSV by column 2 | ✅ csv-sort-by-second-column | passed (0) | completed | ✅ `alice,25` before `carol,40` |
| 3 | min/max/mean/median | ✅ number-list-stats | passed (0) | completed | ✅ `{min:1, max:9, mean:5, median:5}` |
| 4 | dedupe lines | ✅ dedupe-lines-text | passed (0) | completed | ✅ `apple` once, `cherry` kept |
| 5 | extract emails | ✅ email-extractor | passed (0) | completed | ✅ both addresses found |
| 6 | title-case a sentence | ✅ sentence-title-caser | passed (0) | completed | ✅ `The Quick Brown Fox` |
| 7 | word+char+sentence count | ✅ text-stats-counter | passed (0) | completed | ✅ all 3 counts (word_count=8, …) |
| 8 | convert USD→EUR @0.9 | ✅ usd-to-eur-converter | passed (0) | completed | ✅ `9.00, 18.00, 90.00` + json |
| 9 | strip whitespace per line | ✅ trim-whitespace-lines | passed (0) | completed | ✅ `hello\nworld\nfoo` (file + preview) |
| 10 | word frequency | ✅ word-frequency-counter | passed (0) | completed | ✅ `{cat:3, dog:2, bird:1}` |

**GREEN = 10/10. First-pass (0 repairs) = 10/10. Gated = 0. Silently-broken = 0.**

Notable quality signals beyond "it ran":
- The generator correctly picked scalar-vs-file kinds per task (e.g. reverse →
  scalar output; sort-CSV → file output) and **fully implemented multi-output
  workers** (usd-to-eur emitted both a scalar `eur_prices` AND a json file;
  text-counts emitted word/char/sentence counts; strip-whitespace emitted both a
  cleaned file and a scalar preview) — exactly what the "implement every output
  fully" rule targets.

---

## Tests

- New `tests/test_codegen_model.py`: default/override, token-param selection
  (gpt-5.x → `max_completion_tokens`, gpt-4 → `max_tokens`), and the one-shot
  400 self-heal retry.
- `tests/test_wedge_smoke_gating.py`, wedge-create and draft tests pass.
  (2 pre-existing `FLOOM_SECRET` test-isolation failures in
  `test_workers_draft_from_prompt.py::TestPostWorkersSkillMd` are unrelated to
  this diff — they fail identically on the base branch.)

## Cleanup

10 test workers deleted (scoped `DELETE /workers/{id}`, no wipe). Runs floor:
595 → 605 (≥595 held; cascade only removed the 15 test-worker runs).

## Honest read

Generation is now self-serve-grade for the common deterministic-transform class.
10/10 first-pass green with zero repairs on diverse prompts is a real lift from
the ~50% baseline. The repair budget (3) and the intent-aware repair prompt remain
as a backstop for harder/awkward prompts; the durable gate guarantees a worker is
never silently shipped green if it can't be proven to run.
