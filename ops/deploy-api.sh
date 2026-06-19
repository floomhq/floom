#!/usr/bin/env bash
# ops/deploy-api.sh — idempotent backend deploy for workeros-api
#
# Usage:
#   ./ops/deploy-api.sh              # deploy origin/main
#   ./ops/deploy-api.sh --dry-run    # show what would happen, touch nothing
#   ./ops/deploy-api.sh --skip-drain # deploy even if runs are active (DANGER)
#
# What it does:
#   1. Pre-flight checks (root, sqlite3, systemctl)
#   2. Backup DB to /root/backups/manual/
#   3. Fetch origin/main and show SHA
#   4. Abort (or wait) if runs are currently active
#   5. Sync source files from origin/main (no git reset --hard)
#   6. Clean .rej/.bak patch cruft under apps/
#   7. Install deployed apps/api/requirements.txt into the actual service venv
#   8. systemctl restart workeros-api
#   9. Poll /health until ok (hard gate, exit 1 on timeout)
#  10. Assert key endpoints return expected HTTP codes
#  11. Verify schema drift (calls ops/verify-schema.py)
#  12. Run live route smoke gate (hard post-deploy gate)
#  13. Print SUCCESS/FAIL summary

set -euo pipefail

# ---------------------------------------------------------------------------
# Config (all overridable via env)
# ---------------------------------------------------------------------------
WORKEROS_ROOT="${WORKEROS_ROOT:-/opt/workeros}"
DB_PATH="${FLOOM_DB:-$WORKEROS_ROOT/data/floom.db}"
BACKUP_ROOT="${WORKEROS_BACKUP_ROOT:-/root/backups}"
SERVICE_VENV="${WORKEROS_API_VENV:-$WORKEROS_ROOT/apps/api/venv}"
API_REQUIREMENTS="${WORKEROS_API_REQUIREMENTS:-$WORKEROS_ROOT/apps/api/requirements.txt}"
API_PORT="${WORKEROS_API_PORT:-8011}"
API_BASE="http://127.0.0.1:${API_PORT}"
HEALTH_POLL_INTERVAL=2          # seconds between health polls
HEALTH_TIMEOUT=90               # seconds before giving up
DRAIN_WAIT=80                   # seconds to wait for active runs to finish
DRAIN_POLL=5                    # seconds between drain checks
SERVICE_NAME="workeros-api"
DRY_RUN=0
SKIP_DRAIN=0

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --skip-drain) SKIP_DRAIN=1 ;;
    *) echo "[deploy] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy] WARN: $*" >&2; }
fail() { echo "[deploy] FAIL: $*" >&2; exit 1; }

dry_run_gate() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN: would execute: $*"
    return
  fi
  "$@"
}

