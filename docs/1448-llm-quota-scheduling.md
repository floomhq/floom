# #1448 - LLM-rate-limit-aware run scheduling

## Problem
WorkerOS had no coordination of the downstream LLM provider quota across
concurrent runs. Measured on NovaSearch (Vertex `gemini-3-flash-preview`): one
search's judge burst (12 concurrent calls) = 12/12 OK, but two searches stacked
(24 concurrent) = ~16/24 HTTP 429. The only existing limits were run-creation
rate limits and worker-author chat throttles - API-abuse protection, not
provider-quota coordination. Workers hand-roll litellm backoff that does not
coordinate across runs.

Key constraint: **LLM calls happen inside the E2B sandbox** (worker code calls
litellm), so the engine cannot intercept or backoff them in-process. The two
real levers are (1) run scheduling/backpressure - engine-side, and (2) a managed
LLM gateway the workers route through - a new service.

## What is implemented (this change) - option 1, scheduling backpressure, tested

A worker that makes heavy/bursty LLM calls opts in via its manifest:

```yaml
# worker.yml
id: novasearch-vivek
name: NovaSearch
llm_intensive: true        # <- #1448: scheduler gates concurrent heavy runs
runtime: { type: python, runner: e2b }
```

- `WorkerConfig.llm_intensive: bool = False` (models.py) - additive,
  backward-compatible; default false means no behaviour change.
- The queue drain loop (`run_service._drain_one_batch`) gives every
  llm-intensive run an extra "LLM budget" slot from a second semaphore sized to
  `WORKEROS_MAX_CONCURRENT_LLM_RUNS` (defaults to the main run cap = off until
  set). If the budget is full, the heavy run is left `queued` and the drain
  keeps dispatching other (non-heavy) runs; the deferred run is picked up when an
  LLM slot frees (releasing it wakes the drain). Non-intensive runs are never
  gated.
- Operators set the budget to match the shared provider quota, e.g.
  `WORKEROS_MAX_CONCURRENT_LLM_RUNS=1` so two judge-heavy searches run one at a
  time instead of stacking to a 429 storm. This is pure scheduling - **no extra
  provider spend**, and it cuts wasted-retry spend.
- Tests: `tests/db/test_llm_run_budget.py` - field parse/default, manifest read,
  config parse, and a drain-loop integration test proving a heavy run is
  deferred while a light run still dispatches.

### Limitations of the scheduling approach
- The budget is a single deployment-wide gate (the provider quota is itself
  shared deployment-wide, so this matches the problem). True per-workspace
  budgets need the run's workspace on the dispatch path (a follow-up; relates to
  the #1444 settings infra, which could expose a per-workspace
  `max_concurrent_llm_runs`).
- "llm-intensive" is a coarse boolean. A weighted budget (a run declares an
  approximate concurrent-call count and consumes that many tokens of an
  RPM/concurrency bucket) would pack the quota more tightly. The semaphore here
  is the simple, safe first step.
- It bounds *concurrency*, not *request rate*. For pure RPM limits without a
  concurrency proxy, the gateway below is the real answer.

## What is NOT implemented (option 2 - the managed LLM gateway)

A managed gateway is the complete fix and the bigger build. Design:

- A first-class proxy endpoint (engine or a sidecar) that speaks the
  OpenAI/Vertex/Bedrock wire formats. Workers point litellm at it
  (`OPENAI_BASE_URL` / provider base override injected into the sandbox env) and
  send their normal calls.
- The gateway holds a **shared token/RPM bucket per provider** (and per model),
  so all runs draw from one budget instead of each hitting the raw endpoint.
- **Shared backoff:** a 429 from the provider trips a short circuit-breaker that
  every in-flight worker's calls respect, instead of each run retrying blindly.
- **Multi-region round-robin / failover:** pool several regional endpoints
  (e.g. Vertex regions) and spread load, failing a region out on sustained 429s.
- **Per-workspace accounting:** attribute spend/usage to the calling workspace
  (ties into monthly_spend_cap_usd) and enforce per-workspace budgets centrally.

This changes the worker LLM-call contract (route through the gateway) and needs
provider credentials + live load to validate (untestable on the dev host), so it
is intentionally deferred. The scheduling backpressure above removes the single
largest reliability foot-gun in the meantime and is the issue's explicitly
"cheap relative to its value" option.

Relates to #1438 (workers can't use a managed LLM), #1433 (warm pools), and
#1442 (the observability gap that hid the 429-driven failures).
