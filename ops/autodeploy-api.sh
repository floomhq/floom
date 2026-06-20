#!/usr/bin/env bash
# Deterministic API autodeploy wrapper for systemd timers/webhooks.
#
# This script is intentionally stricter than the manual deploy command: a
# server-side deploy checkout must be a clean mirror of origin/main before the
# app deploy runs. Direct hotfix edits or local-only commits are rejected with an
# actionable error instead of letting a merge/update wedge production.

set -Eeuo pipefail

WORKEROS_ROOT="${WORKEROS_ROOT:-/opt/floom}"
WORKEROS_BRANCH="${WORKEROS_BRANCH:-main}"
SERVICE_LABEL="${WORKEROS_AUTODEPLOY_LABEL:-floom-api}"
DEPLOY_CMD="${WORKEROS_DEPLOY_CMD:-$WORKEROS_ROOT/ops/deploy-api.sh}"
ALERT_WEBHOOK="${WORKEROS_AUTODEPLOY_ALERT_WEBHOOK:-}"

log() { echo "[autodeploy:${SERVICE_LABEL}] $*"; }

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

notify_failure() {
  local message="$1"
  if [[ -z "$ALERT_WEBHOOK" ]]; then
    return 0
  fi
  local escaped
  escaped="$(printf '%s' "$message" | json_escape)"
  curl -fsS -m 8 \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"${escaped}\"}" \
    "$ALERT_WEBHOOK" >/dev/null || true
}

fail() {
  local message="$*"
  log "FAIL: $message" >&2
  notify_failure "$message"
  exit 1
}

on_error() {
  local status=$?
  notify_failure "Autodeploy ${SERVICE_LABEL} failed with exit ${status}. Check journalctl -u ${SERVICE_LABEL}-autodeploy.service."
  exit "$status"
}
trap on_error ERR

command -v git >/dev/null 2>&1 || fail "git is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

[[ -d "$WORKEROS_ROOT/.git" ]] || fail "deploy checkout is not a git repo: $WORKEROS_ROOT"
cd "$WORKEROS_ROOT"

git remote get-url origin >/dev/null 2>&1 || fail "git remote origin is not configured"

log "fetching origin/${WORKEROS_BRANCH}"
git fetch origin "$WORKEROS_BRANCH" --quiet

if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short >&2 || true
  fail "deploy checkout has local tracked changes. Move them to a branch/stash, or reconcile them into origin/${WORKEROS_BRANCH}, then rerun."
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
if [[ -n "$UNTRACKED" ]]; then
  printf '%s\n' "$UNTRACKED" >&2
  fail "deploy checkout has untracked files. Move runtime artifacts out of the repo or add ignore rules before autodeploy."
fi

read -r AHEAD BEHIND < <(git rev-list --left-right --count "HEAD...origin/${WORKEROS_BRANCH}")
if [[ "$AHEAD" != "0" ]]; then
  git log --oneline "origin/${WORKEROS_BRANCH}..HEAD" >&2 || true
  fail "deploy checkout has local commits not on origin/${WORKEROS_BRANCH}. Push/revert them or replace the checkout."
fi

TARGET_SHA="$(git rev-parse "origin/${WORKEROS_BRANCH}")"
log "syncing clean checkout to ${WORKEROS_BRANCH}@${TARGET_SHA}"
git checkout -B "$WORKEROS_BRANCH" "origin/${WORKEROS_BRANCH}" --quiet

[[ -x "$DEPLOY_CMD" ]] || fail "deploy command is missing or not executable: $DEPLOY_CMD"
log "running deploy command: $DEPLOY_CMD"
"$DEPLOY_CMD"

log "success: deployed ${TARGET_SHA}"
