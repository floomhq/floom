# Observability Setup

How to turn on error tracking (Sentry), health monitoring, and incident alerts
for a self-hosted or cloud-hosted Floom deployment. Every piece below is
optional and ships "off by default" in the open-source build: setting the
right environment variables is all it takes to light them up.

Five things get wired in this document:

1. **Sentry error tracking** (server + browser) with secret scrubbing.
2. **Source-map upload** so browser stacks are readable, not minified soup.
3. **External heartbeat** (cron on a separate VPS) that pages you when the
   server stops answering.
4. **App-level Discord alerts** for 5xx bursts, unhandled rejections, and
   repeated-429 abuse signals (set `DISCORD_ALERTS_WEBHOOK_URL`, section 4).
5. **PostHog product analytics** (frontend only, consent-gated) for the
   launch funnel: landings → publishes → runs (set `VITE_POSTHOG_KEY`,
   section 5).

### Consent gate (GDPR Art. 6(1)(a))

The two **frontend** telemetry SDKs — browser Sentry and PostHog — are
third-party processors. Events leave the EU and land in their ingest
pipelines. They stay fully dark until the user picks **"Accept all"** in
the cookie banner. "Essential only" keeps both SDKs quiet: no DSN call,
no transport spin-up, no PII leak on first paint. The gate lives in
[`apps/web/src/lib/consent.ts`](../apps/web/src/lib/consent.ts); the
banner calls `setConsent` and inlines `initBrowserSentry()` + `initPostHog()`
on upgrade and `closeBrowserSentry()` + `closePostHog()` on downgrade so
the choice applies mid-session without a reload.

The **backend** Sentry integration is NOT consent-gated — server errors
don't carry user PII through the scrubbed payload, and operators need
crash visibility regardless of individual consent choices.

---

## 1. Sentry DSNs

Sentry accepts errors over HTTPS keyed by a per-project DSN. Floom has two
SDKs wired — one for the Node.js server, one for the React web app — and
each needs its own DSN because Sentry projects are environment-scoped.

### Step 1: Create a Sentry account + project

Free tier covers 5,000 errors / month, which is more than enough for
pre-launch Floom traffic.

