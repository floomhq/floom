# Workeros — Final Gate G5 (Independent Scorer B) — 2026-05-29

- **Target:** https://workers.floom.dev (live, single-tenant OS)
- **Commit under test:** main `7be92d6` ("docs(wedge): mark P0 prompt-to-worker VERIFIED + live screenshots (#274)")
- **Lens:** fresh skeptical reviewer, INVESTOR-demo frame ("would I fund/ship this?")
- **Method:** live AX41 Browser Broker walk; drove every flow myself; trusted nothing claimed.
- **Gate requirement:** ≥95 to pass G5. Two independent scorers must both agree ≥95.
- **Prior walks:** 88 → 93 → 92 → 96 → 78 → (this).

## OVERALL: 84 / 100 — STATE: NOT READY (G5 FAIL)

### Verdict on ≥95: **NO.**

The flow that IS the wedge — "describe the job in plain English, Floom drafts the
worker, and it RUNS" — does not deliver a running worker. I drove the prompt-to-worker
flow twice with two trivially-simple prompts. Both produced real, well-formed workers
(worker.yml + run.py + requirements.txt, editor opens, catalog +1) — the prior-walk P0
("prompt created no worker") IS fixed. But **both generated workers fail on their very
first run, and on re-run**, with two different generator-quality defects:

1. **Worker 1 (`daily-science-facts`)** — `NameError: name 'os' is not defined` at
   `run.py:21` (`os.makedirs('out', ...)`). The generator wrote code that uses `os`
   without `import os`. Failed twice (run_3729656be768, run_2d55f733f229).
2. **Worker 2 (`text-word-counter`)** — `FileNotFoundError: 'inputs/text_block'` at
   `run.py:9`. Generated code reads inputs from `Path('inputs/text_block')`, but the
   runtime did not materialize the user-supplied input at that path. A code-generator
   ↔ runtime input-passing contract mismatch (run_1fbe7f47acbf).

This is the SAME P0 class the prior 78-walk flagged, shifted one step downstream:
not "no worker created" but "worker created that cannot run." For an investor demo the
distinction is irrelevant — a founder who types a job and gets a worker that crashes on
run #1 has not been served. The HEAD commit marks this P0 "VERIFIED" on the strength of
"creates a worker"; the deeper requirement ("the worker RUNS") is not met.

**The execution substrate itself is fine** — I confirmed an existing well-authored
seed worker streams live and the HITL demo runs end-to-end (below). The failure is
isolated to **generated-code quality + the input-passing contract**, which is exactly
the wedge surface. This is launch-blocking for the "anyone describes a job" promise,
even if the manually-authored catalog works.

---

## Per-category scores

| # | Category | Score | Notes |
|---|----------|-------|-------|
| 1 | Prompt-to-worker GENERATION | 9/10 | Both prompts → real worker.yml (schema 0.3, typed inputs/outputs, e2b runner), run.py, requirements.txt; editor opens; live progress UI (Reading prompt → Drafting worker.yml → Writing run.py → Validating). Excellent. |
| 2 | **Generated worker RUNS (the wedge)** | **2/10** | **0 / 2 generated workers ran. Both crash run #1 AND re-run. Two distinct defects (missing import; input-path contract mismatch). This is the gate.** |
| 3 | Existing-worker run | 6/10 | Substrate works (seed worker streamed live, Step 1, Cancel button). But the seed "Research Brief" (93% claimed success) FAILED on my run after 1m ("reached its output limit"). 0/1 seed runs I drove succeeded. |
| 4 | HITL approval round-trip | 10/10 | Run 1 → "pending approval", Approvals badge → 1, real drafted message shown, Approve → Run 2 auto-spawned, completed, `SENT: true`, badge cleared. Clean, demo-ready. |
| 5 | Failed-run error humanization | 5/10 | Design is right: soft "Error" card, no stack trace in Result, raw isolated to Raw tab. But CONTENT is wrong — a 3.4s `FileNotFoundError` is shown as "This worker took too long and was stopped. Try simplifying the input." Misdirects a non-dev user to the wrong fix. |
| 6 | Run output cleanliness | 9/10 | HITL output artifact-native (`SENT: true`, full human-readable message as labeled .txt). No citation tokens, no raw JSON leak. Minor: "Drafted message — No output" empty label on run 2. |
| 7 | Contexts | 6/10 | Clean empty state, but nothing seeded → no file-nav to actually exercise. |
| 8 | Connections (real OAuth) | 10/10 | Genuine OAuth: GitHub (7 scopes, Active, used today 11:33), Gmail (12 scopes, Active), LinkedIn (4 scopes, Active), Google Cal/Drive/Notion "Expired — reconnect". Real accounts, scopes, last-used. Sub-nav Connected/Browse/MCP/Secrets. |
| 9 | Settings (token masking) | 10/10 | Token field `type=password` (masked). API/System/Appearance/Danger tabs. CLI/MCP/API setup commands. |
| 10 | Overview / dashboard | 9/10 | Outcome-framed ("Work done, 247 outcomes this week"), activity feed with durations + trigger type, "Coming up today". Positioning-correct. |
| 11 | Worker lifecycle / management | 6/10 | Catalog rich (folders, tags, per-worker success%, "Needs attention"/"Missing secret" badges). But **no delete/archive control in the UI** — I could only remove my test workers via the API (DELETE 204). "Archived" tab exists with no discoverable archive button. |
| 12 | Polish / error-state nav | 8/10 | Deleted-worker page = clean "Worker not found … Back to workers". No console-blocking errors observed. Live run can sit at "Step 1 start" ~60s with no sub-step progress (weak live-demo feel). |