# Resolve a possibly-relative DB path against the API working directory
resolve_db_path() {
  local raw="$1"
  if [[ "$raw" == /* ]]; then
    echo "$raw"
  else
    python3 -c "
from pathlib import Path
raw = Path('$raw')
base = Path('$WORKEROS_ROOT/apps/api')
print((base / raw).resolve())
"
  fi
}

RESOLVED_DB="$(resolve_db_path "$DB_PATH")"

# ---------------------------------------------------------------------------
# Step 0: Pre-flight
# ---------------------------------------------------------------------------
log "=== Workeros backend deploy ==="
[[ $DRY_RUN -eq 1 ]] && log "*** DRY-RUN MODE: no system changes will be made ***"

if [[ $EUID -ne 0 ]]; then
  fail "Must run as root (needed for systemctl)"
fi

for cmd in sqlite3 systemctl curl git python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Required command not found: $cmd"
done

[[ -f "$RESOLVED_DB" ]] || fail "Database not found at: $RESOLVED_DB"

# Verify this is the right repo
cd "$WORKEROS_ROOT"
git remote get-url origin | grep -q "workeros" || fail "Not in the workeros git repo"

# ---------------------------------------------------------------------------
# Step 1: Backup DB
# ---------------------------------------------------------------------------
TS="$(date -u +%s)"
BACKUP_DIR="$BACKUP_ROOT/manual"
BACKUP_FILE="$BACKUP_DIR/floom-predeploy-${TS}.db"

mkdir -p "$BACKUP_DIR"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would backup DB → $BACKUP_FILE"
else
  log "Backing up DB → $BACKUP_FILE"
  sqlite3 "$RESOLVED_DB" ".backup '$BACKUP_FILE'"
  BACKUP_SIZE="$(du -sh "$BACKUP_FILE" | cut -f1)"
  log "Backup complete: $BACKUP_FILE ($BACKUP_SIZE)"
fi

# ---------------------------------------------------------------------------
# Step 2: Fetch origin and show target SHA
# ---------------------------------------------------------------------------
log "Fetching origin/main..."
dry_run_gate git fetch origin main --quiet

TARGET_SHA="$(git rev-parse origin/main)"
CURRENT_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
log "Current HEAD: $CURRENT_SHA"
log "Deploying SHA: $TARGET_SHA"

if [[ "$CURRENT_SHA" == "$TARGET_SHA" && $DRY_RUN -eq 0 ]]; then
  log "Already at origin/main ($TARGET_SHA) — proceeding anyway to ensure clean sync."
fi

# ---------------------------------------------------------------------------
# Step 3: Check for active runs (drain gate)
# ---------------------------------------------------------------------------
ACTIVE_RUNS=0
if [[ -f "$RESOLVED_DB" ]]; then
  ACTIVE_RUNS="$(sqlite3 "$RESOLVED_DB" "SELECT COUNT(*) FROM runs WHERE status IN ('running','queued');" 2>/dev/null || echo 0)"
fi

if [[ "$ACTIVE_RUNS" -gt 0 ]]; then
  if [[ $SKIP_DRAIN -eq 1 ]]; then
    warn "Skipping drain: $ACTIVE_RUNS run(s) still active (--skip-drain passed)"
  else
    log "Waiting for $ACTIVE_RUNS active run(s) to drain (max ${DRAIN_WAIT}s)..."
    ELAPSED=0
    while [[ "$ACTIVE_RUNS" -gt 0 && $ELAPSED -lt $DRAIN_WAIT ]]; do
      sleep $DRAIN_POLL
      ELAPSED=$((ELAPSED + DRAIN_POLL))
      ACTIVE_RUNS="$(sqlite3 "$RESOLVED_DB" "SELECT COUNT(*) FROM runs WHERE status IN ('running','queued');" 2>/dev/null || echo 0)"
      log "  ${ELAPSED}s elapsed — $ACTIVE_RUNS run(s) still active"
    done
    if [[ "$ACTIVE_RUNS" -gt 0 ]]; then
      fail "Runs still active after ${DRAIN_WAIT}s drain wait. Re-run with --skip-drain to force."
    fi
    log "All runs drained."
  fi
else
  log "No active runs — proceeding."
fi

# ---------------------------------------------------------------------------
# Step 4: Sync source from origin/main (safe — no git reset --hard)
#
# NEVER use git reset --hard on the prod checkout.
# Use git checkout origin/main -- <path> to update tracked files only.
# Untracked runtime files (data/, .env, workspace.md, contexts/) are untouched.
# ---------------------------------------------------------------------------
SYNC_PATHS="apps/api apps/mcp workers docs"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would sync paths from origin/main: $SYNC_PATHS"
else
  log "Syncing source from origin/main..."
  git checkout origin/main -- $SYNC_PATHS
  log "Source sync complete."
fi

# ---------------------------------------------------------------------------
# Step 5: Clean failed-patch cruft
# ---------------------------------------------------------------------------
CRUFT_COUNT=0
if [[ $DRY_RUN -eq 1 ]]; then
  CRUFT_COUNT="$(find apps/ -name '*.rej' -o -name '*.bak' 2>/dev/null | wc -l | tr -d ' ')"
  log "DRY-RUN: would remove $CRUFT_COUNT .rej/.bak files under apps/"
else
  while IFS= read -r f; do
    rm -f "$f"
    CRUFT_COUNT=$((CRUFT_COUNT + 1))
  done < <(find apps/ -name '*.rej' -o -name '*.bak' 2>/dev/null || true)
  if [[ $CRUFT_COUNT -gt 0 ]]; then
    log "Removed $CRUFT_COUNT .rej/.bak patch cruft files."
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Install API dependencies into the actual service venv
# ---------------------------------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would install API dependencies: $SERVICE_VENV/bin/python -m pip install -r $API_REQUIREMENTS"
else
  [[ -x "$SERVICE_VENV/bin/python" ]] || fail "Service venv Python not found or not executable: $SERVICE_VENV/bin/python"
  [[ -f "$API_REQUIREMENTS" ]] || fail "API requirements file not found: $API_REQUIREMENTS"
  log "Installing API dependencies from $API_REQUIREMENTS into $SERVICE_VENV..."
  "$SERVICE_VENV/bin/python" -m pip install -r "$API_REQUIREMENTS"
  "$SERVICE_VENV/bin/python" -m pip check
  log "API dependencies installed and verified."
fi

# ---------------------------------------------------------------------------
# Step 7: Restart service
# ---------------------------------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would run: systemctl restart $SERVICE_NAME"
else
  log "Restarting $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"
  log "Service restart issued."
fi

# ---------------------------------------------------------------------------
# Step 8: Wait for /health to return ok
# ---------------------------------------------------------------------------
log "Polling ${API_BASE}/health (timeout: ${HEALTH_TIMEOUT}s)..."
ELAPSED=0
HEALTH_OK=0

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would poll /health until ok"
  HEALTH_OK=1
else
  while [[ $ELAPSED -lt $HEALTH_TIMEOUT ]]; do
    if HTTP_BODY="$(curl -sf --max-time 3 "${API_BASE}/health" 2>/dev/null)"; then
      STATUS="$(echo "$HTTP_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")"
      if [[ "$STATUS" == "ok" ]]; then
        HEALTH_OK=1
        log "Health check passed (status=ok) after ${ELAPSED}s"
        break
      else
        log "  ${ELAPSED}s — /health returned status=${STATUS:-unknown}, waiting..."
      fi
    fi
    sleep $HEALTH_POLL_INTERVAL
    ELAPSED=$((ELAPSED + HEALTH_POLL_INTERVAL))
  done
fi

if [[ $HEALTH_OK -ne 1 ]]; then
  fail "Service did not become healthy within ${HEALTH_TIMEOUT}s. Check: journalctl -u ${SERVICE_NAME} -n 50"
fi

# ---------------------------------------------------------------------------
# Step 9: Assert key endpoints return expected HTTP codes
#
# These endpoints are auth-exempt (/health, /healthz) or require the secret.
# We test /health and /healthz without auth, then read FLOOM_SECRET from
# the env file to test authenticated endpoints.
# ---------------------------------------------------------------------------
log "Asserting key endpoints..."

check_endpoint() {
  local method="$1"
  local path="$2"
  local expected_code="$3"
  shift 3
  local -a extra_flags=("$@")
  local url="${API_BASE}${path}"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN: would assert $method $path = HTTP $expected_code"
    return
  fi

  actual_code="$(curl -sS -o /dev/null -w "%{http_code}" -X "$method" --max-time 5 "${extra_flags[@]}" "$url" 2>/dev/null || echo "000")"
  if [[ "$actual_code" == "$expected_code" ]]; then
    log "  OK  $method $path → $actual_code"
  else
    fail "Endpoint assertion failed: $method $path expected HTTP $expected_code, got $actual_code"
  fi
}

# Read FLOOM_SECRET from the env file (it's not in our environment)
FLOOM_SECRET=""
ENV_FILE="/etc/workeros/api.env"
if [[ -f "$ENV_FILE" ]]; then
  FLOOM_SECRET="$(grep '^FLOOM_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | head -1)"
fi

AUTH_FLAGS=()
if [[ -n "$FLOOM_SECRET" ]]; then
  AUTH_FLAGS=(-H "x-floom-secret: ${FLOOM_SECRET}")
fi

# Auth-exempt endpoints (no secret needed)
check_endpoint GET /healthz 200
check_endpoint GET /health 200

if [[ -z "$FLOOM_SECRET" ]]; then
  warn "FLOOM_SECRET not found in $ENV_FILE — skipping authenticated endpoint checks"
else
  # Authenticated endpoints
  check_endpoint GET /workspace     200 "${AUTH_FLAGS[@]}"
  check_endpoint GET /conversations 200 "${AUTH_FLAGS[@]}"
  check_endpoint GET /approvals     200 "${AUTH_FLAGS[@]}"
  check_endpoint GET /workers       200 "${AUTH_FLAGS[@]}"
fi

# ---------------------------------------------------------------------------
# Step 10: Schema drift check
# ---------------------------------------------------------------------------
SCHEMA_CHECK_SCRIPT="$WORKEROS_ROOT/ops/verify-schema.py"
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would run: python3 $SCHEMA_CHECK_SCRIPT"
elif [[ -f "$SCHEMA_CHECK_SCRIPT" ]]; then
  log "Running schema drift check..."
  if ! python3 "$SCHEMA_CHECK_SCRIPT" "$RESOLVED_DB"; then
    fail "Schema drift detected — see output above. Roll back with: sqlite3 $RESOLVED_DB < BACKUP or restore $BACKUP_FILE"
  fi
  log "Schema drift check passed."
else
  warn "ops/verify-schema.py not found — skipping schema drift check"
fi

# ---------------------------------------------------------------------------
# Step 11: Live route smoke gate
# ---------------------------------------------------------------------------
SMOKE_SCRIPT="$WORKEROS_ROOT/ops/smoke-routes.sh"
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: would run hard post-deploy smoke gate: bash $SMOKE_SCRIPT"
elif [[ -f "$SMOKE_SCRIPT" ]]; then
  log "Running hard post-deploy smoke gate..."
  bash "$SMOKE_SCRIPT"
  log "Hard post-deploy smoke gate passed."
else
  fail "Smoke gate script missing: $SMOKE_SCRIPT"
fi

# ---------------------------------------------------------------------------
# Step 12: Print summary
# ---------------------------------------------------------------------------
log ""
log "=== DEPLOY SUCCESS ==="
log "  Deployed SHA:        $TARGET_SHA"
log "  Service:             $SERVICE_NAME"
log "  Service venv:        $SERVICE_VENV"
log "  Requirements:        $API_REQUIREMENTS"
log "  DB backup:           ${BACKUP_FILE:-DRY-RUN}"
log "  Health:              ok"
DEPLOYED_VERSION="$(sqlite3 "$RESOLVED_DB" "SELECT MAX(version) FROM schema_version;" 2>/dev/null || echo "unknown")"
log "  Migration version:   $DEPLOYED_VERSION"
log ""
log "To roll back DB: sqlite3 $RESOLVED_DB \".restore '$BACKUP_FILE'\""
log "To check logs:   journalctl -u $SERVICE_NAME -n 100 -f"
