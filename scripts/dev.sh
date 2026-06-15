#!/usr/bin/env bash
# Start the backend (apps/api) and frontend (apps/web) together.
# Press Ctrl+C once to stop both. Run ./scripts/setup.sh first.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "$ROOT/apps/api/venv/bin/python" ]; then
  echo "error: backend venv missing — run ./scripts/setup.sh first" >&2
  exit 1
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "stopping..."
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "==> backend  -> http://localhost:8000"
( cd "$ROOT/apps/api" && exec ./venv/bin/python main.py ) &
pids+=($!)

echo "==> frontend -> http://localhost:3000"
( cd "$ROOT/apps/web" && exec npm run dev ) &
pids+=($!)

echo "Both running. Press Ctrl+C to stop."
# Exit (and trigger cleanup) as soon as either process dies.
wait -n 2>/dev/null || wait
