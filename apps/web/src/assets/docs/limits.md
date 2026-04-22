# Limits

The hard numbers before you build on Floom. Everything below is what the code that runs floom.dev enforces today (verified 2026-04-22).

Self-hosters can override any of these via environment variables. See [Deploy](./deploy).

## Runs

Each run of a hosted-mode app executes inside a sandboxed Docker container.

| What | Default | Override |
|---|---|---|
| Max runtime per run | **5 minutes** | `RUNNER_TIMEOUT` (ms) |
| Memory per run | **512 MB** | `RUNNER_MEMORY` |
| CPU per run | **1 core** | — |
| Output size | Bounded by Docker stdout buffer (a few MB) | — |

Runs that exceed the timeout are killed and marked `timeout`. Runs that run out of memory are killed and marked `oom`. The caller sees a specific error code, not a generic 500.

For work that takes longer than 5 minutes (scraping, batch scoring, long LLM chains), use the async **job queue** — runs persist up to 30 minutes with webhook delivery on completion, retries, and cancellation. Declare `is_async: true` in your manifest.

## Rate limits

Three buckets, applied to every run. The tightest bucket wins.

| Scope | Limit | Override |
|---|---|---|
| Per IP (anonymous) | **150 runs / hour** | `FLOOM_RATE_LIMIT_IP_PER_HOUR` |
| Per user (signed in) | **300 runs / hour** | `FLOOM_RATE_LIMIT_USER_PER_HOUR` |
| Per (IP, app) pair | **500 runs / hour** | `FLOOM_RATE_LIMIT_APP_PER_HOUR` |

Every rate-limited response sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Scope`. A 429 also sets `Retry-After`.

Signed-in users get roughly 2x the anon headroom. Authenticating gets you more room for free.

## Launch-day demos (5 free runs, then bring your own key)

Three launch apps — **lead-scorer**, **competitor-analyzer**, **resume-screener** — call Gemini and cost real money per run. They're free for 5 runs per visitor IP per 24 hours. After that the UI prompts you to paste your own Gemini API key, which Floom uses for that call only and does not persist.

Each gated app has its own 5-run budget, so burning through lead-scorer doesn't eat into the competitor-analyzer one.

## File uploads

| What | Limit |
|---|---|
| Max file size per upload | **6 MB** (decoded) |
| Browser-side cap | 5 MB (slack margin to avoid server reject) |
| Formats | Anything the app's `floom.yaml` declares in `type: file/<kind>` (e.g. `file/csv`, `file/pdf`, `file/png`). Common shortcuts: csv, pdf, png, jpg, mp3 |

Files arrive mounted read-only at `/floom/inputs/<name>.<ext>` inside your container. Your script reads them with `open(path)`.

## Models

For hosted-mode apps that declare AI, Floom runs whatever your code calls. Nothing is pinned at the platform level.

The launch-day demos default to **Gemini 3.1 Flash Lite** (free-tier friendly, fast, cheap) and let you override with **Gemini 3.1 Pro** via environment variable if you bring a paid-tier key. OpenAI and Anthropic models work too — pip-install the SDK, point your code at the right key name in `secrets_needed`, and Floom injects the key at runtime.

## API rate limits (separate from runs)

- **MCP `ingest_app`** (creating a new app from an OpenAPI spec via an agent) — **10 per user per day** (anon: per IP). Override: `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY`.
- Admin endpoints on `/api/hub/*` (publishing, editing, deleting apps) — gated by session, not a per-hour count.

## Beta caveats (read this)

Floom is pre-1.0. We run on a single replica on a Hetzner box. This is not enterprise infra yet.

- **No SLA.** We work hard to stay up but make no uptime promise.
- **No 99.9% guarantee.** Expect occasional short windows of downtime during deploys.
- **Single replica.** We haven't scaled horizontally yet. Every request hits one process. This is fine for launch-day traffic; it will not be fine at scale, and we'll cross that bridge publicly.
- **SQLite storage.** Fast and reliable for our current load. Postgres swap is on the roadmap.
- **Streaming output** — tokens don't stream to the UI yet. The full output lands when the run finishes. Server-side event streaming (logs + status) already works on the HTTP API.

If you need enterprise reliability today, **self-host**. The runtime is the same code and you get to put it behind your own load balancer.

## Next

- [Deploy](./deploy) — run Floom yourself if these limits don't fit.
- [Protocol](./protocol) — manifest shape and what each surface does.
- [Getting started](./getting-started) — ship your first app in 5 minutes.
