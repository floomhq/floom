#!/usr/bin/env bash
# Pre/post-deploy live-route smoke gate.
# Compensating control for GitHub Actions being disabled or blocked.
# Fetches critical OS and Cloud routes and fails on any 4xx, 5xx, 508, or fetch failure.
#
# Usage:
#   bash ops/smoke-routes.sh          # check both OS and Cloud
#   bash ops/smoke-routes.sh cloud    # Cloud only
#   bash ops/smoke-routes.sh dashboard # Cloud dashboard /app only
#   bash ops/smoke-routes.sh os       # OS only
#
# Run this after every production deploy and before relying on a production alias.

set -uo pipefail

TARGET="${1:-all}"
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTTP_CLIENT="${SMOKE_HTTP_CLIENT:-curl}"

# Portable SHA-256 of a file. GNU coreutils ships `sha256sum`; macOS/BSD ship
# `shasum`. Without this fallback, `sha256sum` is missing on macOS, `hash` comes
# back empty, and the chunkset comparison silently matches empty-vs-empty —
# a false pass (workeros-cloud#662).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 127
  fi
}

OS_HOST="https://workers.floom.dev"
OS_API="https://workers-api.floom.dev"
CLOUD_HOST="https://workeros.floom.dev"
CLOUD_LANDING_HOST="https://floom.dev"
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
  "/login"
  "/start/slack"
  "/start/whatsapp"
  "/start/mcp"
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

CLOUD_LANDING_ROUTES=(
  "/"
  "/login"
  "/start/slack"
  "/start/whatsapp"
  "/start/mcp"
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
  if [[ "$HTTP_CLIENT" == "python" ]]; then
    code="$(python3 "$SCRIPT_DIR/http-client.py" status --url "$url" --timeout 20 2>/dev/null || echo "000")"
  else
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo "000")"
  fi
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

  if [[ "$HTTP_CLIENT" == "python" ]]; then
    python3 "$SCRIPT_DIR/http-client.py" fetch --url "$url" --output "$body" --timeout 30
  else
    curl -sSL --max-time 30 "$url" -o "$body"
  fi
  if [[ "$?" -ne 0 ]]; then
    echo "FAIL  $label  $url  -> fetch failed" >&2
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

  if ! hash="$(sha256_of "$assets")" || [[ -z "$hash" ]]; then
    echo "FAIL  $label  $url  -> no sha256 tool (need sha256sum or shasum)" >&2
    rm -rf "$tmp"
    return 1
  fi
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
  all|cloud|dashboard|os) ;;
  *)
    echo "Usage: bash ops/smoke-routes.sh [all|cloud|dashboard|os]" >&2
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
  for route in "${CLOUD_LANDING_ROUTES[@]}"; do
    check "cloud-landing" "$CLOUD_LANDING_HOST$route"
  done
  check_cloud_dashboard_chunkset
fi

if [[ "$TARGET" == "dashboard" ]]; then
  echo "== Cloud dashboard =="
  check "cloud-api" "$CLOUD_API/healthz"
  for app_host in "${CLOUD_APP_HOSTS[@]}"; do
    for route in "${CLOUD_ROUTES[@]}"; do
      [[ "$route" == /app* ]] || continue
      check "cloud-app" "${app_host%/}$route"
    done
  done
  check_cloud_dashboard_chunkset
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "SMOKE FAILED - do not promote this deploy."
  exit 1
fi

echo "SMOKE PASSED - all routes are non-508 and non-5xx."
