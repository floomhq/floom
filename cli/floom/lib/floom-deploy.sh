#!/usr/bin/env bash
# floom-deploy.sh — validate floom.yaml and publish the app.
#
# Flags:
#   --dry-run    set FLOOM_DRY_RUN=1 before calling the API (prints request, no send)
#
# Requires: floom.yaml in cwd, valid API key.

set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
[[ -z "$VIS" ]] && VIS="private"

if [[ -n "$SPEC" ]]; then
  BODY=$(python3 -c "
import json
print(json.dumps({
    'openapi_url': '$SPEC',
    'slug': '$SLUG',
    'name': '$NAME',
    'description': '$DESC',
    'visibility': '$VIS',
}))")

  if [[ "$DRY_RUN" == "1" ]]; then
    export FLOOM_DRY_RUN=1
  fi

  bash "$LIB_DIR/floom-api.sh" POST /api/hub/ingest "$BODY"

  if [[ "$DRY_RUN" != "1" ]]; then
    cat <<EOF

Published: $NAME
  App page:    https://floom.dev/p/$SLUG
  MCP URL:     https://floom.dev/mcp/app/$SLUG
  Owner view:  https://floom.dev/me/apps/$SLUG

Add to Claude Desktop config:
  {"mcpServers":{"floom-$SLUG":{"command":"npx","args":["-y","mcp-remote","https://floom.dev/mcp/app/$SLUG"]}}}
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
