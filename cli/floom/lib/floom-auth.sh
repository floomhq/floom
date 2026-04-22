#!/usr/bin/env bash
# floom-auth.sh — save an API key to ~/.floom/config.json.
#
# Usage:
#   floom auth <api-key>            save key (api_url defaults to https://floom.dev)
#   floom auth <api-key> <api-url>  save key + custom URL (for self-host)
#   floom auth --show               print redacted current config
#   floom auth --clear              delete config file

set -euo pipefail

CONFIG="${FLOOM_CONFIG:-$HOME/.floom/config.json}"

case "${1:-}" in
  --show)
    if [[ ! -f "$CONFIG" ]]; then
      echo "no config at $CONFIG"
      exit 1
    fi
    python3 -c "
import json
c = json.load(open('$CONFIG'))
key = c.get('api_key','')
red = key[:4] + '...' + key[-4:] if len(key) > 8 else '***'
print(f\"api_url: {c.get('api_url','https://floom.dev')}\")
print(f\"api_key: {red}\")
"
    exit 0 ;;
  --clear)
    rm -f "$CONFIG"
    echo "cleared $CONFIG"
    exit 0 ;;
  -h|--help|"")
    cat <<EOF
floom auth — save API key.

usage:
  floom auth <api-key>            save key (defaults to https://floom.dev)
  floom auth <api-key> <api-url>  save key + custom URL (self-host)
  floom auth --show               print redacted config
  floom auth --clear              delete config

Get your key at: https://floom.dev/me/settings/tokens
EOF
    [[ "${1:-}" == "" ]] && exit 1
    exit 0 ;;
esac

API_KEY="$1"
API_URL="${2:-https://floom.dev}"

mkdir -p "$(dirname "$CONFIG")"
python3 -c "
import json
json.dump({'api_key': '$API_KEY', 'api_url': '$API_URL'}, open('$CONFIG', 'w'))
"
chmod 600 "$CONFIG"
echo "saved $CONFIG (api_url: $API_URL)"
