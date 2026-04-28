#!/usr/bin/env bash
# floom-apps.sh - manage published apps on Floom.

set -euo pipefail

_SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
LIB_DIR="$(cd "$(dirname "$_SCRIPT_PATH")" && pwd)"

usage() {
  cat <<'EOF'
floom apps - manage your Floom apps.

usage:
  floom apps get <slug>
  floom apps about <slug>
  floom apps list
  floom apps installed
  floom apps fork <slug> [--slug <new-slug>] [--name <name>]
  floom apps claim <slug>
  floom apps install <slug>
  floom apps uninstall <slug>
  floom apps update <slug> [--visibility private] [--primary-action <action>|--clear-primary-action] [--run-rate-limit-per-hour <n>|--clear-run-rate-limit]
  floom apps delete <slug>

  floom apps sharing get <slug>
  floom apps sharing set <slug> --state <private|link|invited> [--comment <text>] [--rotate-link-token]
  floom apps sharing invite <slug> (--email <email>|--username <username>)
  floom apps sharing revoke-invite <slug> <invite-id>
  floom apps sharing submit-review <slug>
  floom apps sharing withdraw-review <slug>

  floom apps secret-policies list <slug>
  floom apps secret-policies set <slug> <key> --policy <user_vault|creator_override>

  floom apps creator-secrets set <slug> <key> <value>
  floom apps creator-secrets set <slug> <key> --value <value>
  floom apps creator-secrets set <slug> <key> --value-stdin
  floom apps creator-secrets delete <slug> <key>

  floom apps rate-limit get <slug>
  floom apps rate-limit set <slug> --per-hour <n|default>

  floom apps reviews <slug> [--limit <n>]                                    (defaults to list)
  floom apps reviews list <slug> [--limit <n>]
  floom apps reviews submit <slug> --rating <1-5> [--title <text>] [--body <text>|--comment <text>|--body-stdin]
  floom apps review <slug> --rating <1-5> [--comment <text>|--body <text>]    (singular alias for reviews submit)

  floom apps source <slug>                                                   (defaults to source get)
  floom apps source get <slug>
  floom apps source openapi <slug>

  floom apps renderer get <slug>
  floom apps renderer upload <slug> (--source-file <path>|--source-stdin) [--output-shape <shape>]
  floom apps renderer delete <slug>

EOF
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

json_app_update_body() {
  VISIBILITY="$1" PRIMARY_ACTION="$2" CLEAR_PRIMARY="$3" RUN_RATE_LIMIT="$4" CLEAR_RUN_RATE_LIMIT="$5" python3 - <<'PY'
import json
import os

body = {}
if os.environ["VISIBILITY"]:
    body["visibility"] = os.environ["VISIBILITY"]
if os.environ["CLEAR_PRIMARY"] == "1":
    body["primary_action"] = None
elif os.environ["PRIMARY_ACTION"]:
    body["primary_action"] = os.environ["PRIMARY_ACTION"]
if os.environ["CLEAR_RUN_RATE_LIMIT"] == "1":
    body["run_rate_limit_per_hour"] = None
elif os.environ["RUN_RATE_LIMIT"]:
    body["run_rate_limit_per_hour"] = int(os.environ["RUN_RATE_LIMIT"])
print(json.dumps(body, separators=(",", ":")))
PY
}

json_sharing_body() {
  STATE="$1" COMMENT="$2" ROTATE="$3" python3 - <<'PY'
import json
import os

body = {"state": os.environ["STATE"]}
if os.environ["COMMENT"]:
    body["comment"] = os.environ["COMMENT"]
if os.environ["ROTATE"] == "1":
    body["link_token_rotate"] = True
print(json.dumps(body, separators=(",", ":")))
PY
}

json_invite_body() {
  KIND="$1" VALUE="$2" python3 - <<'PY'
import json
import os

print(json.dumps({os.environ["KIND"]: os.environ["VALUE"]}, separators=(",", ":")))
PY
}

json_policy_body() {
  python3 -c 'import json, sys; print(json.dumps({"policy": sys.argv[1]}, separators=(",", ":")))' "$1"
}

json_creator_secret_body() {
  python3 -c 'import json, sys; print(json.dumps({"value": sys.argv[1]}, separators=(",", ":")))' "$1"
}

json_fork_body() {
  SLUG="$1" NAME="$2" python3 - <<'PY'
import json
import os

body = {}
if os.environ["SLUG"]:
    body["slug"] = os.environ["SLUG"]
if os.environ["NAME"]:
    body["name"] = os.environ["NAME"]
print(json.dumps(body, separators=(",", ":")))
PY
}

json_rate_limit_body() {
  VALUE="$1" python3 - <<'PY'
import json
import os

value = os.environ["VALUE"]
rate = None if value == "default" else int(value)
print(json.dumps({"rate_limit_per_hour": rate}, separators=(",", ":")))
PY
}

json_review_body() {
  RATING="$1" TITLE="$2" BODY="$3" python3 - <<'PY'
import json
import os

body = {"rating": int(os.environ["RATING"])}
if os.environ["TITLE"]:
    body["title"] = os.environ["TITLE"]
if os.environ["BODY"]:
    body["body"] = os.environ["BODY"]
print(json.dumps(body, separators=(",", ":")))
PY
}

json_renderer_body() {
  SOURCE="$1" OUTPUT_SHAPE="$2" python3 - <<'PY'
import json
import os

body = {"source": os.environ["SOURCE"]}
if os.environ["OUTPUT_SHAPE"]:
    body["output_shape"] = os.environ["OUTPUT_SHAPE"]
print(json.dumps(body, separators=(",", ":")))
PY
}

require_arg() {
  local value="$1"
  local label="$2"
  if [[ -z "$value" ]]; then
    echo "$label" >&2
    exit 1
  fi
}

get_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps get: missing <slug>"
  exec bash "$LIB_DIR/floom-api.sh" GET "/api/hub/$(urlencode "$slug")"
}

