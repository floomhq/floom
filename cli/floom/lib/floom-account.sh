#!/usr/bin/env bash
# floom-account.sh - manage account/workspace resources from the CLI.

set -euo pipefail

_SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
LIB_DIR="$(cd "$(dirname "$_SCRIPT_PATH")" && pwd)"

usage() {
  cat <<'EOF'
floom account - manage workspace secrets and agent tokens.

usage:
  floom account secrets list
  floom account secrets set <key> <value>
  floom account secrets set <key> --value <value>
  floom account secrets set <key> --value-stdin
  floom account secrets delete <key>

  floom account agent-tokens list
  floom account agent-tokens create --label <label> --scope <read|read-write|publish-only> [--workspace-id <id>] [--rate-limit-per-minute <n>]
  floom account agent-tokens revoke <token-id>

EOF
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

json_secret_body() {
  python3 -c 'import json, sys; print(json.dumps({"key": sys.argv[1], "value": sys.argv[2]}, separators=(",", ":")))' "$1" "$2"
}

json_agent_token_body() {
  LABEL="$1" SCOPE="$2" WORKSPACE_ID="$3" RATE_LIMIT="$4" python3 - <<'PY'
import json
import os

body = {
    "label": os.environ["LABEL"],
    "scope": os.environ["SCOPE"],
}
if os.environ["WORKSPACE_ID"]:
    body["workspace_id"] = os.environ["WORKSPACE_ID"]
if os.environ["RATE_LIMIT"]:
    body["rate_limit_per_minute"] = int(os.environ["RATE_LIMIT"])
print(json.dumps(body, separators=(",", ":")))
PY
}

secrets_cmd() {
  local subcmd="${1:-}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    list)
      shift || true
      exec bash "$LIB_DIR/floom-api.sh" GET /api/secrets
      ;;
    set)
      shift || true
      local key="${1:-}"
      if [[ -z "$key" ]]; then
        echo "floom account secrets set: missing <key>" >&2
        exit 1
      fi
      shift || true
      local value=""
      case "${1:-}" in
        --value)
          shift || true
          if [[ $# -lt 1 ]]; then
            echo "floom account secrets set: --value requires an argument" >&2
            exit 1
          fi
          value="$1"
          ;;
        --value=*)
          value="${1#--value=}"
          ;;
        --value-stdin)
          value="$(cat)"
          ;;
        "")
          echo "floom account secrets set: missing <value> or --value-stdin" >&2
          exit 1
          ;;
        *)
          value="$1"
          ;;
      esac
      exec bash "$LIB_DIR/floom-api.sh" POST /api/secrets "$(json_secret_body "$key" "$value")"
      ;;
    delete|rm|remove)
      shift || true
      local key="${1:-}"
      if [[ -z "$key" ]]; then
        echo "floom account secrets delete: missing <key>" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" DELETE "/api/secrets/$(urlencode "$key")"
      ;;
    *)
      echo "floom account secrets: unknown subcommand '$subcmd'" >&2
      echo "run 'floom account --help' for usage." >&2
      exit 1
      ;;
  esac
}

agent_tokens_cmd() {
  local subcmd="${1:-list}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    list)
      shift || true
      exec bash "$LIB_DIR/floom-api.sh" GET /api/me/agent-keys
      ;;
    create)
      shift || true
      local label=""
      local scope=""
      local workspace_id=""
      local rate_limit=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --label)
            label="${2:-}"
            shift 2
            ;;
          --label=*)
            label="${1#--label=}"
            shift
            ;;
          --scope)
            scope="${2:-}"
            shift 2
            ;;
          --scope=*)
            scope="${1#--scope=}"
            shift
            ;;
          --workspace-id)
            workspace_id="${2:-}"
            shift 2
            ;;
          --workspace-id=*)
            workspace_id="${1#--workspace-id=}"
            shift
            ;;
          --rate-limit-per-minute)
            rate_limit="${2:-}"
            shift 2
            ;;
          --rate-limit-per-minute=*)
            rate_limit="${1#--rate-limit-per-minute=}"
            shift
            ;;
          *)
            echo "floom account agent-tokens create: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ -z "$label" || -z "$scope" ]]; then
        echo "floom account agent-tokens create: --label and --scope are required" >&2
        exit 1
      fi
      case "$scope" in
        read|read-write|publish-only) ;;
        *)
          echo "floom account agent-tokens create: invalid --scope '$scope'" >&2
          exit 1
          ;;
      esac
      if [[ -n "$rate_limit" && ! "$rate_limit" =~ ^[0-9]+$ ]]; then
        echo "floom account agent-tokens create: --rate-limit-per-minute must be an integer" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" POST /api/me/agent-keys "$(json_agent_token_body "$label" "$scope" "$workspace_id" "$rate_limit")"
      ;;
    revoke)
      shift || true
      local token_id="${1:-}"
      if [[ -z "$token_id" ]]; then
        echo "floom account agent-tokens revoke: missing <token-id>" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/me/agent-keys/$(urlencode "$token_id")/revoke"
      ;;
    *)
      echo "floom account agent-tokens: unknown subcommand '$subcmd'" >&2
      echo "run 'floom account --help' for usage." >&2
      exit 1
      ;;
  esac
}

RESOURCE="${1:-}"
case "$RESOURCE" in
  ""|-h|--help|help)
    usage
    exit 0
    ;;
  secrets|secret)
    shift || true
    secrets_cmd "$@"
    ;;
  agent-tokens|agent-token|tokens)
    shift || true
    agent_tokens_cmd "$@"
    ;;
  *)
    echo "floom account: unknown resource '$RESOURCE'" >&2
    echo "run 'floom account --help' for usage." >&2
    exit 1
    ;;
esac