---

## P0 (launch-blocking)

### P0-1 — Generated workers do not run (the wedge fails)
- **Evidence:** 2/2 self-driven prompts. Worker 1 `NameError: name 'os' is not defined`
  (run.py:21); Worker 2 `FileNotFoundError: 'inputs/text_block'` (run.py:9). Both failed
  on first run and re-run. Run IDs: run_3729656be768, run_2d55f733f229, run_1fbe7f47acbf.
- **Why P0:** The product's entire promise to founders/operators is "describe it, it
  runs." A worker that crashes on run #1 with a missing import or a wrong input path is
  not a usable worker. Matches the seed signal (user-generated "GitHub PR Summary Sender"
  sits at 0% success; only zero-input workers like "Daily Motivational Quote" succeed).
- **Two root causes, both fixable at the engine layer (not per-template):**
  1. Code generator emits `os.*` / other stdlib calls without the corresponding `import`.
     Needs a post-generation static check (import/lint/`py_compile`) before the worker is
     declared ready — fail-fast or auto-repair.
  2. Input-passing contract mismatch: generator writes `Path('inputs/<name>').read_text()`
     but the runtime does not place run inputs at `inputs/<name>`. Either the generator
     must target the real input convention, or the runtime must materialize inputs there.
     A generated worker's input read path must be guaranteed to resolve.
- **Suggested gate:** a freshly-generated worker must pass an automatic smoke-run with
  sample input before "Done" is offered, OR the editor must surface the failure with a
  one-click "fix it" path. Marking the P0 "VERIFIED" at "creates a worker" is premature.

## P1

### P1-1 — Error humanization maps everything to "took too long / simplify input"
- **Evidence:** 3.4s `FileNotFoundError` and 4.9s `NameError` both rendered as
  "This worker took too long and was stopped. Try simplifying the input." (The humanizer
  *does* have other categories — the seed Research Brief failure correctly read "reached
  its output limit" — so code-error → timeout is a real misclassification, not a single
  hardcoded fallback.)
- **Why P1:** A non-developer told to "simplify the input" when the real fix is "add
  `import os`" or "fix the input path" will give up. The humanization layer should map
  Python tracebacks (NameError, FileNotFoundError, ImportError) to an honest
  "the worker hit a code error" message, not a timeout message.

## P2 (polish / seed-data noise)

- **P2-1:** No worker delete/archive in the UI; removal required the API. "Archived" tab
  exists without a discoverable archive action. Operator persona can't tidy their roster.
- **P2-2:** Live run can sit at "Step 1 start" for ~60s with no sub-step progress —
  weak for a live investor demo even when it eventually finishes/fails.
- **P2-3:** "Fill with sample input" did nothing for the text-input worker (no sample
  defined); had to type manually. Minor.
- **P2-4:** Contexts has no seeded knowledge pack, so file-nav couldn't be exercised.
- **P2-5:** HITL run-2 output shows "Drafted message — No output" (empty label carried
  over from run 1). Slightly confusing.
- **Seed-data noise (NOT blockers):** low success-rates on Example workers (OpenDraft 26%,
  GitHub PR Summary Sender 0%) are audit churn from prior walks, not launch blockers.

---

## What is genuinely strong (fund/ship positives)

- **HITL approval is excellent and demo-ready** — full propose → approve → execute
  round-trip with the real message visible and `SENT: true`. This is the single most
  investor-legible flow on the site.
- **Real OAuth connections** (GitHub/Gmail/LinkedIn live, with scopes + last-used).
- **Outcome-framed dashboard** matches the locked positioning.
- **Generation UX** (live progress, real multi-file output) is impressive — the gap is
  purely that the generated code doesn't run.
- **Token masking, clean 404 recovery, no console-blocking errors.**

## Why not ≥95

The make-or-break gate (a plain-English prompt yields a worker that RUNS) failed on
both attempts I drove. Categories 2, 3, and 5 carry the score down. The platform is
visibly close — substrate, HITL, OAuth, and generation-to-editor all work — but the
core wedge does not yet deliver a running worker to the target persona. An honest 84,
not an inflated pass.

## Flaws in my own assessment (anti-inflation)

- I drove only 2 generation prompts (per brief). A larger sample could show the run
  failure rate is even worse, or that some prompt shapes do run; either way 2/2 fail is
  decisive against ≥95.
- I did not exhaustively test mobile-375 layout (broker lacks a resize tool); my walk was
  desktop-driven, so mobile-specific P-issues may exist and are not reflected here.
- I could not independently confirm whether a concurrent "wedge-P0" lane has since landed
  a fix; I scored the live `7be92d6` build as deployed at walk time (~13:05–13:13 UTC).