list_cmd() {
  shift || true
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
    echo "floom apps list - list all apps in your workspace"
    exit 0
  fi
  exec bash "$LIB_DIR/floom-api.sh" GET /api/hub/mine
}

source_cmd() {
  shift || true
  local subcmd="${1:-get}"
  # Federico's spec: `floom apps source <slug>` (no subcommand) should
  # default to `get` so the CLI mirrors the MCP get_app_source tool 1:1.
  # Detect a slug-shaped first arg and rewrite.
  if [[ "$subcmd" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [[ "$subcmd" != "get" && "$subcmd" != "openapi" && "$subcmd" != "openapi-json" && "$subcmd" != "help" ]]; then
    set -- get "$@"
    subcmd="get"
  fi
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    get)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps source get: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/hub/$(urlencode "$slug")/source"
      ;;
    openapi|openapi-json)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps source openapi: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/hub/$(urlencode "$slug")/openapi.json"
      ;;
    *)
      echo "floom apps source: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

reviews_cmd() {
  # Allow callers to invoke us as either `apps reviews ...` (Federico's
  # original wording) or `apps review ...`. The dispatcher passes the
  # original verb as $1; we capture it here so we can route the singular
  # form `apps review <slug> --rating X --comment "..."` straight to the
  # `submit` handler (mirrors the MCP `leave_app_review` tool 1:1).
  local verb="${1:-reviews}"
  shift || true
  local subcmd="${1:-list}"
  if [[ "$verb" == "review" ]]; then
    # Singular form: `apps review <slug> ...` is always submit.
    set -- submit "$@"
    subcmd="submit"
  elif [[ "$subcmd" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [[ "$subcmd" != "list" && "$subcmd" != "submit" && "$subcmd" != "add" && "$subcmd" != "post" && "$subcmd" != "help" ]]; then
    # Plural form with a slug-shaped first arg: default to list.
    set -- list "$@"
    subcmd="list"
  fi
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    list)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps reviews list: missing <slug>"
      shift || true
      local limit="20"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --limit)
            limit="${2:-}"
            shift 2
            ;;
          --limit=*)
            limit="${1#--limit=}"
            shift
            ;;
          *)
            echo "floom apps reviews list: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ ! "$limit" =~ ^[0-9]+$ ]]; then
        echo "floom apps reviews list: --limit must be an integer" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/apps/$(urlencode "$slug")/reviews?limit=$limit"
      ;;
    submit|add|post)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps reviews submit: missing <slug>"
      shift || true
      local rating=""
      local title=""
      local body=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --rating)
            rating="${2:-}"
            shift 2
            ;;
          --rating=*)
            rating="${1#--rating=}"
            shift
            ;;
          --title)
            title="${2:-}"
            shift 2
            ;;
          --title=*)
            title="${1#--title=}"
            shift
            ;;
          --body|--comment)
            body="${2:-}"
            shift 2
            ;;
          --body=*)
            body="${1#--body=}"
            shift
            ;;
          --comment=*)
            body="${1#--comment=}"
            shift
            ;;
          --body-stdin|--comment-stdin)
            body="$(cat)"
            shift
            ;;
          *)
            echo "floom apps reviews submit: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ ! "$rating" =~ ^[1-5]$ ]]; then
        echo "floom apps reviews submit: --rating must be an integer from 1 to 5" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/apps/$(urlencode "$slug")/reviews" "$(json_review_body "$rating" "$title" "$body")"
      ;;
    *)
      echo "floom apps reviews: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

