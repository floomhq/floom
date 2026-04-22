# Runtime and limits

Floom runs hosted apps in one Docker container per run. The current launch-week defaults are conservative and code-backed.

## Launch-week defaults

| Limit | Current default | What it means |
|---|---|---|
| Build timeout | 10 minutes | Image builds stop after 600 seconds. |
| Sync run timeout | 5 minutes | `POST /api/run` and `POST /api/:slug/run` will not run forever. |
| Async job timeout | 30 minutes | Background jobs default to 30 minutes unless the app sets a shorter timeout. |
| Memory cap | 512 MB per run | Hosted run containers get a 512 MB memory limit. |
| CPU cap | 1 vCPU per run | Hosted run containers default to one CPU core. |
| Anonymous run budget | 150 runs / hour / IP | Shared public traffic is throttled before it can drain one host. |
| Signed-in run budget | 300 runs / hour / user | Authenticated users get more headroom than anonymous callers. |
| Per `(IP, app)` budget | 500 runs / hour | One hot slug cannot monopolize the box. |
| Demo BYOK budget | 5 free runs / 24h / IP / demo slug | After that, launch demos require the caller's own Gemini key. |

## Concurrency today

- There is **no explicit per-app or per-workspace concurrency cap** in the code today.
- Effective concurrency is bounded by host capacity, Docker scheduling, and the rate limits above.
- Async jobs are stored in SQLite and claimed by a single worker loop per server process.
- The repo does **not** claim automatic horizontal scaling or a distributed queue today.

## What happens under load

- If a caller stays within the published budgets, Floom dispatches the run immediately.
- If a caller exceeds a budget, Floom returns **HTTP 429** with retry metadata instead of silently queueing forever.
- Sync runs stop at the five-minute timeout.
- Async jobs can wait in the SQLite queue, then time out at the job limit if they never finish.

## Cold starts

- **Proxied apps** do not build a container at request time. Floom forwards to the upstream API and adds web, MCP, and auth surfaces around it.
- **Hosted apps** build an image once, then each run starts a fresh container from that image.
- The repo does **not** publish a cold-start SLA. Exact startup time depends on the app image and the host.

## Burst behavior

- Rate limits are sliding windows in memory on each server process.
- A single-node preview or self-host deployment resets those counters on restart.
- Multi-node shared-state rate limiting is **not** in this repo yet.

## Scale path

- **Today:** one server process, one SQLite database, one background worker loop, per-run Docker containers.
- **Next step:** move rate-limit state and job dispatch out of process, then add more workers or dedicated infra.
- **When a workload outgrows shared cloud defaults:** self-host it or move the app onto dedicated infrastructure.

## When to use proxied mode instead

- Choose proxied mode when you already have a stable upstream API and want Floom to add MCP, web, and share surfaces without paying container cold starts.
- Choose hosted mode when the app logic itself needs Floom to build and run code.

## Related pages

- [/docs/security](/docs/security)
- [/docs/observability](/docs/observability)
- [/docs/workflow](/docs/workflow)
- [/docs/reliability](/docs/reliability)
