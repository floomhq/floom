# ig-nano-scout — first private Floom app

Private app for finding nano Instagram creators by hashtag. Async (~60s per run),
residential proxy, session-cookie auth (no password), stealth Chromium.

## Private app model

This is the reference implementation of Floom's **`visibility: private`** apps:

- Not listed in `/api/hub` (public directory)
- Not listed in MCP `list_apps` / `search_apps`
- Only the `author` can `GET /api/hub/ig-nano-scout`, `POST /api/ig-nano-scout/jobs`,
  or any per-run endpoint. Everyone else gets `404` (not `403` — existence is hidden)
- Visible in `GET /api/hub/mine` for the owner

## Deployment

### 1. Build the upstream container

```bash
# on AX41
cd /root/ig-nano-scout/cloud
docker build -t floomhq/ig-nano-scout:latest .
```

### 2. Set secrets

Drop secrets into `/root/secrets/ig-nano-scout.env`. Required values (the
container refuses to return results if these are missing):

```
IG_SESSIONID=...
IG_CSRFTOKEN=...
IG_DS_USER_ID=...
EVOMI_PROXY_URL=http://USER:PASS@core-residential.evomi.com:1000
```

Optional but strongly recommended — pasting the full cookie set makes
IG's bot detection significantly happier:

```
IG_MID=...
IG_DID=...
IG_RUR=...
IG_DATR=...
```

Non-secret config (don't put in the vault; set at deploy time):

```
IG_ACCOUNT_TZ=Europe/Vienna       # default: Europe/Berlin
IG_ACCOUNT_COUNTRY=AT             # default: DE
```

### 3. Run the container

```bash
docker run -d \
  --name ig-nano-scout \
  --restart unless-stopped \
  --env-file /root/secrets/ig-nano-scout.env \
  -p 127.0.0.1:18000:8000 \
  floomhq/ig-nano-scout:latest
```

The container listens on **8000** internally; host port 18000 is what
Floom proxies to. Adjust the host side freely; the container side is
fixed by `cloud/Dockerfile`.

### 4. Register in Floom

Point Floom's apps config at this manifest (which declares `visibility: private`
and `async: true`):

```bash
# in the floom server env
FLOOM_APPS_CONFIG=/root/floom/examples/ig-nano-scout/apps.yaml
# restart floom; seed reads the YAML and ingests on boot
```

Or merge its `apps:` entry into your existing multi-app config file.

### 5. Run it

```bash
curl -X POST http://localhost:3051/api/ig-nano-scout/jobs \
  -H 'Content-Type: application/json' \
  -d '{"inputs": {"hashtags": ["vienna"], "per_tag": 5, "threshold": 10000}}'
# -> { "job_id": "job_...", "status": "queued", "poll_url": "..." }

curl $POLL_URL   # -> { status: "running" | "succeeded", output: {...} }
```

## Sanity check the privacy

```bash
# list public apps — should NOT include ig-nano-scout
curl http://localhost:3051/api/hub/ | jq '.[] | .slug' | grep -c ig-nano-scout
# -> 0

# list owner apps — SHOULD include ig-nano-scout
curl http://localhost:3051/api/hub/mine | jq '.apps[] | .slug' | grep -c ig-nano-scout
# -> 1
```
