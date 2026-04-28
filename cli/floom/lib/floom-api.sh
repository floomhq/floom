#!/usr/bin/env bash
# floom-api.sh — thin wrapper around curl that resolves api_url + Agent token and
# attaches the auth header. Used by the floom CLI subcommands.
#
# Auth resolution order:
#   1. FLOOM_API_KEY env var (+ FLOOM_API_URL env var, default https://floom.dev)
#   2. ~/.floom/config.json with an Agent token and api_url
#   3. Legacy ~/.claude/floom-skill-config.json with {"base_url", "token", "token_type"}
#
# Usage:
#   floom-api.sh GET  /api/health
#   floom-api.sh GET  /api/hub/mine
#   floom-api.sh POST /api/hub/ingest '{"openapi_url":"..."}'
#
# Env overrides:
#   FLOOM_API_KEY         Agent token (overrides config file)
#   FLOOM_API_URL         base URL (overrides config file, default https://floom.dev)
#   FLOOM_CONFIG          path to config json (default ~/.floom/config.json)
#   FLOOM_DRY_RUN=1       print the request instead of sending
#
# Exit codes:
#   0   success (HTTP 2xx)
#   1   missing config / bad args
#   2   non-2xx HTTP response (body printed to stdout)

set -euo pipefail

METHOD="${1:-}"
PATH_="${2:-}"
BODY="${3:-}"

if [[ -z "$METHOD" || -z "$PATH_" ]]; then
  echo "usage: floom-api.sh <METHOD> <PATH> [JSON_BODY]" >&2
  exit 1
fi

CONFIG="${FLOOM_CONFIG:-$HOME/.floom/config.json}"
LEGACY_CONFIG="$HOME/.claude/floom-skill-config.json"
API_URL="${FLOOM_API_URL:-https://floom.dev}"

# Dry-run: print request details and exit 0 without requiring auth.
if [[ "${FLOOM_DRY_RUN:-}" == "1" ]]; then
  echo "DRY RUN"
  echo "  $METHOD ${API_URL%/}${PATH_}"
  echo "  auth: (skipped in dry-run)"
  if [[ -n "$BODY" ]]; then
    echo "  body: $BODY"
  fi
  exit 0
fi

API_KEY=""
TOKEN_TYPE="bearer"

# 1. env var wins
if [[ -n "${FLOOM_API_KEY:-}" ]]; then
  API_KEY="$FLOOM_API_KEY"
fi

# 2. new config file
if [[ -z "$API_KEY" && -f "$CONFIG" ]]; then
  API_KEY=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c.get('api_key',''))")
  API_URL=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c.get('api_url','https://floom.dev'))")
fi

# 3. legacy fallback (pre-CLI Claude Code skill config)
if [[ -z "$API_KEY" && -f "$LEGACY_CONFIG" ]]; then
  API_KEY=$(python3 -c "import json; c=json.load(open('$LEGACY_CONFIG')); print(c.get('token',''))")
  API_URL=$(python3 -c "import json; c=json.load(open('$LEGACY_CONFIG')); print(c.get('base_url','https://floom.dev'))")
  TOKEN_TYPE=$(python3 -c "import json; c=json.load(open('$LEGACY_CONFIG')); print(c.get('token_type','bearer'))")
fi

if [[ -z "$API_KEY" ]]; then
  cat >&2 <<EOF
floom: not authenticated.

Create an Agent token in Workspace settings:

  https://floom.dev/settings/agent-tokens

Then run:

  floom auth floom_agent_...

Or set FLOOM_API_KEY to an Agent token directly.
EOF
  exit 1
fi

[[ -z "$API_URL" ]] && API_URL="https://floom.dev"

URL="${API_URL%/}${PATH_}"

# Pick auth header. Default: Authorization: Bearer. Legacy session_cookie
# users get a Cookie header so old configs keep working.
AUTH_ARGS=()
if [[ "$TOKEN_TYPE" == "session_cookie" ]]; then
  AUTH_ARGS+=("-H" "Cookie: better-auth.session_token=$API_KEY")
else
  AUTH_ARGS+=("-H" "Authorization: Bearer $API_KEY")
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
