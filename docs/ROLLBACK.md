# Floom rollback runbook

## Tuesday 2026-04-28 launch P0 rollback

Use this section if launch traffic exposes a P0 on `floom.dev`.

### 1. Freeze writes and capture evidence

```bash
ssh ax41
cd /opt/floom-chat-deploy
docker compose ps
docker logs --since 20m floom-chat > /tmp/floom-p0-$(date +%Y%m%d-%H%M%S).log
bash /root/floom/scripts/ops/db-backup.sh
```

Record the failing URL, run id, app slug, current image tag, and DB backup path
in the incident note before changing code.

### 2. Code rollback

```bash
ssh ax41
cd /opt/floom-chat-deploy
docker inspect floom-chat | jq -r '.[0].Config.Image'
cp docker-compose.yml docker-compose.yml.pre-p0-$(date +%Y%m%d-%H%M%S).bak

# Replace this tag with the previous launch tag Federico approved.
sed -i 's|ghcr.io/floomhq/floom.*|ghcr.io/floomhq/floom-monorepo:<previous-launch-tag>|' docker-compose.yml
docker compose pull floom-chat
docker compose up -d --no-deps floom-chat

curl -fsS https://floom.dev/api/health | jq .
curl -fsS -o /dev/null -w '%{http_code}\n' https://floom.dev/p/competitor-lens
```

If the deploy uses a Git checkout instead of an image tag, pin the previous
launch tag in the repo and rebuild from that exact tag:

```bash
git fetch --tags
git switch --detach <previous-launch-tag>
bash scripts/ops/floom-deploy-prod.sh
```

### 3. Schema rollback

`workspace_secrets` is a forward-only copy from `user_secrets`.

If the migration fails before any successful production run depends on
workspace-level BYOK rows, restore the pre-migration DB backup:

```bash
ssh ax41
cd /opt/floom-chat-deploy
docker compose stop floom-chat
bash /root/floom/scripts/ops/db-restore.sh <backup-file>
docker compose up -d floom-chat
curl -fsS https://floom.dev/api/health | jq .
```

If restore is not acceptable and only the new table is broken:

```sql
DROP TABLE IF EXISTS workspace_secret_backfill_conflicts;
DROP TABLE IF EXISTS workspace_secrets;
```

Then restart the rolled-back code. Dropping `workspace_secrets` removes any
BYOK values written only to that table after migration. Legacy `user_secrets`
rows remain intact, but new workspace-only keys are gone unless restored from
backup.

### 4. DNS cutover

Use DNS only when the production host itself is unhealthy after code rollback.

```bash
# Verify the fallback origin first.
curl -fsS https://preview.floom.dev/api/health | jq .

# Then switch the floom.dev A/AAAA/CNAME records in IONOS to the fallback host.
# Keep TTL at 60 seconds during the incident window.
```

After DNS changes, verify:

```bash
dig +short floom.dev
curl -I https://floom.dev/
curl -fsS https://floom.dev/api/health | jq .
```

### 5. Recovery checks

```bash
for path in / /apps /docs /pricing /terms /privacy /status /p/competitor-lens; do
  curl -fsS -o /dev/null -w "$path %{http_code}\n" "https://floom.dev$path"
done

curl -fsS https://floom.dev/api/hub | jq 'map(.slug)'
```

Run one browser smoke for `competitor-lens`, `ai-readiness-audit`, and
`pitch-coach`, then post the incident state and rollback tag in
`/root/floom-internal/launch/`.

This runbook documents how to roll Floom on `preview.floom.dev` (and any
self-hosted deployment using the same `/opt/floom-chat-deploy/` layout) back
to an earlier published tag, and how to verify the roll-forward after a
failed release.

It also serves as the ground-truth log of rollback drills performed before
cutting each minor release — every release-cutting task (W2.5, W2.6, W3.4,
etc.) MUST append a timestamped drill entry here before promoting.

## Fast-path: roll a broken deploy back to the last known-good tag

```bash
cd /opt/floom-chat-deploy

# 1. snapshot the current compose file in case you need to roll forward again
cp docker-compose.yml docker-compose.yml.$(date +%Y%m%d-%H%M%S).bak

# 2. edit the image tag back to the last known-good tag, e.g.:
#    image: ghcr.io/floomhq/floom:v0.2.0
sed -i 's|ghcr.io/floomhq/floom:.*|ghcr.io/floomhq/floom:v0.2.0|' docker-compose.yml

# 3. pull + restart — `--no-deps` keeps other services (nginx, etc.) untouched
docker compose pull floom-chat
docker compose up -d --no-deps floom-chat

# 4. verify
curl -s https://preview.floom.dev/api/health | jq .
#   expected: .version == "0.2.0", .status == "ok", .apps >= 15

# 5. check nginx → container path (port 3051 on the box)
curl -s http://localhost:3051/api/health | jq .version
```

A good rollback should complete in under 30 seconds end-to-end (image is
cached, container restarts cleanly, seed apps re-ingest in <2s on cold
boot). If the rollback target image is not on disk, `docker compose pull`
will fetch it from ghcr.io; budget another 15-60 seconds for that.

## Known-good snapshots

Every promote leaves a rollback snapshot in `/opt/floom-chat-deploy/`:

| File | Rolled back to | Created |
|---|---|---|
| `docker-compose.yml.v0.1.0.bak` | v0.1.0 | before the v0.2.0 promote |
| `docker-compose.yml.v0.2.0.bak` | v0.2.0 | before the v0.3.2 promote (W2.6) |

Snapshots are plain copies of the pre-promote `docker-compose.yml`, not
templates. Restoring means `cp <snapshot> docker-compose.yml` followed by
the `docker compose up -d --no-deps floom-chat` step above.