1. Sign up at [sentry.io](https://sentry.io).
2. Create a **Node.js** project → `floom-server` → copy the DSN. This goes
   into `SENTRY_DSN`.
3. Create a **React** project → `floom-web` → copy the DSN. This goes into
   `VITE_SENTRY_DSN`.

### Step 2: Set the two DSNs

The two DSNs behave very differently:

| Variable | When it's read | How to change |
|---|---|---|
| `SENTRY_DSN` | **Runtime** (container boot) | Edit `.env`, restart container |
| `VITE_SENTRY_DSN` | **Build time** (baked into JS bundle) | Edit `.env`, **rebuild image**, redeploy |

This is a Vite constraint: anything prefixed `VITE_` is inlined into the
JavaScript at `vite build` time. Changing the runtime env var after the fact
does nothing because the string isn't looked up at runtime.

**Preview self-host:**

```bash
# /opt/floom-mcp-preview/.env — append two lines
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<server-project-id>
VITE_SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<web-project-id>

# Rebuild (only needed for VITE_ vars) from the repo root:
docker build \
  --build-arg VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
  -t floom-preview-local:$(date +%Y%m%d-%H%M)-sentry \
  -f docker/Dockerfile .

# Point the compose file at the new tag, then recreate without losing data:
cd /opt/floom-mcp-preview
docker compose up -d --no-deps floom-mcp-preview
```

**Production (`/opt/floom-deploy/`):** identical flow — write the same two
vars to `/opt/floom-deploy/.env`, rebuild, swap the image tag in
`docker-compose.yml`, `docker compose up -d --no-deps prod preview`.

### Step 3: Verify

From the host, trigger an error:

```bash
# Hit a route that throws. The simplest: send a malformed run body.
curl -X POST https://preview.floom.dev/api/run \
  -H 'content-type: application/json' \
  -d '{"invalid":true}'
```

Expected: a new issue appears in your Sentry project dashboard within ~30
seconds. If it doesn't, check `docker logs floom-mcp-preview 2>&1 | grep
sentry` — the boot log should say `[sentry] initialized`. No such log means
`SENTRY_DSN` didn't make it into the container environment.

---

## 2. Source-map upload (readable browser stacks)

Without source maps, a frontend error in Sentry looks like this:

```
TypeError: Cannot read property 'x' of undefined
    at a.kX (index-abc123.js:17:42)
```

Unusable for triage. With source maps uploaded, it looks like this:

```
TypeError: Cannot read property 'renderer' of undefined
    at RunSurface.renderOutput (src/components/RunSurface.tsx:427:16)
```

To turn this on, set three more variables **at build time**:

```bash
# Sentry settings → Account → Auth Tokens → Create New Token
# Scopes needed: project:releases, project:read
export SENTRY_AUTH_TOKEN=sntrys_xxx
export SENTRY_ORG=floom
export SENTRY_PROJECT=floom-web

docker build \
  --build-arg VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
  --build-arg SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN \
  --build-arg SENTRY_ORG=$SENTRY_ORG \
  --build-arg SENTRY_PROJECT=$SENTRY_PROJECT \
  -t floom-preview-local:$(date +%Y%m%d-%H%M)-sentry \
  -f docker/Dockerfile .
```

The `@sentry/vite-plugin` is wired in `apps/web/vite.config.ts`. When
`SENTRY_AUTH_TOKEN` is unset the plugin is a no-op (safe default for OSS
users who don't use Sentry). When set, it:

1. Uploads `dist/**/*.map` to Sentry, tagged with the build's release ID.
2. Deletes the `.map` files from `dist/` before the runtime stage copies
   them, so the published image doesn't ship source maps publicly.

Verify by triggering a frontend error after deploy — the stack in Sentry
should show real file paths and line numbers.

---

## 3. External heartbeat (pager)

Sentry only sees errors the app is conscious enough to report. If the whole
box dies — OOM kill, kernel panic, disk full, network partition — Sentry
never learns. You need a heartbeat from *outside* the box.

Floom uses a 1-minute cron on a separate Hetzner VPS that hits
`https://preview.floom.dev/api/health` and posts to a Discord webhook on
two consecutive failures. The webhook feeds the `#floomit` Discord channel,
which the Clawdbot bridge forwards to WhatsApp.

### Setup on the Hetzner VPS

```bash
ssh hetzner

# Drop the env file (only you edit this — cron reads it).
sudo tee /etc/floom-heartbeat.env >/dev/null <<'EOF'
# Discord webhook URL. Create at:
# https://discord.com/channels/<guild-id>/<channel-id>/settings → Integrations → Webhooks
FLOOM_HEARTBEAT_DISCORD_WEBHOOK=
# Target to ping. Override if you're watching prod instead of preview.
FLOOM_HEARTBEAT_TARGET=https://preview.floom.dev/api/health
EOF
sudo chmod 600 /etc/floom-heartbeat.env

# Drop the script.
sudo tee /usr/local/bin/floom-heartbeat.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
# See /etc/floom-heartbeat.env for config. Debounce: only alerts after
# two consecutive failures. Also alerts on recovery.
set -u
: "${FLOOM_HEARTBEAT_TARGET:=https://preview.floom.dev/api/health}"
# shellcheck source=/etc/floom-heartbeat.env
[ -r /etc/floom-heartbeat.env ] && . /etc/floom-heartbeat.env
STATE=/var/lib/floom-heartbeat.state
mkdir -p "$(dirname "$STATE")"
PREV=$(cat "$STATE" 2>/dev/null || echo 0)
HTTP=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$FLOOM_HEARTBEAT_TARGET" || echo 000)
post() {
  [ -z "${FLOOM_HEARTBEAT_DISCORD_WEBHOOK:-}" ] && return 0
  local msg="$1"
  curl -s -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"content\":\"$msg\"}" "$FLOOM_HEARTBEAT_DISCORD_WEBHOOK" >/dev/null || true
}
if [ "$HTTP" = "200" ]; then
  if [ "$PREV" -ge 2 ]; then
    post "Floom heartbeat recovered: $FLOOM_HEARTBEAT_TARGET is 200 again (was failing $PREV check(s))."
  fi
  echo 0 > "$STATE"
else
  NEW=$((PREV + 1))
  echo "$NEW" > "$STATE"
  if [ "$NEW" -eq 2 ]; then
    post "Floom heartbeat ALERT: $FLOOM_HEARTBEAT_TARGET returned $HTTP twice in a row. Check the box."
  fi
fi
EOF
sudo chmod +x /usr/local/bin/floom-heartbeat.sh

# Wire the cron.
sudo tee /etc/cron.d/floom-heartbeat >/dev/null <<'EOF'
# Floom external heartbeat — pings preview.floom.dev every minute, alerts on
# two consecutive failures and on recovery. Config: /etc/floom-heartbeat.env
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root /usr/local/bin/floom-heartbeat.sh
EOF
sudo chmod 644 /etc/cron.d/floom-heartbeat
```

### Create the Discord webhook

1. Open Discord → `Floom` server → `#floomit` channel → Edit Channel →
   Integrations → Webhooks → New Webhook.
2. Name it `floom-heartbeat`. Copy the Webhook URL.
3. Paste it into `/etc/floom-heartbeat.env` on the Hetzner VPS:

   ```bash
   ssh hetzner
   sudo sed -i "s|^FLOOM_HEARTBEAT_DISCORD_WEBHOOK=.*|FLOOM_HEARTBEAT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...|" /etc/floom-heartbeat.env
   ```

4. Dry-run it:

   ```bash
   sudo /usr/local/bin/floom-heartbeat.sh
   echo "state: $(sudo cat /var/lib/floom-heartbeat.state 2>/dev/null || echo missing)"
   ```

   Expected: exit 0, state file is `0` (since preview.floom.dev returns 200).

### Sentry → Discord alert rule

To pipe Sentry issues into the same Discord channel:

1. In Sentry: Project Settings → Alerts → Create Alert.
2. Trigger: "When a new issue is created" **OR** "When an issue changes
   state from resolved to unresolved" (regression).
3. Action: "Send a notification via Discord" → paste the same webhook URL.
4. Save. First uncaught exception will now ping `#floomit` → WhatsApp.

---

## 4. App-level Discord alerts

The Sentry → Discord rule in section 3 only fires on issues Sentry sees.
Some operational signals live outside Sentry: unhandled process rejections,
container-level 5xx bursts, and repeated-429 abuse from a single IP. Floom
ships a small `sendDiscordAlert()` helper that posts those directly to a
Discord webhook when `DISCORD_ALERTS_WEBHOOK_URL` is set.

What fires:

- **5xx unhandled errors** — every exception reaching Hono's top-level
  `onError` handler posts a rate-limited alert (1 / minute / error class).
- **unhandledRejection + uncaughtException** — process-level crashes that
  would otherwise just scroll past in `docker logs`.
- **Repeated 429s from one IP** — when the same IP trips 10+ rate-limits
  in 5 minutes, a single alert fires. That IP is then debounced for an hour
  so a sustained attack doesn't spam the channel.

Setup:

1. In your Discord server: Edit Channel on `#floom-alerts` (or a
   channel of your choice) → Integrations → Webhooks → New Webhook →
   copy URL.
2. Add to your deployment env:
   ```bash
   # /opt/floom-mcp-preview/.env
   DISCORD_ALERTS_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```
3. Restart the container (no rebuild — runtime env):
   ```bash
   cd /opt/floom-mcp-preview && docker compose up -d --no-deps floom-mcp-preview
   ```
4. Verify in boot logs — you should see `[discord-alerts] enabled`:
   ```bash
   docker logs floom-mcp-preview 2>&1 | grep discord-alerts
   ```
5. Smoke test — hit a route that throws:
   ```bash
   curl -X POST https://preview.floom.dev/api/run -H 'content-type: application/json' -d '{"invalid":true}'
   ```
   Expected: one Discord post within a few seconds.

When the env var is unset, the helper is a hard no-op — no attempted
posts, no log spam, no cost. This is the OSS default so nothing leaks
from a self-hosted box.

---

## 5. PostHog product analytics (frontend)

PostHog tracks the launch funnel so we can see which step of the
landing → publish → run chain is dropping visitors. It runs **only** in
the browser bundle, only after the user consents, and only for a closed
list of events (no autocapture, no session replay, no PII beyond the
Better Auth user id).

The tracked events (hard-coded in
[`apps/web/src/lib/posthog.ts`](../apps/web/src/lib/posthog.ts)):

| Event | Fires when |
|---|---|
| `landing_viewed` | Pageview on `/` |
| `publish_clicked` | "Publish your app" CTA tap |
| `publish_succeeded` | App was created (ingest returned 200) |
| `signup_completed` | Better Auth `/sign-up/email` returned 200 |
| `signin_completed` | Better Auth `/sign-in/email` returned 200 |
| `run_triggered` | User invoked an app |
| `run_succeeded` | Run finished 2xx |
| `run_failed` | Run finished non-2xx |
| `share_link_opened` | Someone landed on a `/r/:runId` permalink |

### Setup

1. Create a project at [posthog.com](https://posthog.com) (free tier:
   1M events/month). Prefer the EU cloud for data residency.
2. Copy the project API key.
3. Add to the **build-time** env (PostHog runs in the browser bundle,
   same build-time constraint as `VITE_SENTRY_DSN`):

   ```bash
   # /opt/floom-mcp-preview/.env
   VITE_POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxx
   VITE_POSTHOG_HOST=https://eu.i.posthog.com   # or us.i.posthog.com
   ```

4. Rebuild the image so Vite bakes the key into the bundle:

   ```bash
   docker build \
     --build-arg VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
     --build-arg VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
     -t floom-preview-local:$(date +%Y%m%d-%H%M)-posthog \
     -f docker/Dockerfile .
   ```

5. Verify — open the site in a fresh incognito window, accept all
   cookies in the banner, reload, check PostHog → Activity. A
   `landing_viewed` event should appear within seconds.

### Consent behaviour

`initPostHog()` is called unconditionally at boot but is a **hard no-op**
unless `getConsent() === 'all'` AND the key is set. On upgrade
("Essential only" → "Accept all") the banner calls `initPostHog()` inline
so the choice applies in the same session. On downgrade
("Accept all" → "Essential only") `closePostHog()` calls
`posthog.opt_out_capturing()` + `posthog.reset()` so future events are
dropped and the `distinct_id` is cleared. Events already in flight at
the network layer cannot be recalled — documented on `/cookies`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[sentry] initialized` missing from boot logs | `SENTRY_DSN` is not in the container env. Check the compose file and `.env`. |
| Server errors not appearing in Sentry | Check `docker logs floom-mcp-preview \| grep unhandled`. If errors are logged but not sent, the DSN is wrong. |
| Browser errors show minified stacks | Source maps not uploaded. Rebuild with `SENTRY_AUTH_TOKEN` set. |
| Browser errors not appearing in Sentry at all | `VITE_SENTRY_DSN` is build-time — confirm you rebuilt the image after setting it. |
| Heartbeat alerts never fire | `curl -X POST` the webhook by hand to confirm it works. Check `/var/log/syslog` for cron failures. |
| Heartbeat alerts keep firing on healthy target | Look at exit code of `curl -s -o /dev/null -w '%{http_code}' <target>` from the Hetzner box — cert or network issue. |
| `[discord-alerts] disabled` in boot logs | `DISCORD_ALERTS_WEBHOOK_URL` is missing or doesn't start with `https://discord.com/api/webhooks/`. Fix the env var, restart. |
| Discord alerts never fire despite `[discord-alerts] enabled` | The per-title debounce is 60s. Trigger a NEW error class, or wait a minute. If still nothing, `curl -X POST` the webhook by hand to verify it works. |
| PostHog events not appearing | Consent gate is the most common cause. Open DevTools → Application → Local Storage, confirm `floom.cookie-consent = all`. If `essential`, click "Cookie settings" in the footer and upgrade. If consent is `all` but still no events, `VITE_POSTHOG_KEY` likely wasn't set at build time — rebuild the image. |
| Frontend Sentry not capturing errors | Same consent gate applies. Confirm `floom.cookie-consent = all` in localStorage, then confirm `VITE_SENTRY_DSN` was set at build time (Network tab → search for requests to `*.ingest.sentry.io`). |
