#!/usr/bin/env bash
# floom-deploy.sh — validate floom.yaml and publish the app.
#
# Flags:
#   --dry-run    set FLOOM_DRY_RUN=1 before calling the API (prints request, no send)
#
# Requires: floom.yaml in cwd, valid API key.

set -euo pipefail

_SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
LIB_DIR="$(cd "$(dirname "$_SCRIPT_PATH")" && pwd)"
CONFIG="${FLOOM_CONFIG:-$HOME/.floom/config.json}"
DEFAULT_HOST_FILE="${HOME}/.floom/default-host"

resolve_api_url() {
  if [[ -n "${FLOOM_API_URL:-}" ]]; then
    echo "$FLOOM_API_URL"
  elif [[ -f "$CONFIG" ]]; then
    CONFIG_PATH="$CONFIG" python3 - <<'PY'
import json
import os

try:
    c = json.load(open(os.environ["CONFIG_PATH"]))
    print(c.get("api_url") or "https://floom.dev")
except Exception:
    print("https://floom.dev")
PY
  elif [[ -f "$DEFAULT_HOST_FILE" ]]; then
    cat "$DEFAULT_HOST_FILE"
  else
    echo "https://floom.dev"
  fi
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "floom deploy: unknown flag: $1" >&2
      exit 1 ;;
  esac
done

if [[ ! -f floom.yaml ]]; then
  echo "floom deploy: no floom.yaml in $(pwd). Run 'floom init' first." >&2
  exit 1
fi

bash "$LIB_DIR/floom-validate.sh" floom.yaml

# Read fields out of floom.yaml. Prefer yq when present; fall back to python3.
read_field() {
  local field="$1"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".$field // \"\"" floom.yaml
  else
    python3 -c "
import sys
try:
    import yaml
except ImportError:
    print('floom deploy: need yq or PyYAML (pip install pyyaml)', file=sys.stderr)
    sys.exit(1)
m = yaml.safe_load(open('floom.yaml'))
v = m.get('$field', '')
print(v if v is not None else '')
"
  fi
}

SLUG=$(read_field slug)
NAME=$(read_field name)
DESC=$(read_field description)
SPEC=$(read_field openapi_spec_url)
VIS=$(read_field visibility)
RETENTION_DAYS=$(read_field max_run_retention_days)
[[ -z "$VIS" ]] && VIS="private"
LINK_SHARE_REQUIRES_AUTH=$(read_field link_share_requires_auth)
AUTH_REQUIRED=$(read_field auth_required)

if [[ -n "$SPEC" ]]; then
  BODY=$(python3 -c "
import json
body = {
    'openapi_url': '$SPEC',
    'slug': '$SLUG',
    'name': '$NAME',
    'description': '$DESC',
    'visibility': '$VIS',
    **({'link_share_requires_auth': True} if '$LINK_SHARE_REQUIRES_AUTH'.lower() == 'true' else {}),
    **({'auth_required': True} if '$AUTH_REQUIRED'.lower() == 'true' else {}),
}
retention = '$RETENTION_DAYS'
if retention:
    body['max_run_retention_days'] = int(retention)
print(json.dumps(body))")

  if [[ "$DRY_RUN" == "1" ]]; then
    export FLOOM_DRY_RUN=1
  fi

  RESPONSE=$(bash "$LIB_DIR/floom-api.sh" POST /api/hub/ingest "$BODY")
  printf '%s\n' "$RESPONSE"

  if [[ "$DRY_RUN" != "1" ]]; then
    API_URL="$(resolve_api_url)"
    DEPLOYED_SLUG=$(printf '%s' "$RESPONSE" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('slug') or '$SLUG')
except Exception:
    print('$SLUG')
")
    DEPLOYED_NAME=$(printf '%s' "$RESPONSE" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('name') or '$NAME')
except Exception:
    print('$NAME')
")
    cat <<EOF

Published: $DEPLOYED_NAME
  App page:    ${API_URL%/}/p/$DEPLOYED_SLUG
  MCP URL:     ${API_URL%/}/mcp/app/$DEPLOYED_SLUG
  Owner view:  ${API_URL%/}/studio/$DEPLOYED_SLUG

Add to Claude Desktop config:
  {"mcpServers":{"floom-$DEPLOYED_SLUG":{"url":"${API_URL%/}/mcp/app/$DEPLOYED_SLUG"}}}
EOF
  fi
else
  cat <<EOF
floom deploy: custom Python/Node apps can't be published via HTTP yet. Options:
  1. Open a PR against floomhq/floom with your dir under examples/$SLUG/.
  2. Wrap your code in a thin HTTP server, publish an OpenAPI spec, then re-run 'floom deploy'.
EOF
  exit 1
fi
