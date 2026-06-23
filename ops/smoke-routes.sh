#!/usr/bin/env bash
# Pre/post-deploy live-route smoke gate.
# Compensating control for GitHub Actions being disabled or blocked.
# Curls critical OS and Cloud routes and fails on any 4xx, 5xx, 508, or curl failure.
#
# Usage:
#   bash ops/smoke-routes.sh          # check both OS and Cloud
#   bash ops/smoke-routes.sh cloud    # Cloud only
#   bash ops/smoke-routes.sh os       # OS only
#
# Run this after every production deploy and before relying on a production alias.

set -uo pipefail

TARGET="${1:-all}"
FAIL=0

OS_HOST="https://workers.floom.dev"
OS_API="https://workers-api.floom.dev"
CLOUD_HOST="https://workeros.floom.dev"
CLOUD_API="https://workeros-api.floom.dev"
CLOUD_DASHBOARD_HOST="${CLOUD_DASHBOARD_HOST:-https://r9-detail.floom.dev}"
CLOUD_APP_HOSTS=(
  "https://floom.dev"
  "$CLOUD_HOST"
)

# Routes that must not return client or server errors. Auth redirects are 3xx;
# any 4xx/5xx means the deploy is not promotable.
CLOUD_ROUTES=(
  "/"
  "/app"
  "/app/login"
  "/app/overview"
  "/app/workers"
  "/app/runs"
  "/app/connections"
  "/app/assistant"
  "/app/workers/granola-hubspot-meeting-actions"
  "/app/runs/run_8290101e249b"
)

OS_ROUTES=(
  "/"
  "/workers"
  "/runs"
  "/connections"
  "/assistant"
)

check() {
  local label="$1" url="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo "000")"
  if [[ "$code" == "508" ]]; then
    echo "FAIL  $label  $url  -> $code (INFINITE_LOOP)"
    FAIL=1
  elif [[ "$code" =~ ^[45][0-9][0-9]$ || "$code" == "000" ]]; then
    echo "FAIL  $label  $url  -> $code"
    FAIL=1
  else
    echo "ok    $label  $url  -> $code"
  fi
}

chunkset_hash() {
  local label="$1" url="$2" tmp body assets count hash
  tmp="$(mktemp -d)"
  body="$tmp/body.html"
  assets="$tmp/assets.txt"

  if ! curl -sSL --max-time 30 "$url" -o "$body"; then
    echo "FAIL  $label  $url  -> curl failed" >&2
    rm -rf "$tmp"
    return 1
  fi

  grep -Eo '(/app)?/_next/static/[^"<>[:space:]]+' "$body" \
    | sed -E 's#^/app##; s#[\\]+$##; s#[?].*$##' \
    | sort -u > "$assets" || true

  count="$(wc -l < "$assets" | tr -d ' ')"
  if [[ "$count" -eq 0 ]]; then
    echo "FAIL  $label  $url  -> no Next static chunks found" >&2
    rm -rf "$tmp"
    return 1
  fi

  hash="$(sha256sum "$assets" | awk '{print $1}')"
  echo "$hash $count"
  rm -rf "$tmp"
}

check_cloud_dashboard_chunkset() {
  local dashboard result dashboard_hash dashboard_count app_host app_result app_hash app_count

  dashboard="${CLOUD_DASHBOARD_HOST%/}/app/login"
  if ! result="$(chunkset_hash "dashboard-chunkset" "$dashboard")"; then
    FAIL=1
    return
  fi
  dashboard_hash="${result%% *}"
  dashboard_count="${result##* }"
  echo "ok    dashboard-chunkset  $dashboard  -> $dashboard_hash ($dashboard_count assets)"

  for app_host in "${CLOUD_APP_HOSTS[@]}"; do
    if ! app_result="$(chunkset_hash "cloud-app-chunkset" "${app_host%/}/app/login")"; then
      FAIL=1
      continue
    fi
    app_hash="${app_result%% *}"
    app_count="${app_result##* }"
    if [[ "$app_hash" == "$dashboard_hash" ]]; then
      echo "ok    cloud-app-chunkset  ${app_host%/}/app/login  -> $app_hash ($app_count assets)"
    else
      echo "FAIL  cloud-app-chunkset  ${app_host%/}/app/login  -> $app_hash ($app_count assets), expected $dashboard_hash"
      FAIL=1
    fi
  done
}

case "$TARGET" in
  all|cloud|os) ;;
  *)
    echo "Usage: bash ops/smoke-routes.sh [all|cloud|os]" >&2
    exit 2
    ;;
esac

if [[ "$TARGET" == "all" || "$TARGET" == "os" ]]; then
  echo "== OS =="
  check "os-api" "$OS_API/healthz"
  for route in "${OS_ROUTES[@]}"; do
    check "os" "$OS_HOST$route"
  done
fi

if [[ "$TARGET" == "all" || "$TARGET" == "cloud" ]]; then
  echo "== Cloud =="
  check "cloud-api" "$CLOUD_API/healthz"
  for route in "${CLOUD_ROUTES[@]}"; do
    check "cloud" "$CLOUD_HOST$route"
  done
  check_cloud_dashboard_chunkset
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "SMOKE FAILED - do not promote this deploy."
  exit 1
fi

echo "SMOKE PASSED - all routes are non-508 and non-5xx."
