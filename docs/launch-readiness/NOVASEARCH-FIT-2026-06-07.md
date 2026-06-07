# NovaSearch Fit Audit: Can WorkerOS Host The Real Workload?

Date: 2026-06-07

Verdict: **WorkerOS cannot host NovaSearch as-is.** WorkerOS has verified primitives for bounded worker runs, but this audit did not prove a NovaSearch task running inside WorkerOS. The current platform does not provide the persistent service, durable job queue/state, first-class MCP server, or connector/orchestration layer that NovaSearch uses in production.

## Verified Scope

NovaSearch sources inspected:

- `/root/novasearch-pilot/README.md`
- `/root/novasearch-pilot/ARCHITECTURE.md`
- `/root/novasearch-pilot/docs/novasearch-engine-flow.md`
- `/root/novasearch-pilot/server/app.py`
- `/root/novasearch-pilot/api/mcp.py`
- `/root/novasearch-pilot/lib/external_orchestration.py`
- `/root/novasearch-pilot/lib/external_jobs.py`
- `/root/novasearch-pilot/lib/outreach.py`
- `/root/novasearch-pilot/lib/emily_state.py`
- `/root/novasearch-pilot/LANGDOCK_EMILY_AGENT_SETUP.md`
- `/root/novasearch-pilot/OPERATOR_DELIVERY_RUNBOOK.md`

WorkerOS sources inspected from clean branch `audit/novasearch-fit-2026-06-07`:

- `ARCHITECTURE.md`
- `docs/AUTHORING.md`
- `apps/api/run_service.py`
- `apps/api/runner_utils.py`
- `apps/api/runner_sandbox/e2b_driver.py`
- `apps/api/runner_sandbox/agent_driver.py`
- `apps/api/models.py`
- `apps/api/worker_registry.py`
- `apps/api/scheduler.py`
- `apps/api/webhook_service.py`
- `apps/api/git_ops.py`
- `apps/api/main.py`
- `apps/api/db/sqlite.py`

## Gap Table

