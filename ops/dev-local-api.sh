#!/usr/bin/env bash
# Start the cloud FastAPI locally on 127.0.0.1:8000 for dashboard dev.
# Usage: bash ops/dev-local-api.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f web/.env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source web/.env.local
  set +a
elif [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export WORKEROS_DEV="${WORKEROS_DEV:-1}"
export WORKEROS_ROLE="${WORKEROS_ROLE:-web}"
export WORKEROS_API_BASE="${WORKEROS_API_BASE:-http://127.0.0.1:8000}"
export WORKEROS_COOKIE_DOMAIN="${WORKEROS_COOKIE_DOMAIN:-none}"
export WORKEROS_OAUTH_CALLBACK_BASE="${WORKEROS_OAUTH_CALLBACK_BASE:-http://localhost:3000/app/api/proxy}"
export WORKERS_FRONTEND_URL="${WORKERS_FRONTEND_URL:-http://localhost:3000/app}"
export WORKEROS_DASHBOARD_ORIGIN="${WORKEROS_DASHBOARD_ORIGIN:-http://localhost:3000}"
export WORKEROS_ALLOWED_FRONTEND_ORIGINS="${WORKEROS_ALLOWED_FRONTEND_ORIGINS:-http://localhost:3000}"

cd "$ROOT"
export PYTHONPATH="$ROOT"

VENV="$ROOT/.venv"
if [[ ! -d "$VENV" ]]; then
  /usr/local/bin/python3.12 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r apps/api/requirements.txt
fi

exec "$VENV/bin/python" -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8000 --reload
