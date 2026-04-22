#!/usr/bin/env bash
# floom-api.sh — thin wrapper around curl that reads base_url + token from
# ~/.claude/floom-skill-config.json and attaches the right auth header.
#
# Usage:
#   floom-api.sh GET  /api/health
#   floom-api.sh GET  /api/hub/mine
#   floom-api.sh POST /api/hub/ingest '{"openapi_url":"..."}'
#
# Env overrides (useful for CI / dry runs):
#   FLOOM_CONFIG          path to config json (default ~/.claude/floom-skill-config.json)
#   FLOOM_DRY_RUN=1       print the request instead of sending
#
# Exit codes:
#   0   success (HTTP 2xx)
#   1   missing config / bad args
#   2   non-2xx HTTP response (body is printed to stdout)

set -euo pipefail

CONFIG="${FLOOM_CONFIG:-$HOME/.claude/floom-skill-config.json}"
METHOD="${1:-}"
PATH_="${2:-}"
BODY="${3:-}"

if [[ -z "$METHOD" || -z "$PATH_" ]]; then
  echo "usage: floom-api.sh <METHOD> <PATH> [JSON_BODY]" >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "no floom config at $CONFIG" >&2
  echo "run /floom-init or /floom-deploy first — they'll prompt for your token" >&2
  exit 1
fi

BASE_URL=$(python3 -c "import json,sys; print(json.load(open('$CONFIG'))['base_url'])")
TOKEN=$(python3 -c "import json,sys; print(json.load(open('$CONFIG'))['token'])")
TOKEN_TYPE=$(python3 -c "import json,sys; print(json.load(open('$CONFIG')).get('token_type','bearer'))")

URL="${BASE_URL%/}${PATH_}"

# Pick auth header based on token type. Session cookies go as Cookie; bearer
# tokens / API keys / FLOOM_AUTH_TOKEN all go as Authorization: Bearer.
AUTH_ARGS=()
if [[ "$TOKEN_TYPE" == "session_cookie" ]]; then
  AUTH_ARGS+=("-H" "Cookie: better-auth.session_token=$TOKEN")
else
  AUTH_ARGS+=("-H" "Authorization: Bearer $TOKEN")
fi

if [[ "${FLOOM_DRY_RUN:-}" == "1" ]]; then
  echo "DRY RUN"
  echo "  $METHOD $URL"
  echo "  auth: $TOKEN_TYPE (redacted)"
  if [[ -n "$BODY" ]]; then
    echo "  body: $BODY"
  fi
  exit 0
fi

# Build curl invocation. -w prints the HTTP code on the last line so we can
# separate body + status without jq-ing every response.
RESP_FILE=$(mktemp)
trap 'rm -f "$RESP_FILE"' EXIT

if [[ -n "$BODY" ]]; then
  HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -X "$METHOD" "$URL" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    --data-raw "$BODY")
else
  HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -X "$METHOD" "$URL" \
    "${AUTH_ARGS[@]}")
fi

cat "$RESP_FILE"
echo

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  exit 0
fi

echo "HTTP $HTTP_CODE" >&2
exit 2