installed_cmd() {
  shift || true
  exec bash "$LIB_DIR/floom-api.sh" GET /api/hub/installed
}

fork_cmd() {
  shift || true
  local source_slug="${1:-}"
  require_arg "$source_slug" "floom apps fork: missing <slug>"
  shift || true
  local slug=""
  local name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --slug)
        slug="${2:-}"
        shift 2
        ;;
      --slug=*)
        slug="${1#--slug=}"
        shift
        ;;
      --name)
        name="${2:-}"
        shift 2
        ;;
      --name=*)
        name="${1#--name=}"
        shift
        ;;
      *)
        echo "floom apps fork: unknown option '$1'" >&2
        exit 1
        ;;
    esac
  done
  exec bash "$LIB_DIR/floom-api.sh" POST "/api/hub/$(urlencode "$source_slug")/fork" "$(json_fork_body "$slug" "$name")"
}

claim_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps claim: missing <slug>"
  exec bash "$LIB_DIR/floom-api.sh" POST "/api/hub/$(urlencode "$slug")/claim"
}

install_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps install: missing <slug>"
  exec bash "$LIB_DIR/floom-api.sh" POST "/api/hub/$(urlencode "$slug")/install"
}

uninstall_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps uninstall: missing <slug>"
  exec bash "$LIB_DIR/floom-api.sh" DELETE "/api/hub/$(urlencode "$slug")/install"
}

update_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps update: missing <slug>"
  shift || true
  local visibility=""
  local primary_action=""
  local clear_primary="0"
  local run_rate_limit=""
  local clear_run_rate_limit="0"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --visibility)
        visibility="${2:-}"
        shift 2
        ;;
      --visibility=*)
        visibility="${1#--visibility=}"
        shift
        ;;
      --primary-action)
        primary_action="${2:-}"
        shift 2
        ;;
      --primary-action=*)
        primary_action="${1#--primary-action=}"
        shift
        ;;
      --clear-primary-action)
        clear_primary="1"
        shift
        ;;
      --run-rate-limit-per-hour)
        run_rate_limit="${2:-}"
        shift 2
        ;;
      --run-rate-limit-per-hour=*)
        run_rate_limit="${1#--run-rate-limit-per-hour=}"
        shift
        ;;
      --clear-run-rate-limit)
        clear_run_rate_limit="1"
        shift
        ;;
      *)
        echo "floom apps update: unknown option '$1'" >&2
        exit 1
        ;;
    esac
  done
  if [[ -n "$visibility" ]]; then
    case "$visibility" in
      private) ;;
      *)
        echo "floom apps update: --visibility only accepts private; use 'floom apps sharing submit-review <slug>' for public Store review" >&2
        exit 1
        ;;
    esac
  fi
  if [[ "$clear_primary" == "1" && -n "$primary_action" ]]; then
    echo "floom apps update: use either --primary-action or --clear-primary-action" >&2
    exit 1
  fi
  if [[ "$clear_run_rate_limit" == "1" && -n "$run_rate_limit" ]]; then
    echo "floom apps update: use either --run-rate-limit-per-hour or --clear-run-rate-limit" >&2
    exit 1
  fi
  if [[ -n "$run_rate_limit" && ! "$run_rate_limit" =~ ^[0-9]+$ ]]; then
    echo "floom apps update: --run-rate-limit-per-hour must be an integer" >&2
    exit 1
  fi
  if [[ -z "$visibility" && -z "$primary_action" && "$clear_primary" != "1" && -z "$run_rate_limit" && "$clear_run_rate_limit" != "1" ]]; then
    echo "floom apps update: provide at least one updatable field" >&2
    exit 1
  fi
  exec bash "$LIB_DIR/floom-api.sh" PATCH "/api/hub/$(urlencode "$slug")" "$(json_app_update_body "$visibility" "$primary_action" "$clear_primary" "$run_rate_limit" "$clear_run_rate_limit")"
}

delete_cmd() {
  shift || true
  local slug="${1:-}"
  require_arg "$slug" "floom apps delete: missing <slug>"
  exec bash "$LIB_DIR/floom-api.sh" DELETE "/api/hub/$(urlencode "$slug")"
}

