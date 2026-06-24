#!/usr/bin/env bash
# Attach a domain to a Vercel project (if needed), verify it, and alias a deploy.
#
# Usage:
#   VERCEL_TOKEN=... ops/vercel-ensure-alias.sh \
#     --team TEAM_ID --project PROJECT_ID --deploy DEPLOY_ID --domain example.com
#
# Exits non-zero if alias fails after verification attempts.

set -euo pipefail

TEAM=""
PROJECT=""
DEPLOY=""
DOMAINS=()
TOKEN="${VERCEL_TOKEN:-}"

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

api() {
  curl -sS "$@" -H "Authorization: Bearer $TOKEN"
}

domain_verified() {
  local domain="$1"
  api "https://api.vercel.com/v9/projects/${PROJECT}/domains/${domain}?teamId=${TEAM}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("1" if d.get("verified") else "0")'
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

  echo "::error::Domain ${domain} is not verified on team ${TEAM}." >&2
  return 1
}

alias_deploy() {
  local domain="$1"
  echo "Aliasing ${domain} -> ${DEPLOY}..."
  resp="$(api -X POST \
    "https://api.vercel.com/v2/deployments/${DEPLOY}/aliases?teamId=${TEAM}" \
    -H "Content-Type: application/json" \
    -d "{\"alias\":\"${domain}\"}")"
  echo "$resp"
  echo "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
err = d.get("error") or {}
ok = bool(d.get("uid")) or err.get("code") in ("not_modified",)
if not ok:
    print(f"::error::Alias failed: {err}", file=sys.stderr)
sys.exit(0 if ok else 1)
'
}

for domain in "${DOMAINS[@]}"; do
  ensure_domain "$domain"
  alias_deploy "$domain"
done

echo "All domains aliased: ${DOMAINS[*]}"
