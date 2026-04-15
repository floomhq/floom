# Session Recall — proxied-mode example

Search and analyze Claude Code session transcripts. Three operations:

- `POST /search` — keyword search (AND logic)
- `POST /recent` — last N user/assistant turns
- `POST /report` — retry loops, error categories, suggested CLAUDE.md rules

Pure Node.js HTTP server, no external deps, no API keys, no docker.sock.

## Run standalone

```bash
node examples/session-recall/server.mjs &
curl -sX POST http://localhost:4112/recent \
  -H 'content-type: application/json' \
  -d '{"jsonl_session":"{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}","count":5}'
```

## Run via Floom

```bash
node examples/session-recall/server.mjs &
FLOOM_APPS_CONFIG=examples/session-recall/apps.yaml \
  DATA_DIR=/tmp/floom-session-recall \
  node apps/server/dist/index.js &
curl -sX POST http://localhost:3051/api/session-recall/run \
  -H 'content-type: application/json' \
  -d '{"action":"search","inputs":{"jsonl_session":"{\"type\":\"user\",\"message\":{\"content\":\"token limit\"}}","keywords":"token"}}' | jq
```

## Docker

```bash
docker build -t floom-example-session-recall -f examples/session-recall/Dockerfile examples/session-recall
docker run -p 4112:4112 floom-example-session-recall
```
