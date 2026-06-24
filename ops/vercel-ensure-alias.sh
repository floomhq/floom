#!/usr/bin/env bash
# Attach a domain to a Vercel project (if needed), verify it, and alias a deploy.
#
# Usage:
#   VERCEL_TOKEN=... ops/vercel-ensure-alias.sh \
#     --team TEAM_ID --project PROJECT_ID --deploy DEPLOY_ID --domain example.com
#
# Domains listed in REQUIRED_DOMAINS (comma-separated) must succeed or the script exits 1.
# Other domains are best-effort (alias attempted; verify/add only on failure).

set -euo pipefail

TEAM=""
PROJECT=""
DEPLOY=""
DOMAINS=()
REQUIRED="${REQUIRED_DOMAINS:-workeros.floom.dev}"
TOKEN="${VERCEL_TOKEN:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --deploy) DEPLOY="$2"; shift 2 ;;
    --domain) DOMAINS+=("$2"); shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TOKEN" || -z "$TEAM" || -z "$PROJECT" || -z "$DEPLOY" || ${#DOMAINS[@]} -eq 0 ]]; then
  echo "Usage: VERCEL_TOKEN=... $0 --team T --project P --deploy D --domain a.com [--domain b.com]" >&2
  exit 2
fi

is_required() {
  local domain="$1"
  local d
  IFS=',' read -r -a req <<< "$REQUIRED"
  for d in "${req[@]}"; do
    [[ "$d" == "$domain" ]] && return 0
  done
  return 1
}

api() {
  local method="GET"
  local data=""
  local url=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -X) method="$2"; shift 2 ;;
      -H) shift 2 ;;
      -d) data="$2"; shift 2 ;;
      *) url="$1"; shift ;;
    esac
  done
  if [[ -n "$data" ]]; then
    python3 "$SCRIPT_DIR/http-client.py" vercel-request --method "$method" --url "$url" --data "$data"
  else
    python3 "$SCRIPT_DIR/http-client.py" vercel-request --method "$method" --url "$url"
  fi
}

domain_verified() {
  local domain="$1"
  api "https://api.vercel.com/v9/projects/${PROJECT}/domains/${domain}?teamId=${TEAM}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("1" if d.get("verified") else "0")'
}

log_pending_txt() {
  local domain="$1"
  api "https://api.vercel.com/v9/projects/${PROJECT}/domains/${domain}?teamId=${TEAM}" \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)
for v in d.get("verification") or []:
    if v.get("type") == "TXT":
        print(f"::warning::Add TXT {v.get(\"domain\")} = {v.get(\"value\")}", file=sys.stderr)
'
}

ensure_domain() {
  local domain="$1"
  echo "Ensuring ${domain} is on project ${PROJECT} (team ${TEAM})..."

  if [[ "$(domain_verified "$domain")" == "1" ]]; then
    echo "  ${domain} already verified on project."
    return 0
  fi

  add_resp="$(api -X POST \
    "https://api.vercel.com/v10/projects/${PROJECT}/domains?teamId=${TEAM}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${domain}\"}")"
  echo "  add: $add_resp"

  for attempt in $(seq 1 12); do
    verify_resp="$(api -X POST \
      "https://api.vercel.com/v9/projects/${PROJECT}/domains/${domain}/verify?teamId=${TEAM}")"
    echo "  verify attempt ${attempt}: $verify_resp"
    if [[ "$(domain_verified "$domain")" == "1" ]]; then
      echo "  ${domain} verified."
      return 0
    fi
    sleep 5
  done

  log_pending_txt "$domain"
  echo "::error::Domain ${domain} is not verified on project ${PROJECT}." >&2
  return 1
}

alias_deploy() {
  local domain="$1"
  echo "Aliasing ${domain} -> ${DEPLOY}..."
  local resp err ok
  # Alias without teamId first — floomhq team tokens often 404 with ?teamId= on this endpoint.
  resp="$(api -X POST \
    "https://api.vercel.com/v2/deployments/${DEPLOY}/aliases" \
    -H "Content-Type: application/json" \
    -d "{\"alias\":\"${domain}\"}")"
  echo "  alias (no teamId): $resp"
  ok="$(echo "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
err = d.get("error") or {}
ok = bool(d.get("uid")) or err.get("code") in ("not_modified",)
print("1" if ok else "0")
')"
  if [[ "$ok" != "1" ]]; then
    resp="$(api -X POST \
      "https://api.vercel.com/v2/deployments/${DEPLOY}/aliases?teamId=${TEAM}" \
      -H "Content-Type: application/json" \
      -d "{\"alias\":\"${domain}\"}")"
    echo "  alias (teamId): $resp"
    ok="$(echo "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
err = d.get("error") or {}
ok = bool(d.get("uid")) or err.get("code") in ("not_modified",)
print("1" if ok else "0")
')"
  fi
  if [[ "$ok" != "1" ]]; then
    echo "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
err = d.get("error") or {}
print(f"::error::Alias failed: {err}", file=sys.stderr)
'
    return 1
  fi
  return 0
}

alias_domain() {
  local domain="$1"
  # Team-verified apex domains (e.g. floom.dev) often alias without a project-domain row.
  if alias_deploy "$domain"; then
    return 0
  fi
  echo "  direct alias failed for ${domain}; trying project attach + verify..."
  ensure_domain "$domain"
  alias_deploy "$domain"
}

fail=0
for domain in "${DOMAINS[@]}"; do
  if alias_domain "$domain"; then
    echo "OK: ${domain} -> ${DEPLOY}"
  elif is_required "$domain"; then
    echo "::error::Required domain ${domain} could not be aliased." >&2
    fail=1
  else
    echo "::warning::Optional domain ${domain} could not be aliased." >&2
  fi
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "Landing aliases done: ${DOMAINS[*]}"
