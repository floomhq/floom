#!/usr/bin/env bash
# floom-run.sh — run a Floom app by slug, passing JSON inputs.
#
# Usage:
#   floom run <slug>                        run with no inputs (empty object)
#   floom run <slug> '{"key":"value"}'      run with JSON body
#   floom run <slug> --input key=value      run with key=value pairs
#   floom run --help                        show this help

set -euo pipefail

_SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
LIB_DIR="$(cd "$(dirname "$_SCRIPT_PATH")" && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || -z "${1:-}" ]]; then
  cat <<EOF
floom run — run a Floom app.

usage:
  floom run <slug>                    run app with no inputs
  floom run <slug> '<json>'           run app with JSON body
  floom run <slug> --input key=val    run app with key=value pairs (repeatable)

examples:
  floom run uuid
  floom run competitor-lens '{"you":"stripe.com","rival":"adyen.com"}'
  floom run ai-readiness-audit --input url=https://stripe.com

EOF
  [[ -z "${1:-}" ]] && exit 1
  exit 0
fi

SLUG="$1"
shift

# Parse remaining args: either a raw JSON string, or --input key=value pairs
BODY="{}"
INPUT_PAIRS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      bash "$0" --help
      exit 0 ;;
    --input)
      shift
      INPUT_PAIRS+=("$1")
      shift ;;
    --input=*)
      INPUT_PAIRS+=("${1#--input=}")
      shift ;;
    *)
      # Treat as raw JSON body
      BODY="$1"
      shift ;;
  esac
done

# Build JSON from --input key=value pairs if any were provided
if [[ ${#INPUT_PAIRS[@]} -gt 0 ]]; then
  BODY=$(python3 - "${INPUT_PAIRS[@]}" <<'PY'
import json, sys
pairs = sys.argv[1:]
d = {}
for p in pairs:
    k, _, v = p.partition('=')
    d[k.strip()] = v.strip()
print(json.dumps(d))
PY
)
fi

exec bash "$LIB_DIR/floom-api.sh" POST "/api/${SLUG}/run" "$BODY"
