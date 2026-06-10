#!/usr/bin/env bash
# WorkerOS prod API smoke matrix cron wrapper for self-hosted server.
set -euo pipefail

REPO_DIR="${WORKEROS_REPO_DIR:-/root/workeros}"
LOG_DIR="${WORKEROS_SMOKE_LOG_DIR:-/var/log/workeros-smoke}"
SECRET_FILE="${FLOOM_SECRET_FILE:-${REPO_DIR}/.deploy-secret}"
API_URL="${WORKEROS_API_URL:-https://workers-api.floom.dev}"
LOCK_FILE="${WORKEROS_SMOKE_LOCK_FILE:-/tmp/workeros-prod-smoke-matrix.lock}"

mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/api-smoke-${STAMP}.log"
REPORT_FILE="${REPO_DIR}/docs/workers/SMOKE-RESULTS-$(date -u +%Y-%m-%d).md"

if [[ -z "${FLOOM_SECRET:-}" ]]; then
  if [[ ! -f "$SECRET_FILE" ]]; then
    echo "Missing FLOOM_SECRET and secret file ${SECRET_FILE}" | tee -a "$LOG_FILE" >&2
    exit 2
  fi
  FLOOM_SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
  export FLOOM_SECRET
fi

{
  echo "=== WorkerOS API smoke ${STAMP} ==="
  echo "repo=${REPO_DIR}"
  echo "api=${API_URL}"
  echo "report=${REPORT_FILE}"
} >> "$LOG_FILE"

(
  flock -n 9 || {
    echo "Another WorkerOS API smoke run is already active" | tee -a "$LOG_FILE" >&2
    exit 3
  }
  cd "$REPO_DIR"
  python3 scripts/prod_smoke_matrix.py \
    --api "$API_URL" \
    --output "$REPORT_FILE"
) 9>"$LOCK_FILE" >> "$LOG_FILE" 2>&1

find "$LOG_DIR" -name 'api-smoke-*.log' -mtime +14 -delete 2>/dev/null || true
echo "WorkerOS API smoke completed: ${REPORT_FILE}" >> "$LOG_FILE"
