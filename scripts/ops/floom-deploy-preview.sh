#!/usr/bin/env bash
# floom-deploy-preview.sh
# Auto-deploy on every push to main. Rolls BOTH the prod container
# (floom-mcp-preview on :3051) AND the preview container
# (floom-preview-launch on :3052). Invoked via forced-command SSH from
# the GitHub Actions runner.
#
# This file is the source of truth. The live copy lives at
# /usr/local/sbin/floom-deploy-preview.sh on AX41. See
# scripts/ops/README.md for how to update.
#
# Behavior (fail fast, idempotent, atomic across both containers):
#   1. git fetch + reset --hard origin/main in a DEDICATED clone
#   2. docker build -> floom-preview-local:auto-<sha>   (ONE image)
#   3. Bump image tag in /opt/floom-mcp-preview/docker-compose.yml (prod)
#   4. Bump image tag in /opt/floom-preview-launch/docker-compose.yml (preview)
#   5. docker compose up -d --no-deps for both services
#   6. Health check http://127.0.0.1:3051/api/health (prod) AND
#                  http://127.0.0.1:3052/api/health (preview), each up to 60s
#   7. On EITHER failure: restore BOTH compose backups + restart both
#      (the deploy is atomic: either both roll forward, or both roll back)
#
# Env var differences are preserved in the compose files themselves — the
# script ONLY swaps the image tag. In particular:
#   - prod    (:3051) keeps DEPLOY_ENABLED=false
#   - preview (:3052) keeps DEPLOY_ENABLED=true
#
# Why a dedicated clone: /root/floom is a shared worktree used by many
# concurrent agents on feature branches. `git reset --hard` there would
# destroy their work. This script uses /opt/floom-deploy-src/ which it
# owns exclusively.
#
# Log: /var/log/floom-deploy-preview.log

set -euo pipefail

LOG=/var/log/floom-deploy-preview.log
exec >> "$LOG" 2>&1

echo ""
echo "=== deploy started $(date --iso-8601=seconds) ==="

REPO=/opt/floom-deploy-src
REMOTE_URL=https://github.com/floomhq/floom.git

# Prod (floom.dev)
PROD_COMPOSE_DIR=/opt/floom-mcp-preview
PROD_SERVICE=floom-mcp-preview
PROD_HEALTH_URL="http://127.0.0.1:3051/api/health"

# Preview (preview.floom.dev)
PREVIEW_COMPOSE_DIR=/opt/floom-preview-launch
PREVIEW_SERVICE=floom-preview-launch
PREVIEW_HEALTH_URL="http://127.0.0.1:3052/api/health"

# Bootstrap clone on first run
if [ ! -d "$REPO/.git" ]; then
  echo "[bootstrap] cloning ${REMOTE_URL} into ${REPO}"
  mkdir -p "$(dirname "$REPO")"
  git clone --depth 1 "$REMOTE_URL" "$REPO"
fi

cd "$REPO"
git fetch --depth 1 origin main
git reset --hard origin/main
git clean -fdx  # Wipe node_modules etc. so Docker build context is clean.
SHA=$(git rev-parse --short HEAD)
TAG="floom-preview-local:auto-${SHA}"
echo "[build] sha=${SHA} tag=${TAG}"

# Build ONE image — both containers run the same bits.
# Dockerfile lives at docker/Dockerfile, not the repo root.
docker build -t "$TAG" -f docker/Dockerfile .

# Shared timestamp for matching backups across both composes. Makes the
# rollback pair unambiguous even if the script is re-run quickly.
TS=$(date +%s)

# -----------------------------------------------------------------------
# Helper: bump image tag in the compose file at $1, backup to .bak.auto-$TS
# Exits non-zero if the sed didn't actually produce the target tag.
# -----------------------------------------------------------------------
bump_compose() {
  local dir="$1"
  local backup="${dir}/docker-compose.yml.bak.auto-${TS}"
  cp "${dir}/docker-compose.yml" "$backup"
  echo "[compose] backup=${backup}"

  # Replace the image: line for the floom-preview-local:* tag.
  # Both compose files use floom-preview-local:<something>; there is only
  # one such line in each file. No yq dependency needed.
  sed -i -E "s|(^\s*image:\s*)floom-preview-local:.*|\1${TAG}|" "${dir}/docker-compose.yml"

  if ! grep -q "image: ${TAG}" "${dir}/docker-compose.yml"; then
    echo "[compose] FAILED to bump image tag in ${dir}"
    return 1
  fi
}

# Helper: roll a compose service (up -d --no-deps against $dir / $service)
roll_compose() {
  local dir="$1"
  local service="$2"
  (cd "$dir" && docker compose up -d --no-deps "$service")
}

# Helper: health-check $1 for up to 60s. Returns 0 on first success.
wait_healthy() {
  local url="$1"
  local i
  for i in $(seq 1 12); do
    if curl -fsS "$url" > /dev/null 2>&1; then
      echo "[health] ok ${url} after $((i*5))s"
      return 0
    fi
    sleep 5
  done
  echo "[health] FAILED ${url} after 60s"
  return 1
}

# Helper: restore a compose file from its THIS-RUN backup and roll the service.
restore_compose() {
  local dir="$1"
  local service="$2"
  local backup="${dir}/docker-compose.yml.bak.auto-${TS}"
  if [ -f "$backup" ]; then
    echo "[rollback] restoring ${backup}"
    cp "$backup" "${dir}/docker-compose.yml"
    roll_compose "$dir" "$service" || true
  else
    echo "[rollback] NO backup at ${backup} — manual intervention needed for ${service}"
  fi
}

# -----------------------------------------------------------------------
# Roll forward: bump tags in both composes, then up both.
# -----------------------------------------------------------------------
bump_compose "$PROD_COMPOSE_DIR"
bump_compose "$PREVIEW_COMPOSE_DIR"

roll_compose "$PROD_COMPOSE_DIR"    "$PROD_SERVICE"
roll_compose "$PREVIEW_COMPOSE_DIR" "$PREVIEW_SERVICE"

# -----------------------------------------------------------------------
# Health-check both. If EITHER fails, roll BOTH back (atomic).
# -----------------------------------------------------------------------
PROD_OK=0
PREVIEW_OK=0
wait_healthy "$PROD_HEALTH_URL"    && PROD_OK=1
wait_healthy "$PREVIEW_HEALTH_URL" && PREVIEW_OK=1

if [ "$PROD_OK" = "1" ] && [ "$PREVIEW_OK" = "1" ]; then
  echo "=== deploy done $(date --iso-8601=seconds) sha=${SHA} (prod + preview) ==="
  exit 0
fi

echo "=== HEALTHCHECK FAILED (prod=${PROD_OK} preview=${PREVIEW_OK}), rolling back BOTH ==="
restore_compose "$PROD_COMPOSE_DIR"    "$PROD_SERVICE"
restore_compose "$PREVIEW_COMPOSE_DIR" "$PREVIEW_SERVICE"

# Re-check health after rollback so the log is unambiguous about end state.
PROD_BACK=0
PREVIEW_BACK=0
wait_healthy "$PROD_HEALTH_URL"    && PROD_BACK=1
wait_healthy "$PREVIEW_HEALTH_URL" && PREVIEW_BACK=1

if [ "$PROD_BACK" = "1" ] && [ "$PREVIEW_BACK" = "1" ]; then
  echo "=== rollback ok — both containers back on previous image ==="
else
  echo "=== rollback ALSO unhealthy (prod=${PROD_BACK} preview=${PREVIEW_BACK}) — manual intervention needed ==="
fi
exit 1
