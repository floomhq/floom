#!/usr/bin/env bash
# One-time setup: backend venv + dependencies, frontend dependencies, .env scaffold.
# Safe to re-run — never overwrites an existing apps/api/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. Pick a Python interpreter (3.11+ required).
PY=""
for cand in python3.12 python3.11 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[ -n "$PY" ] || { echo "error: Python 3.11+ not found on PATH" >&2; exit 1; }

echo "==> backend: creating venv with $PY"
cd "$ROOT/apps/api"
"$PY" -m venv venv
./venv/bin/python -m pip install --quiet --upgrade pip
echo "==> backend: installing requirements (this takes a few minutes)"
./venv/bin/python -m pip install --quiet -r requirements.txt

# 2. Scaffold apps/api/.env from the example (never clobber an existing one).
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> backend: created apps/api/.env — add OPENAI_API_KEY + E2B_API_KEY (or Bedrock keys)"
else
  echo "==> backend: apps/api/.env already exists — left untouched"
fi

# 3. Frontend dependencies.
echo "==> frontend: npm install"
cd "$ROOT/apps/web"
npm install

echo
echo "Setup complete. Edit apps/api/.env with your keys, then run:  ./scripts/dev.sh"