| NovaSearch requirement | WorkerOS today | Gap | Needed to close |
|---|---|---:|---|
| Host a long-lived FastAPI service with routes `/api/health`, `/api/match`, `/api/match/start`, `/api/match/result/{job_id}`, `/review/{query_id}`, and `/api/mcp`. | WorkerOS hosts its own FastAPI API and executes worker bundles as runs. Worker bundles are invoked through `run.py`/`SKILL.md` and must write `result.json`; no worker is exposed as an always-on HTTP app. | Missing | Add a hosted-service worker type or sidecar service runtime that can run a bundled ASGI app with health, routing, auth, logs, deploy lifecycle, and rollback. |
| Serve NovaSearch's JSON-RPC MCP endpoint with 16 tool definitions and NovaSearch-specific tool semantics. | WorkerOS exposes its own platform MCP endpoint and lets custom MCP tools trigger worker runs, but custom tools wait for a worker and time out after 120s. WorkerOS can save external MCP connections, not re-host NovaSearch's MCP surface as a native service. | Missing | Add first-class worker-hosted MCP server support or import/adapt NovaSearch MCP tools into a persistent service layer with per-tool auth, telemetry, confirmation policy, and polling semantics. |
| Preserve Emily/LangDock persona and instructions: dedicated `Emily - NovaSearch Recruiting` agent, German output, recall-first behavior, external-search policy, and send approval. | WorkerOS has agent-mode workers and workspace instructions, but no audited migration path for a dedicated third-party LangDock persona with NovaSearch's exact tool list, prompt, and LangDock-native confirmation rules. | Partial | Add a NovaSearch agent/persona export with prompt, tool registry, confirmation metadata, and smoke tests that prove the LangDock/WorkerOS agent calls the same tools with German behavior. |
| Run multi-minute CRM/v2/external workflows without request resets. NovaSearch uses streaming `/api/match` and polling `/api/match/start` to avoid Chrome HTTP/2 resets. | WorkerOS runs are bounded by `FLOOM_RUN_TIMEOUT` default 300s. E2B command timeout can be passed through, but platform MCP custom tools return an error after 120s and per-run state ends when the sandbox dies. | Partial | Split host contracts: durable jobs for long work, async polling APIs for agents, configurable per-worker timeout beyond 300s where justified, and MCP call semantics that can return job ids instead of waiting synchronously. |
| Maintain stateful, multi-step pipelines across requests: `query_log.db`, `outreach.db`, `telemetry.db`, `judge_cache.db`, external jobs, feedback labels, candidate tracking, and memory. | WorkerOS has its own SQLite DB, run artifacts, contexts, secrets, and git-backed workspace files. Worker sandboxes are ephemeral; artifacts and declared writeable contexts persist, but NovaSearch's local DB layout is not mounted as a durable app state contract. | Missing | Add per-worker durable data volumes or managed tables with migration hooks, backup/restore, retention policy, and safe access from both service routes and runs. |
| Keep a read-only CRM snapshot `data/candidates.db` available to every match without rebundling or losing it across runs. | Worker bundles can include files and contexts can mount data into E2B. The authoring contract says files outside the worker folder are not visible; large durable runtime DBs are not a first-class worker data asset. | Partial | Add managed dataset mounts for read-only SQLite/CSV assets, size limits, versioning, and cache/warmup behavior. |
| Support background jobs that survive agent timeouts. NovaSearch external MCP starts a DB-backed job and `get_external_results` polls it; FastAPI match jobs are in-memory with 10-minute TTL. | WorkerOS scheduler starts runs; it does not expose durable sub-jobs inside a worker. Custom MCP tools start a run and wait up to 120s. Retries exist for worker runs, not for NovaSearch's internal external-job model. | Missing | Implement durable job records, resumable worker substeps, job polling endpoints/tools, orphan handling, and operator-visible retry/cancel semantics. |
| Execute heavy external orchestration: Apollo density probes, Apify LinkedIn acquisition/profile fallback, Loxo, PhantomBuster, GitHub issue mirroring, OpenAI v2 judge. | WorkerOS supports outbound network from E2B workers, declared secrets, Composio connections, saved MCP connections, and generic secrets. It does not provide native Apollo/Apify/Figures/DATEV/CRM/PhantomBuster connector semantics or NovaSearch cost ledgers. | Partial | Add connector declarations for NovaSearch providers, per-provider readiness checks, key rotation, spend caps/receipts, and live smoke gates. |
| Enforce external-search cost controls: `include_external=false` default, Apollo planning, Apify lane selection, max spend, cache replay, per-lane cost events. | WorkerOS has run logs/alerts and secrets, but no platform-level external spend ledger tied to connectors or worker substeps. | Missing | Add cost-event schema and connector budget enforcement at run/job/tool-call level, with visible receipts and hard stops. |
| Preserve outreach safety: dry-run default, max 25 sends per call, sender routing, PhantomBuster readiness, LinkedIn identity magic links, and human confirmation before send. | WorkerOS has HITL approvals and connection allowlists. It does not have NovaSearch's PhantomBuster sender store/readiness/link generator nor LangDock-native send confirmation parity. | Missing | Port outreach as a dedicated service/tool with sender table, dry-run default, readiness checker, send caps, confirmation metadata, and audit rows. |
| Always-on/listener behavior for event-driven work where needed. NovaSearch itself uses API service plus warmup cron; operator docs state no durable worker queue or scheduled daily briefing push. | WorkerOS supports manual, schedule, webhook, and Composio triggers. Scheduler runs once per minute and skips if the same worker already has a running run. | Partial | For NovaSearch, this is enough for warmup and simple triggers, but not enough for service hosting or durable background external jobs. |
| Serve review links and feedback UI (`/review/{query_id}`) backed by query log labels. | WorkerOS has run detail pages, approvals, and artifacts; no worker-provided dynamic review route is exposed under the worker bundle. | Missing | Add service-route hosting or a generic review/feedback route model tied to worker-managed data. |
| Preserve observability: structured request logs, `/api/metrics`, MCP telemetry rows, operator status script, service/cron/cost readiness. | WorkerOS has run logs, metrics endpoints, alerts, system overview, and artifact capture. It does not ingest NovaSearch's MCP session telemetry, cost events, candidate/query feedback state, or operator readiness checklist. | Partial | Add workload-specific dashboards/health probes, external-provider readiness checks, and data migration for NovaSearch telemetry tables. |
| Support exact secret set: `PILOT_API_KEY`, OpenAI, judge settings, Apollo, multiple Apify keys, Loxo, PhantomBuster, GitHub issue token, load-test vars. | WorkerOS can store named secrets and inject declared secrets into `.env.local`/`secrets.json` in E2B. Platform secrets are denied from sandbox payloads. | Partial | Define a NovaSearch secret manifest with required/optional classification, readiness tests, redaction, rotation, and per-provider grouping. |
| Keep run volume/concurrency under control for real recruiter use. NovaSearch has parallel judge batches and external lanes; WorkerOS has a default E2B concurrency semaphore of 18 and E2B service quota dependency. | WorkerOS caps concurrent runs and tracks active sandboxes. NovaSearch's current process-local thread pools and service requests are not mapped to WorkerOS run slots. | Partial | Capacity plan NovaSearch separately: per-service worker pool, queue/backpressure, provider rate limits, and user-visible pending states. |
| Support repository/workspace storage for worker bundles and history. | WorkerOS has git-backed workspace operations and clean branch/history patterns. | None | Use existing git workspace storage for the NovaSearch bundle once runtime/service gaps are closed. |

