#!/usr/bin/env bash
# floom-deploy-prod.sh
# Manual deploy of prod (floom.dev). Rolls ONLY the prod container
# (floom-mcp-preview on :3051). Preview (:3052 -> preview.floom.dev) is
# left untouched — it continues to track whatever main has most recently
# shipped to it via floom-deploy-preview.sh.
#
# This is triggered manually by workflow_dispatch on the Deploy prod
# workflow after a change has been visually verified on
# preview.floom.dev. See .github/workflows/deploy-prod.yml.
#
# Input
#   $1 (IMAGE_TAG, optional): the docker tag to deploy, e.g.
#                             floom-preview-local:auto-abc1234
#     Default: the tag currently live on preview
#     (/opt/floom-preview-launch/docker-compose.yml).
#     This default makes the common flow — "promote what I reviewed on
#     preview to prod" — a single-click workflow_dispatch with no input.
#
# Behavior (fail fast, idempotent, prod-only):
#   1. Resolve IMAGE_TAG (arg > current preview tag).
#   2. Verify the image exists locally. If not, fail — the image is built
#      by floom-deploy-preview.sh and kept in the local docker registry.
#      Prod does not build; it promotes.
#   3. Bump image tag in /opt/floom-mcp-preview/docker-compose.yml,
#      backup to .bak.prod-<ts>.
#   4. docker compose up -d --no-deps floom-mcp-preview
#   5. Health-check http://127.0.0.1:3051/api/health for up to 60s
#   6. Run launch-apps-real-run-gate.sh against :3051 and assert each
#      launch app completes with dry_run=false and model!="dry-run"
#      under the API budget.
#   7. On failure: restore the prod compose backup and restart the prod
#      container only. NEVER touches the preview compose or container.
#
# Env var differences are preserved in the compose file itself. In
# particular, prod keeps DEPLOY_ENABLED=false. This script only rewrites
# the image tag.
#
# Log: /var/log/floom-deploy-prod.log

set -euo pipefail

LOG=/var/log/floom-deploy-prod.log
exec >> "$LOG" 2>&1

echo ""
echo "=== prod deploy started $(date --iso-8601=seconds) ==="

# Prod (floom.dev) — the only thing this script touches.
PROD_COMPOSE_DIR=/opt/floom-mcp-preview
PROD_SERVICE=floom-mcp-preview
PROD_HEALTH_URL="http://127.0.0.1:3051/api/health"
PROD_GATE_BASE_URL="http://127.0.0.1:3051"
GATE_SCRIPT="${REPO}/scripts/ops/launch-apps-real-run-gate.sh"

# Preview compose — READ-ONLY, used only to pick a default image tag.
PREVIEW_COMPOSE="/opt/floom-preview-launch/docker-compose.yml"

# Resolve the image tag. The argument is sanitised because this script
# is invoked via an SSH forced-command where the authorized_keys entry
# passes through the client-supplied string. We therefore:
#   - accept an empty arg (default: current preview tag)
#   - otherwise require [a-zA-Z0-9:._-]+ and reject everything else
#   - after the regex check, normalise bare shas and auto-<sha> forms to
#     the full floom-preview-local:auto-<sha> tag
raw="${1:-}"

# Strip newlines and spaces that may have snuck in via SSH_ORIGINAL_COMMAND.
raw=$(printf '%s' "$raw" | tr -d '\r\n' | awk '{$1=$1; print}')

if [ -n "$raw" ] && ! printf '%s' "$raw" | grep -Eq '^[A-Za-z0-9:._-]+$'; then
  echo "[resolve] REJECTED unsafe image tag arg: '${raw}'"
  exit 1
fi

resolve_tag() {
  local r="${1:-}"
  if [ -z "$r" ]; then
    # Default: whatever preview is currently running.
    local from_preview
    from_preview=$(grep -E "^\s*image:\s*floom-preview-local:" "$PREVIEW_COMPOSE" \
                   | sed -E "s/^\s*image:\s*//" | head -n1)
    if [ -z "$from_preview" ]; then
      echo "[resolve] FAILED: no floom-preview-local image in ${PREVIEW_COMPOSE}"
      exit 1
    fi
    printf '%s' "$from_preview"
    return 0
  fi

  case "$r" in
    floom-preview-local:*) printf '%s' "$r" ;;
    auto-*)                printf 'floom-preview-local:%s' "$r" ;;
    *)                     printf 'floom-preview-local:auto-%s' "$r" ;;
  esac
}

