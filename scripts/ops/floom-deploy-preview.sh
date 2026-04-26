#!/usr/bin/env bash
# floom-deploy-preview.sh
# Auto-deploy on every push to main. Rolls ONLY the preview container
# (floom-preview-launch on :3052 -> preview.floom.dev). Prod (floom.dev,
# floom-mcp-preview on :3051) is deployed manually via
# floom-deploy-prod.sh triggered by workflow_dispatch. See
# scripts/ops/floom-deploy-prod.sh and .github/workflows/deploy-prod.yml.
#
# This file is the source of truth. The live copy lives at
# /usr/local/sbin/floom-deploy-preview.sh on AX41. See
# scripts/ops/README.md for how to update.
#
# Behavior (fail fast, idempotent, preview-only):
#   1. git fetch + reset --hard origin/main in a DEDICATED clone
#   2. docker build -> floom-preview-local:auto-<sha>
#      (the same tag is reused by floom-deploy-prod.sh when promoted)
#   3. Bump image tag in /opt/floom-preview-launch/docker-compose.yml
#   4. docker compose up -d --no-deps floom-preview-launch
#   5. Health-check http://127.0.0.1:3052/api/health for up to 60s
#   6. Run launch-apps-real-run-gate.sh against :3052 and assert each
#      launch app completes with dry_run=false and model!="dry-run"
#      under the API budget.
#   7. On failure: restore the preview compose backup and restart the
#      preview container only. NEVER touches the prod compose or container.
#
# Env var differences are preserved in the compose files themselves — the
# script ONLY swaps the image tag. In particular, preview keeps
# DEPLOY_ENABLED=true; prod keeps DEPLOY_ENABLED=false. This script does
# not see or edit env vars.
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
echo "=== preview deploy started $(date --iso-8601=seconds) ==="

REPO=/opt/floom-deploy-src
REMOTE_URL=https://github.com/floomhq/floom.git

# Preview (preview.floom.dev) — the only thing this script touches.
PREVIEW_COMPOSE_DIR=/opt/floom-preview-launch
PREVIEW_SERVICE=floom-preview-launch
PREVIEW_HEALTH_URL="http://127.0.0.1:3052/api/health"
PREVIEW_GATE_BASE_URL="http://127.0.0.1:3052"
GATE_SCRIPT="${REPO}/scripts/ops/launch-apps-real-run-gate.sh"

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

# Build the image. Prod reuses this tag when promoted. Sentry source-map
# upload is optional and only runs when SENTRY_AUTH_TOKEN is present in this
# script's environment; the Vite plugin keeps source maps local otherwise.
BUILD_ARGS=(--build-arg "COMMIT_SHA=${SHA}")
if [ -n "${VITE_SENTRY_WEB_DSN:-}" ]; then
  BUILD_ARGS+=(--build-arg "VITE_SENTRY_WEB_DSN=${VITE_SENTRY_WEB_DSN}")
fi
if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  BUILD_ARGS+=(--build-arg "SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}")
  BUILD_ARGS+=(--build-arg "SENTRY_ORG=${SENTRY_ORG:-floom}")
  BUILD_ARGS+=(--build-arg "SENTRY_PROJECT=${SENTRY_PROJECT:-floom-web}")
  echo "[sentry] source-map upload enabled project=${SENTRY_PROJECT:-floom-web}"
else
  echo "[sentry] source-map upload skipped: SENTRY_AUTH_TOKEN not set"
fi
docker build "${BUILD_ARGS[@]}" -t "$TAG" -f docker/Dockerfile .

TS=$(date +%s)
BACKUP="${PREVIEW_COMPOSE_DIR}/docker-compose.yml.bak.auto-${TS}"

cp "${PREVIEW_COMPOSE_DIR}/docker-compose.yml" "$BACKUP"
echo "[compose] backup=${BACKUP}"
sed -i -E "s|(^\s*image:\s*)floom-preview-local:.*|\1${TAG}|" \
    "${PREVIEW_COMPOSE_DIR}/docker-compose.yml"

if ! grep -q "image: ${TAG}" "${PREVIEW_COMPOSE_DIR}/docker-compose.yml"; then
  echo "[compose] FAILED to bump image tag in ${PREVIEW_COMPOSE_DIR}"
  cp "$BACKUP" "${PREVIEW_COMPOSE_DIR}/docker-compose.yml"
  exit 1
fi

# Roll preview only.
(cd "$PREVIEW_COMPOSE_DIR" && docker compose up -d --no-deps "$PREVIEW_SERVICE")

# Health-check preview only.
HEALTHY=0
for i in $(seq 1 12); do
  if curl -fsS "$PREVIEW_HEALTH_URL" > /dev/null 2>&1; then
    echo "[health] ok ${PREVIEW_HEALTH_URL} after $((i*5))s"
    HEALTHY=1
    break
  fi
  sleep 5
done

if [ "$HEALTHY" = "1" ] && "$GATE_SCRIPT" --base-url "$PREVIEW_GATE_BASE_URL"; then
  echo "=== preview deploy done $(date --iso-8601=seconds) sha=${SHA} ==="
  exit 0
fi

if [ "$HEALTHY" != "1" ]; then
  echo "[health] FAILED ${PREVIEW_HEALTH_URL} after 60s"
  echo "=== HEALTHCHECK FAILED, rolling back preview (prod untouched) ==="
else
  echo "[gate] FAILED launch-app real-run gate on ${PREVIEW_GATE_BASE_URL}"
  echo "=== POST-DEPLOY GATE FAILED, rolling back preview (prod untouched) ==="
fi
cp "$BACKUP" "${PREVIEW_COMPOSE_DIR}/docker-compose.yml"
(cd "$PREVIEW_COMPOSE_DIR" && docker compose up -d --no-deps "$PREVIEW_SERVICE") || true

# Confirm rollback health.
for i in $(seq 1 12); do
  if curl -fsS "$PREVIEW_HEALTH_URL" > /dev/null 2>&1; then
    echo "=== preview rollback ok after $((i*5))s ==="
    exit 1
  fi
  sleep 5
done

echo "=== preview rollback ALSO unhealthy — manual intervention needed ==="
exit 1
