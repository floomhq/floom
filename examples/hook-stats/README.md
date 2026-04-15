# Hook Stats — proxied-mode example

Analyzes a Claude Code `~/.claude/bash-commands.log` and returns top commands, git
stats, and per-day activity.

Pure Node.js HTTP server that exposes an OpenAPI 3.0 spec at `/openapi.json` and
one operation at `POST /analyze`. No external dependencies, no API keys, no
docker.sock. Ships as a replacement for the v0.2.0 docker-hosted bundled app.

## Run standalone

```bash
node examples/hook-stats/server.mjs &
curl -s http://localhost:4110/openapi.json | jq '.paths | keys'
curl -sX POST http://localhost:4110/analyze \
  -H 'content-type: application/json' \
  -d '{"log_content":"[2026-04-15T10:00:00] git status\n[2026-04-15T10:01:00] ls -la\n"}' | jq
```

## Run via Floom

```bash
# 1. Start the upstream
node examples/hook-stats/server.mjs &

# 2. Boot Floom pointed at the apps.yaml
FLOOM_APPS_CONFIG=examples/hook-stats/apps.yaml \
  DATA_DIR=/tmp/floom-hook-stats \
  node apps/server/dist/index.js &

# 3. Call it via Floom's unified run endpoint
curl -sX POST http://localhost:3051/api/hook-stats/run \
  -H 'content-type: application/json' \
  -d '{"action":"analyze","inputs":{"log_content":"[2026-04-15T10:00:00] git status\n"}}' | jq
```

## Docker

```bash
docker build -t floom-example-hook-stats -f examples/hook-stats/Dockerfile examples/hook-stats
docker run -p 4110:4110 floom-example-hook-stats
```
