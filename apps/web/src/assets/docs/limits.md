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

## Concurrency

There is no per-app concurrency cap in code today. Real limits are host capacity, Docker, and the rate limits above. Async jobs are in SQLite, handled by one worker loop per process — no distributed queue is claimed.

## Under load and rate limits

Under budget, runs dispatch immediately. Over budget, **HTTP 429** with retry metadata. Sync runs hit a five-minute cap; async jobs can queue, then time out. Limits are in-memory sliding windows (reset on single-node restarts). Multi-node shared limits are not in this repo.

## Cold starts and run modes

**Proxied:** no per-request container; Floom proxies your API and adds web, MCP, and auth. **Hosted:** one image build, then a fresh container per run. No cold-start SLA; depends on the image and host.

## Scale path

**Today:** one process, one SQLite DB, one worker loop, per-run containers. **Next:** out-of-process rate limits and job dispatch, then more workers or dedicated infra. If cloud defaults are too tight, **self-host** or use dedicated hardware.

## Related pages

- [/docs/security](/docs/security)
- [/docs/observability](/docs/observability)
- [/docs/workflow](/docs/workflow)
- [/docs/reliability](/docs/reliability)