sharing_cmd() {
  shift || true
  local subcmd="${1:-}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    get)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps sharing get: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/me/apps/$(urlencode "$slug")/sharing"
      ;;
    set)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps sharing set: missing <slug>"
      shift || true
      local state=""
      local comment=""
      local rotate="0"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --state)
            state="${2:-}"
            shift 2
            ;;
          --state=*)
            state="${1#--state=}"
            shift
            ;;
          --comment)
            comment="${2:-}"
            shift 2
            ;;
          --comment=*)
            comment="${1#--comment=}"
            shift
            ;;
          --rotate-link-token)
            rotate="1"
            shift
            ;;
          *)
            echo "floom apps sharing set: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      case "$state" in
        private|link|invited) ;;
        *)
          echo "floom apps sharing set: --state must be private, link, or invited" >&2
          exit 1
          ;;
      esac
      exec bash "$LIB_DIR/floom-api.sh" PATCH "/api/me/apps/$(urlencode "$slug")/sharing" "$(json_sharing_body "$state" "$comment" "$rotate")"
      ;;
    invite)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps sharing invite: missing <slug>"
      shift || true
      local email=""
      local username=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --email)
            email="${2:-}"
            shift 2
            ;;
          --email=*)
            email="${1#--email=}"
            shift
            ;;
          --username)
            username="${2:-}"
            shift 2
            ;;
          --username=*)
            username="${1#--username=}"
            shift
            ;;
          *)
            echo "floom apps sharing invite: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ -n "$email" && -n "$username" ]] || [[ -z "$email" && -z "$username" ]]; then
        echo "floom apps sharing invite: provide exactly one of --email or --username" >&2
        exit 1
      fi
      if [[ -n "$email" ]]; then
        exec bash "$LIB_DIR/floom-api.sh" POST "/api/me/apps/$(urlencode "$slug")/sharing/invite" "$(json_invite_body email "$email")"
      fi
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/me/apps/$(urlencode "$slug")/sharing/invite" "$(json_invite_body username "$username")"
      ;;
    revoke-invite)
      shift || true
      local slug="${1:-}"
      local invite_id="${2:-}"
      require_arg "$slug" "floom apps sharing revoke-invite: missing <slug>"
      require_arg "$invite_id" "floom apps sharing revoke-invite: missing <invite-id>"
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/me/apps/$(urlencode "$slug")/sharing/invite/$(urlencode "$invite_id")/revoke"
      ;;
    submit-review|withdraw-review)
      local action="$subcmd"
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps sharing $action: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/me/apps/$(urlencode "$slug")/sharing/$action"
      ;;
    *)
      echo "floom apps sharing: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

secret_policies_cmd() {
  shift || true
  local subcmd="${1:-}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    list)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps secret-policies list: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/me/apps/$(urlencode "$slug")/secret-policies"
      ;;
    set)
      shift || true
      local slug="${1:-}"
      local key="${2:-}"
      require_arg "$slug" "floom apps secret-policies set: missing <slug>"
      require_arg "$key" "floom apps secret-policies set: missing <key>"
      shift 2 || true
      local policy=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --policy)
            policy="${2:-}"
            shift 2
            ;;
          --policy=*)
            policy="${1#--policy=}"
            shift
            ;;
          *)
            echo "floom apps secret-policies set: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      case "$policy" in
        user_vault|creator_override) ;;
        *)
          echo "floom apps secret-policies set: --policy must be user_vault or creator_override" >&2
          exit 1
          ;;
      esac
      exec bash "$LIB_DIR/floom-api.sh" PUT "/api/me/apps/$(urlencode "$slug")/secret-policies/$(urlencode "$key")" "$(json_policy_body "$policy")"
      ;;
    *)
      echo "floom apps secret-policies: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

creator_secrets_cmd() {
  shift || true
  local subcmd="${1:-}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    set)
      shift || true
      local slug="${1:-}"
      local key="${2:-}"
      require_arg "$slug" "floom apps creator-secrets set: missing <slug>"
      require_arg "$key" "floom apps creator-secrets set: missing <key>"
      shift 2 || true
      local value=""
      case "${1:-}" in
        --value)
          shift || true
          if [[ $# -lt 1 ]]; then
            echo "floom apps creator-secrets set: --value requires an argument" >&2
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
          echo "floom apps creator-secrets set: missing <value> or --value-stdin" >&2
          exit 1
          ;;
        *)
          value="$1"
          ;;
      esac
      exec bash "$LIB_DIR/floom-api.sh" PUT "/api/me/apps/$(urlencode "$slug")/creator-secrets/$(urlencode "$key")" "$(json_creator_secret_body "$value")"
      ;;
    delete|rm|remove)
      shift || true
      local slug="${1:-}"
      local key="${2:-}"
      require_arg "$slug" "floom apps creator-secrets delete: missing <slug>"
      require_arg "$key" "floom apps creator-secrets delete: missing <key>"
      exec bash "$LIB_DIR/floom-api.sh" DELETE "/api/me/apps/$(urlencode "$slug")/creator-secrets/$(urlencode "$key")"
      ;;
    *)
      echo "floom apps creator-secrets: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