## Top Blockers

1. **No hosted service runtime for a worker-owned ASGI/MCP app.** NovaSearch is a persistent API and MCP server, while WorkerOS currently runs ephemeral `run.py`/agent jobs.
2. **No durable workload state contract for NovaSearch's SQLite stores.** Candidate query logs, outreach state, telemetry, judge cache, and external-job state cannot live only inside an E2B run sandbox.
3. **No durable async job/polling contract for MCP tools.** WorkerOS custom MCP tools block on a worker run and time out after 120s; NovaSearch external search returns job ids and polls.
4. **Connector/cost/outreach controls are not first-class.** Apollo/Apify/PhantomBuster/Loxo/GitHub readiness, key rotation, spend caps, dry-run, sender routing, and live-send gates are NovaSearch runtime behavior, not WorkerOS host behavior today.
5. **Emily/LangDock parity is unproven.** The exact German recruiting persona, tool list, recall-first behavior, and send-confirmation semantics are part of the workload and have no WorkerOS migration acceptance test yet.

## Recommended Sequence

1. Build a **hosted service worker runtime** for ASGI apps and MCP servers, including health checks, logs, deploy/rollback, route exposure, and per-service auth.
2. Add **durable per-worker state**: managed volumes or tables, migrations, backup/restore, and explicit read-only dataset mounts for `candidates.db`.
3. Add **durable job orchestration**: job records, run/substep status, polling tools, cancellation, retry, orphan handling, and async MCP returns.
4. Port NovaSearch connector policies: Apollo/Apify/Loxo/PhantomBuster/GitHub secrets, readiness checks, spend ledgers, dry-run defaults, and send caps.
5. Port Emily as a tested agent surface: exact tool registry, German prompt, LangDock/WorkerOS confirmation parity, and end-to-end smoke tests for CRM-only, external, screening, tracking, feedback, and dry-run outreach.

## Filed Build Issues

- [#567: NovaSearch host-fit: add worker-owned ASGI/MCP service runtime](https://github.com/floomhq/workeros/issues/567)
- [#568: NovaSearch host-fit: add durable per-worker state volumes/tables](https://github.com/floomhq/workeros/issues/568)
- [#571: NovaSearch host-fit: add durable async job and polling semantics for MCP tools](https://github.com/floomhq/workeros/issues/571)
- [#569: NovaSearch host-fit: add connector readiness, spend ledger, and outreach safety controls](https://github.com/floomhq/workeros/issues/569)
- [#570: NovaSearch host-fit: add Emily/LangDock parity migration smoke tests](https://github.com/floomhq/workeros/issues/570)

## Migration Verdict

WorkerOS has verified primitives for **bounded worker runs** today: E2B execution, declared secrets, network-capable bundles, artifacts, and `result.json` outputs. This audit did not run NovaSearch inside WorkerOS, so NovaSearch bounded-task feasibility remains unproven. WorkerOS cannot host the **real NovaSearch workload** today because the workload is not a single bounded run: it is a persistent API/MCP service with durable state, async external jobs, connector spend controls, and a client-facing Emily agent contract.

Minimum first changes before migration:

- Add worker-owned ASGI/MCP service hosting.
- Add durable data volumes/tables for NovaSearch state.
- Add async job/polling semantics for long-running tools.
- Add NovaSearch connector/cost/outreach control plane.
- Add Emily parity smoke tests.
