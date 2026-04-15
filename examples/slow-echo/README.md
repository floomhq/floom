# Slow Echo

A minimal async Floom example. Sleeps 5 seconds, then echoes whatever you sent.
Exists to prove the v0.3.0 job queue works end-to-end.

## What's here

- `server.mjs` — tiny Node HTTP server with an OpenAPI spec at `/openapi.json`
  and a `POST /echo` endpoint that `await setTimeout(5_000)` and returns the input.
- `apps.yaml` — Floom config that points at `server.mjs` with `async: true`.

## Run it

```bash
# 1. Start the slow-echo upstream (port 4101)
node examples/slow-echo/server.mjs &

# 2. Start Floom pointed at its apps.yaml
FLOOM_APPS_CONFIG=examples/slow-echo/apps.yaml \
  DATA_DIR=/tmp/floom-slow-echo \
  node apps/server/dist/index.js &

# 3. Enqueue a job
curl -sX POST http://localhost:3051/api/slow-echo/jobs \
  -H 'content-type: application/json' \
  -d '{"inputs": {"message": "hello"}}' | jq
# → { job_id, status: "queued", poll_url, ... }

# 4. Poll until done (5-6 seconds)
curl -s http://localhost:3051/api/slow-echo/jobs/job_XXX | jq
# → { status: "succeeded", output: { echoed: "hello", delay_ms: 5000 }, ... }
```

See the main `docs/SELF_HOST.md` "Long-running apps" section for the full
protocol and webhook payload shape.
