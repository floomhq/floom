#!/usr/bin/env bash
# floom-status.sh — list the caller's apps and recent runs.

set -euo pipefail

_SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
LIB_DIR="$(cd "$(dirname "$_SCRIPT_PATH")" && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "floom status — list your apps and recent runs"
  exit 0
fi

echo "== your apps =="
bash "$LIB_DIR/floom-api.sh" GET /api/hub/mine || true

echo
echo "== recent runs =="
bash "$LIB_DIR/floom-api.sh" GET /api/me/runs?limit=10 || true
