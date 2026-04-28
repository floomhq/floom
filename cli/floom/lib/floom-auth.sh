#!/usr/bin/env bash
# floom-auth.sh — save an Agent token to ~/.floom/config.json.
#
# Usage:
#   floom auth <agent-token>                save token (api_url defaults to https://floom.dev)
#   floom auth <agent-token> <api-url>      save token + custom URL (for self-host)
#   floom auth login --token=<agent-token>  alternate form used by CLI snippets
#   floom auth whoami                       print identity for current token
#   floom auth logout                       clear saved token
#   floom auth --show                       print redacted current config
#   floom auth --clear                      delete config file (alias: logout)

set -euo pipefail

CONFIG="${FLOOM_CONFIG:-$HOME/.floom/config.json}"
DEFAULT_HOST_FILE="${HOME}/.floom/default-host"

# Return the api_url to use when none is explicitly supplied.
# Priority: FLOOM_API_URL env var > ~/.floom/default-host > hardcoded fallback.
default_host() {
  if [[ -n "${FLOOM_API_URL:-}" ]]; then
    echo "$FLOOM_API_URL"
  elif [[ -f "$DEFAULT_HOST_FILE" ]]; then
    cat "$DEFAULT_HOST_FILE"
  else
    echo "https://floom.dev"
  fi
}

case "${1:-}" in
  --show)
    if [[ ! -f "$CONFIG" ]]; then
      echo "no config at $CONFIG"
      exit 1
    fi
    CONFIG_PATH="$CONFIG" python3 - <<'PY'
import json
import os

c = json.load(open(os.environ["CONFIG_PATH"]))
key = c.get("api_key", "")
red = key[:4] + "..." + key[-4:] if len(key) > 8 else "***"
print(f"api_url: {c.get('api_url', 'https://floom.dev')}")
print(f"agent_token: {red}")
PY
    exit 0 ;;
  --clear|logout)
    rm -f "$CONFIG"
    echo "cleared $CONFIG"
    exit 0 ;;
  whoami)
    if [[ ! -f "$CONFIG" && -z "${FLOOM_API_KEY:-}" ]]; then
      echo "not logged in. Run: floom auth <agent-token>"
      exit 1
    fi
    CONFIG_PATH="$CONFIG" python3 - <<'PY'
import json
import os

env_key = os.environ.get("FLOOM_API_KEY", "")
cfg_path = os.environ.get("CONFIG_PATH", "")
if env_key:
    key = env_key
    url = os.environ.get("FLOOM_API_URL", "https://floom.dev")
elif cfg_path and os.path.exists(cfg_path):
    c = json.load(open(cfg_path))
    key = c.get("api_key", "")
    url = c.get("api_url", "https://floom.dev")
else:
    print("not logged in. Run: floom auth <agent-token>")
    raise SystemExit(1)

if not key:
    print("not logged in. Run: floom auth <agent-token>")
    raise SystemExit(1)

red = key[:14] + "..." + key[-4:] if len(key) > 18 else key[:4] + "..."
print(f"logged in  api_url: {url}")
print(f"token:     {red}")
PY
    exit $? ;;
  login)
    # Support: floom auth login --token=<agent-token> [--api-url=<url>] [--url=<url>]
    AGENT_TOKEN=""
    API_URL="$(default_host)"
    shift
    for arg in "$@"; do
      case "$arg" in
        -h|--help)
          cat <<EOF
floom auth login — save an Agent token.

usage:
  floom auth login --token=<agent_token> [--api-url=<api_url>]

options:
  --token=<token>      Agent token (required). Get yours at <api_url>/home
  --api-url=<url>      Override API base URL (default: install host or https://floom.dev)
  --url=<url>          Alias for --api-url

EOF
          exit 0 ;;
        --token=*)   AGENT_TOKEN="${arg#--token=}" ;;
        --api-url=*) API_URL="${arg#--api-url=}" ;;
        --url=*)     API_URL="${arg#--url=}" ;;
        *)           echo "floom auth login: unknown option: $arg" >&2; exit 1 ;;
      esac
    done
    if [[ -z "$AGENT_TOKEN" ]]; then
      echo "floom auth login: --token is required" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$CONFIG")"
    CONFIG_PATH="$CONFIG" AGENT_TOKEN="$AGENT_TOKEN" API_URL="$API_URL" python3 - <<'PY'
import json, os
with open(os.environ["CONFIG_PATH"], "w") as f:
    json.dump({"api_key": os.environ["AGENT_TOKEN"], "api_url": os.environ["API_URL"]}, f)
PY
    chmod 600 "$CONFIG"
    # Validate the token immediately — fail fast so the user knows right away.
    VALIDATE_FILE=$(mktemp)
    trap 'rm -f "$VALIDATE_FILE"' RETURN
    HTTP_CODE=$(curl -sS -o "$VALIDATE_FILE" -w "%{http_code}" \
      -H "Authorization: Bearer $AGENT_TOKEN" \
      "${API_URL%/}/api/session/me" 2>/dev/null) || HTTP_CODE="000"
    if [[ "$HTTP_CODE" != "200" ]]; then
      rm -f "$CONFIG"
      echo "ERROR: Token rejected by ${API_URL} (HTTP ${HTTP_CODE})." >&2
      echo "Mint a fresh token at ${API_URL}/home and try again." >&2
      exit 1
    fi
    # Extract user identity for a friendly confirmation message.
    IDENTITY=$(python3 -c "
import json, sys
try:
  d = json.load(open('$VALIDATE_FILE'))
  u = d.get('user', {})
  print(u.get('email') or u.get('id') or 'unknown')
except Exception:
  print('unknown')
" 2>/dev/null || echo "unknown")
    echo "Logged in as ${IDENTITY} at ${API_URL}"
    exit 0 ;;
  -h|--help|"")
    cat <<EOF
floom auth — manage Agent token authentication.

usage:
  floom auth <agent-token>                     save token (defaults to https://floom.dev)
  floom auth <agent-token> <api-url>           save token + custom URL (self-host)
  floom auth login --token=<agent-token>       save token (recommended form)
  floom auth whoami                            show identity for current token
  floom auth logout                            clear saved token
  floom auth --show                            print redacted config

Get your Agent token:
  https://floom.dev/home

Agent tokens look like:
  floom_agent_...
EOF
    [[ "${1:-}" == "" ]] && exit 1
    exit 0 ;;
esac

AGENT_TOKEN="$1"
API_URL="${2:-$(default_host)}"

exec bash "$0" login "--token=$AGENT_TOKEN" "--api-url=$API_URL"
