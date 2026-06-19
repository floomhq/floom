#!/usr/bin/env bash
# Pre/post-deploy live-route smoke gate for a self-hosted Workeros install.
#
# Usage:
#   bash ops/smoke-routes.sh
#
# Override hosts when needed:
#   WORKEROS_SMOKE_WEB_BASE=https://workeros.example.com \
#   WORKEROS_SMOKE_API_BASE=https://api.workeros.example.com \
#   bash ops/smoke-routes.sh

set -uo pipefail

FAIL=0
WEB_BASE="${WORKEROS_SMOKE_WEB_BASE:-http://localhost:3000}"
API_BASE="${WORKEROS_SMOKE_API_BASE:-http://localhost:8000}"

ROUTES=(
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

check "api" "$API_BASE/healthz"
for route in "${ROUTES[@]}"; do
  check "web" "$WEB_BASE$route"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "SMOKE FAILED - do not promote this deploy."
  exit 1
fi

echo "SMOKE PASSED - all routes are non-508 and non-5xx."