rate_limit_cmd() {
  shift || true
  local subcmd="${1:-}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    get)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps rate-limit get: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/api/me/apps/$(urlencode "$slug")/rate-limit"
      ;;
    set)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps rate-limit set: missing <slug>"
      shift || true
      local per_hour=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --per-hour)
            per_hour="${2:-}"
            shift 2
            ;;
          --per-hour=*)
            per_hour="${1#--per-hour=}"
            shift
            ;;
          *)
            echo "floom apps rate-limit set: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ -z "$per_hour" ]]; then
        echo "floom apps rate-limit set: --per-hour is required" >&2
        exit 1
      fi
      if [[ "$per_hour" != "default" && ! "$per_hour" =~ ^[0-9]+$ ]]; then
        echo "floom apps rate-limit set: --per-hour must be an integer or default" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" PATCH "/api/me/apps/$(urlencode "$slug")/rate-limit" "$(json_rate_limit_body "$per_hour")"
      ;;
    *)
      echo "floom apps rate-limit: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

renderer_cmd() {
  shift || true
  local subcmd="${1:-get}"
  case "$subcmd" in
    ""|-h|--help|help)
      usage
      exit 0
      ;;
    get|meta)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps renderer get: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" GET "/renderer/$(urlencode "$slug")/meta"
      ;;
    upload)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps renderer upload: missing <slug>"
      shift || true
      local source=""
      local output_shape=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --source-file)
            if [[ -z "${2:-}" ]]; then
              echo "floom apps renderer upload: --source-file requires a path" >&2
              exit 1
            fi
            source="$(<"$2")"
            shift 2
            ;;
          --source-file=*)
            source="$(<"${1#--source-file=}")"
            shift
            ;;
          --source-stdin)
            source="$(cat)"
            shift
            ;;
          --output-shape)
            output_shape="${2:-}"
            shift 2
            ;;
          --output-shape=*)
            output_shape="${1#--output-shape=}"
            shift
            ;;
          *)
            echo "floom apps renderer upload: unknown option '$1'" >&2
            exit 1
            ;;
        esac
      done
      if [[ -z "$source" ]]; then
        echo "floom apps renderer upload: provide --source-file or --source-stdin" >&2
        exit 1
      fi
      exec bash "$LIB_DIR/floom-api.sh" POST "/api/hub/$(urlencode "$slug")/renderer" "$(json_renderer_body "$source" "$output_shape")"
      ;;
    delete|rm|remove)
      shift || true
      local slug="${1:-}"
      require_arg "$slug" "floom apps renderer delete: missing <slug>"
      exec bash "$LIB_DIR/floom-api.sh" DELETE "/api/hub/$(urlencode "$slug")/renderer"
      ;;
    *)
      echo "floom apps renderer: unknown subcommand '$subcmd'" >&2
      echo "run 'floom apps --help' for usage." >&2
      exit 1
      ;;
  esac
}

SUBCMD="${1:-list}"
case "$SUBCMD" in
  ""|-h|--help|help)
    usage
    exit 0
    ;;
  get|detail|details|about)
    get_cmd "$@"
    ;;
  list)
    list_cmd "$@"
    ;;
  installed)
    installed_cmd "$@"
    ;;
  fork)
    fork_cmd "$@"
    ;;
  claim)
    claim_cmd "$@"
    ;;
  install)
    install_cmd "$@"
    ;;
  uninstall)
    uninstall_cmd "$@"
    ;;
  update)
    update_cmd "$@"
    ;;
  delete|rm|remove)
    delete_cmd "$@"
    ;;
  sharing)
    sharing_cmd "$@"
    ;;
  secret-policies|secret-policy)
    secret_policies_cmd "$@"
    ;;
  creator-secrets|creator-secret)
    creator_secrets_cmd "$@"
    ;;
  rate-limit|rate-limits)
    rate_limit_cmd "$@"
    ;;
  reviews|review)
    # `$@` still contains $SUBCMD as $1 — reviews_cmd reads it via $verb so
    # it can route singular `review <slug> ...` straight to submit.
    reviews_cmd "$@"
    ;;
  source)
    source_cmd "$@"
    ;;
  renderer)
    renderer_cmd "$@"
    ;;
  *)
    echo "floom apps: unknown subcommand '$SUBCMD'" >&2
    echo "run 'floom apps --help' for usage." >&2
    exit 1
    ;;
esac
