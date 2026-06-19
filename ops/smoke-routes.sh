#!/usr/bin/env bash
# Pre/post-deploy live-route smoke gate.
# Compensating control for GitHub Actions being disabled or blocked.
# Curls critical OS and Cloud routes and fails on any 508, 5xx, or curl failure.
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

OS_HOST="https://localhost:3000"
OS_API="https://localhost:8000"
CLOUD_HOST="https://app.example.com"
CLOUD_API="https://api.example.com"

# Unauthenticated routes that must never return 508/5xx.
# Authenticated pages can return 200, 3xx, or 4xx; route loops and server errors fail.
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
  elif [[ "$code" =~ ^5[0-9][0-9]$ || "$code" == "000" ]]; then
    echo "FAIL  $label  $url  -> $code"
    FAIL=1
  else
    echo "ok    $label  $url  -> $code"
  fi
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
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "SMOKE FAILED - do not promote this deploy."
  exit 1
fi

echo "SMOKE PASSED - all routes are non-508 and non-5xx."