TAG=$(resolve_tag "$raw")
echo "[resolve] IMAGE_TAG=${TAG}"
echo "[sentry] prod promotes this prebuilt image; source maps are uploaded during the preview build for the same tag when SENTRY_AUTH_TOKEN is configured"

if ! docker image inspect "$TAG" > /dev/null 2>&1; then
  echo "[image] FAILED: ${TAG} not found in local docker registry."
  echo "[image] floom-deploy-prod.sh does NOT build. The image is built"
  echo "[image] by floom-deploy-preview.sh on every main push. Run a"
  echo "[image] preview deploy first, or pass an existing tag."
  docker image ls --filter "reference=floom-preview-local" | head -20 || true
  exit 1
fi

# =====================================================
# === DEPLOYING TO PROD (floom.dev) ===================
# =====================================================
echo "=== DEPLOYING TO PROD (floom.dev) ==="
echo "=== image tag: ${TAG} ==="
echo "=== compose:   ${PROD_COMPOSE_DIR}/docker-compose.yml ==="
echo "=== service:   ${PROD_SERVICE} ==="
echo "=== health:    ${PROD_HEALTH_URL} ==="

TS=$(date +%s)
BACKUP="${PROD_COMPOSE_DIR}/docker-compose.yml.bak.prod-${TS}"

cp "${PROD_COMPOSE_DIR}/docker-compose.yml" "$BACKUP"
echo "[compose] backup=${BACKUP}"
sed -i -E "s|(^\s*image:\s*)floom-preview-local:.*|\1${TAG}|" \
    "${PROD_COMPOSE_DIR}/docker-compose.yml"

if ! grep -q "image: ${TAG}" "${PROD_COMPOSE_DIR}/docker-compose.yml"; then
  echo "[compose] FAILED to bump image tag in ${PROD_COMPOSE_DIR}"
  cp "$BACKUP" "${PROD_COMPOSE_DIR}/docker-compose.yml"
  exit 1
fi

# Roll prod only.
(cd "$PROD_COMPOSE_DIR" && docker compose up -d --no-deps "$PROD_SERVICE")

# Health-check prod only.
HEALTHY=0
for i in $(seq 1 12); do
  if curl -fsS "$PROD_HEALTH_URL" > /dev/null 2>&1; then
    echo "[health] ok ${PROD_HEALTH_URL} after $((i*5))s"
    HEALTHY=1
    break
  fi
  sleep 5
done

if [ "$HEALTHY" = "1" ] && "$GATE_SCRIPT" --base-url "$PROD_GATE_BASE_URL"; then
  echo "=== prod deploy done $(date --iso-8601=seconds) tag=${TAG} ==="
  exit 0
fi

if [ "$HEALTHY" != "1" ]; then
  echo "[health] FAILED ${PROD_HEALTH_URL} after 60s"
  echo "=== HEALTHCHECK FAILED, rolling back prod (preview untouched) ==="
else
  echo "[gate] FAILED launch-app real-run gate on ${PROD_GATE_BASE_URL}"
  echo "=== POST-DEPLOY GATE FAILED, rolling back prod (preview untouched) ==="
fi
cp "$BACKUP" "${PROD_COMPOSE_DIR}/docker-compose.yml"
(cd "$PROD_COMPOSE_DIR" && docker compose up -d --no-deps "$PROD_SERVICE") || true

# Confirm rollback health.
for i in $(seq 1 12); do
  if curl -fsS "$PROD_HEALTH_URL" > /dev/null 2>&1; then
    echo "=== prod rollback ok after $((i*5))s ==="
    exit 1
  fi
  sleep 5
done

echo "=== prod rollback ALSO unhealthy — manual intervention needed ==="
exit 1