## Drill protocol (from TEST-PROTOCOL.md section 5b)

Before cutting any release (W2.5, W2.6, W3.4, W6.4, etc.), the release
agent MUST:

1. Note the currently-running image tag on `preview.floom.dev`:
   ```bash
   docker inspect floom-chat | jq -r '.[0].Config.Image'
   ```
2. Pin back to the previous release on a throwaway port (13952 is the
   reserved drill port):
   ```bash
   docker run -d --rm --name floom-rb-<prev> \
     -p 13952:3051 -e FLOOM_SEED_APPS=true \
     -v /var/run/docker.sock:/var/run/docker.sock \
     ghcr.io/floomhq/floom:<prev>
   ```
3. Verify health + stress:
   ```bash
   curl -s http://localhost:13952/api/health | jq .
   cd ~/floom && FLOOM_STRESS_PORT=13952 \
     node test/stress/test-ingest-stress.mjs
   ```
4. Stop + re-pin forward to the new release:
   ```bash
   docker stop floom-rb-<prev>
   docker run -d --rm --name floom-rb-<new> \
     -p 13952:3051 -e FLOOM_SEED_APPS=true \
     -v /var/run/docker.sock:/var/run/docker.sock \
     ghcr.io/floomhq/floom:<new>
   ```
5. Verify health + stress again on the new pin.
6. Append a drill entry to this file with timestamps, curl output, and
   stress result. Both directions (down-roll + up-roll) must pass.
7. Clean up: `docker stop floom-rb-<new>`.

If any step fails, the release is **not** ready to promote. Flip the task
to ❌ in `WORKPLAN-3DAY.md`, document the blocker in the release report,
and escalate.

## Drill log

### 2026-04-15 — W2.6 v0.3.2-rc.1 ← → v0.2.0

- **Agent:** `b32c321d-f8b3-47a7-aede-e2b4aaa16114` (Opus 4.6, Claude Code)
- **Drill port:** 13952
- **Image under test:** `ghcr.io/floomhq/floom:v0.3.2-rc.1`
- **Rollback target:** `ghcr.io/floomhq/floom:v0.2.0`

**Step 1 — preview state snapshot (08:06:53Z)**

```
$ curl -sS https://preview.floom.dev/api/health | jq .
{
  "status": "ok",
  "service": "floom-chat",
  "version": "0.2.0",
  "apps": 15,
  "threads": 24,
  "timestamp": "2026-04-15T08:06:54.075Z"
}
$ docker inspect floom-chat | jq -r '.[0].Config.Image'
ghcr.io/floomhq/floom:v0.2.0
```

**Step 2 — pin v0.2.0 on throwaway 13952 (08:06:54Z)**

```
$ docker run -d --rm --name floom-rb-v020 \
    -p 13952:3051 -e FLOOM_SEED_APPS=true \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/floomhq/floom:v0.2.0
2cf4d0f33edeec126f07692760209d93222ddf943430a8ea154d3acf8dc37012
```

Boot to healthy: **1 second** (T+1s apps=15).

**Step 3 — verify health on v0.2.0 pin (08:07:06Z)**

```
$ curl -s http://localhost:13952/api/health | jq .
{
  "status": "ok",
  "service": "floom-chat",
  "version": "0.2.0",
  "apps": 15,
  "threads": 0,
  "timestamp": "2026-04-15T08:07:06.140Z"
}
```

**Step 4 — stress test on v0.2.0 pin**

```
$ FLOOM_STRESS_PORT=13952 node test/stress/test-ingest-stress.mjs
=== stripe === PASS (587 ops, base_url https://api.stripe.com/)
=== github === PASS (1112 ops, base_url https://api.github.com)
=== petstore === PASS (19 ops, base_url https://petstore3.swagger.io/api/v3)
=== resend === PASS (83 ops, base_url https://api.resend.com)
=== summary === passed: 4/4, failed: 0
```

Full log: `/tmp/w26-stress-v020-rb.log`.

**Step 5 — stop v0.2.0, re-pin forward to rc.1 (08:07:20Z → 08:07:36Z)**

```
$ docker stop floom-rb-v020
floom-rb-v020
$ docker run -d --rm --name floom-rb-rc1 \
    -p 13952:3051 -e FLOOM_SEED_APPS=true \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/floomhq/floom:v0.3.2-rc.1
9d82b254fb27c57157c5abd130b341ace7c63312fb78f544f89ed9e27037e085
```

Boot to healthy: **1 second** (T+1s apps=15).

**Step 6 — verify health on rc.1 pin (08:07:36Z)**

```
$ curl -s http://localhost:13952/api/health | jq .
{
  "status": "ok",
  "service": "floom-chat",
  "version": "0.3.2",
  "apps": 15,
  "threads": 0,
  "timestamp": "2026-04-15T08:07:36.442Z"
}
```

**Step 7 — stress test on rc.1 pin**

```
$ FLOOM_STRESS_PORT=13952 node test/stress/test-ingest-stress.mjs
=== stripe === PASS (587 ops, base_url https://api.stripe.com/)
=== github === PASS (1112 ops, base_url https://api.github.com)
=== petstore === PASS (19 ops, base_url https://petstore3.swagger.io/api/v3)
=== resend === PASS (83 ops, base_url https://api.resend.com)
=== summary === passed: 4/4, failed: 0
```

Full log: `/tmp/w26-stress-rc1-rb.log`.

**Result:** drill **PASSED** in both directions. v0.3.2-rc.1 is clear to
promote to v0.3.2 final and swap into `/opt/floom-chat-deploy/docker-compose.yml`.

**Cleanup:** `docker stop floom-rb-rc1`. Confirmed empty `docker ps -a
--filter name=floom-rb` afterwards.
