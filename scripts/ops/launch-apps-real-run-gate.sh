#!/usr/bin/env bash
# launch-apps-real-run-gate.sh
#
# Post-deploy guardrail for launch apps. For each launch slug, this script:
#   1) POSTs a real payload to /api/run
#   2) polls /api/run/:id until terminal
#   3) asserts status is success, dry_run=false, model != "dry-run"
#   4) asserts run latency stays under the API budget (30s default)
#
# Exit code:
#   0 -> all checks passed
#   1 -> at least one app failed verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BASE_URL="${BASE_URL:-http://127.0.0.1:3052}"
MAX_RUN_MS="${MAX_RUN_MS:-30000}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-500}"
POLL_TIMEOUT_MS="${POLL_TIMEOUT_MS:-35000}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --base-url <url>           Base URL (default: ${BASE_URL})
  --max-run-ms <ms>          Max allowed run time in ms (default: ${MAX_RUN_MS})
  --poll-interval-ms <ms>    Poll interval in ms (default: ${POLL_INTERVAL_MS})
  --poll-timeout-ms <ms>     Poll timeout in ms (default: ${POLL_TIMEOUT_MS})
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --max-run-ms)
      MAX_RUN_MS="$2"
      shift 2
      ;;
    --poll-interval-ms)
      POLL_INTERVAL_MS="$2"
      shift 2
      ;;
    --poll-timeout-ms)
      POLL_TIMEOUT_MS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[gate] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$MAX_RUN_MS" =~ ^[0-9]+$ ]] || [ "$MAX_RUN_MS" -le 0 ]; then
  echo "[gate] invalid --max-run-ms: ${MAX_RUN_MS}" >&2
  exit 2
fi
if ! [[ "$POLL_INTERVAL_MS" =~ ^[0-9]+$ ]] || [ "$POLL_INTERVAL_MS" -le 0 ]; then
  echo "[gate] invalid --poll-interval-ms: ${POLL_INTERVAL_MS}" >&2
  exit 2
fi
if ! [[ "$POLL_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$POLL_TIMEOUT_MS" -le 0 ]; then
  echo "[gate] invalid --poll-timeout-ms: ${POLL_TIMEOUT_MS}" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[gate] missing dependency: curl" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[gate] missing dependency: python3" >&2
  exit 2
fi

LEAD_SCORER_CSV=""
for candidate in \
  "${REPO_ROOT}/apps/web/public/examples/lead-scorer/sample-leads.csv" \
  "${REPO_ROOT}/examples/lead-scorer/test-input.csv"
do
  if [ -f "$candidate" ]; then
    LEAD_SCORER_CSV="$candidate"
    break
  fi
done
if [ -z "$LEAD_SCORER_CSV" ]; then
  echo "[gate] missing lead-scorer fixture CSV in repo" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
POST_RUN_URL="${BASE_URL}/api/run"

POLL_INTERVAL_SECONDS="$(python3 - "$POLL_INTERVAL_MS" <<'PY'
import sys
ms = int(sys.argv[1])
print(f"{ms / 1000:.3f}")
PY
)"

now_ms() {
  date +%s%3N
}

build_payload() {
  local slug="$1"
  python3 - "$slug" "$LEAD_SCORER_CSV" <<'PY'
import base64
import json
import pathlib
import sys

slug = sys.argv[1]
lead_csv_path = pathlib.Path(sys.argv[2])

if slug == "lead-scorer":
    raw = lead_csv_path.read_bytes()
    payload = {
        "app_slug": "lead-scorer",
        "action": "score",
        "inputs": {
            "data": {
                "__file": True,
                "name": "sample-leads.csv",
                "mime_type": "text/csv",
                "size": len(raw),
                "content_b64": base64.b64encode(raw).decode("ascii"),
            },
            "icp": (
                "B2B SaaS CFOs at 100-500 employee fintechs in EU. "
                "Looking for finance leaders at growth-stage companies with recent funding or hiring signals."
            ),
        },
    }
elif slug == "competitor-lens":
    payload = {
        "app_slug": "competitor-lens",
        "action": "analyze",
        "inputs": {
            "your_url": "https://floom.dev",
            "competitor_url": "https://n8n.io",
        },
    }
elif slug == "ai-readiness-audit":
    payload = {
        "app_slug": "ai-readiness-audit",
        "action": "audit",
        "inputs": {
            "company_url": "https://floom.dev/",
        },
    }
elif slug == "pitch-coach":
    payload = {
        "app_slug": "pitch-coach",
        "action": "coach",
        "inputs": {
            "pitch": "We are a platform for AI apps that helps teams ship faster",
        },
    }
else:
    raise SystemExit(f"unknown slug: {slug}")

print(json.dumps(payload, separators=(",", ":")))
PY
}

curl_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"

  local tmp_file
  tmp_file="$(mktemp)"
  local status

  if [ "$method" = "POST" ]; then
    status="$(curl -sS -o "$tmp_file" -w "%{http_code}" \
      --connect-timeout 5 --max-time 30 \
      -X POST \
      -H "content-type: application/json" \
      --data "$body" \
      "$url")"
  else
    status="$(curl -sS -o "$tmp_file" -w "%{http_code}" \
      --connect-timeout 5 --max-time 15 \
      "$url")"
  fi

  local response_body
  response_body="$(cat "$tmp_file")"
  rm -f "$tmp_file"

  printf '%s\n%s\n' "$status" "$response_body"
}

extract_run_id() {
  local body="$1"
  printf '%s' "$body" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
run_id = payload.get("run_id")
if not isinstance(run_id, str) or not run_id:
    raise SystemExit(1)
print(run_id)
'
}

assert_terminal_row() {
  local slug="$1"
  local wall_ms="$2"
  local row_json="$3"

  printf '%s' "$row_json" | python3 -c '
import json
import sys

slug = sys.argv[1]
wall_ms = int(sys.argv[2])
max_ms = int(sys.argv[3])
row = json.load(sys.stdin)

status = str(row.get("status") or "")
if status not in {"success", "succeeded"}:
    print(f"status={status}")
    raise SystemExit(1)

outputs = row.get("outputs")
if isinstance(outputs, str):
    try:
        outputs = json.loads(outputs)
    except Exception:
        outputs = None
if not isinstance(outputs, dict):
    print("outputs_missing_or_not_object")
    raise SystemExit(1)

meta = outputs.get("meta")
if not isinstance(meta, dict):
    meta = {}

dry_run = outputs.get("dry_run", meta.get("dry_run"))
model = outputs.get("model", meta.get("model"))

if dry_run is not False:
    print(f"dry_run_invalid={dry_run!r}")
    raise SystemExit(1)

if not isinstance(model, str) or not model.strip():
    print(f"model_invalid={model!r}")
    raise SystemExit(1)
if model.strip().lower() == "dry-run":
    print(f"model_invalid={model!r}")
    raise SystemExit(1)

duration_ms = row.get("duration_ms")
if isinstance(duration_ms, (int, float)) and duration_ms > max_ms:
    print(f"duration_ms_exceeded={duration_ms}")
    raise SystemExit(1)
if wall_ms > max_ms:
    print(f"wall_ms_exceeded={wall_ms}")
    raise SystemExit(1)

print(f"ok status={status} dry_run={dry_run} model={model} wall_ms={wall_ms} duration_ms={duration_ms}")
' "$slug" "$wall_ms" "$MAX_RUN_MS"
}

run_gate_for_slug() {
  local slug="$1"

  local payload
  payload="$(build_payload "$slug")"

  local started_ms
  started_ms="$(now_ms)"

  local post_resp post_status post_body
  post_resp="$(curl_json POST "$POST_RUN_URL" "$payload")"
  post_status="$(printf '%s\n' "$post_resp" | sed -n '1p')"
  post_body="$(printf '%s\n' "$post_resp" | sed -n '2,$p')"

  if [ "$post_status" != "200" ]; then
    echo "[gate] ${slug}: POST /api/run failed status=${post_status} body=${post_body}" >&2
    return 1
  fi

  local run_id
  if ! run_id="$(extract_run_id "$post_body")"; then
    echo "[gate] ${slug}: POST /api/run missing run_id body=${post_body}" >&2
    return 1
  fi

  local deadline_ms
  deadline_ms="$((started_ms + POLL_TIMEOUT_MS))"

  while true; do
    local now
    now="$(now_ms)"
    if [ "$now" -ge "$deadline_ms" ]; then
      echo "[gate] ${slug}: run ${run_id} timed out after ${POLL_TIMEOUT_MS}ms" >&2
      return 1
    fi

    local get_resp get_status row_json
    get_resp="$(curl_json GET "${BASE_URL}/api/run/${run_id}")"
    get_status="$(printf '%s\n' "$get_resp" | sed -n '1p')"
    row_json="$(printf '%s\n' "$get_resp" | sed -n '2,$p')"

    if [ "$get_status" != "200" ]; then
      echo "[gate] ${slug}: GET /api/run/${run_id} failed status=${get_status} body=${row_json}" >&2
      return 1
    fi

    local run_status
    if ! run_status="$(printf '%s' "$row_json" | python3 -c '
import json
import sys

row = json.load(sys.stdin)
print(str(row.get("status") or ""))
')"; then
      echo "[gate] ${slug}: invalid JSON in GET /api/run/${run_id}: ${row_json}" >&2
      return 1
    fi

    case "$run_status" in
      success|succeeded|error|failed|timeout)
        local wall_ms
        wall_ms="$(( $(now_ms) - started_ms ))"
        if result="$(assert_terminal_row "$slug" "$wall_ms" "$row_json")"; then
          echo "[gate] ${slug}: ${result}"
          return 0
        fi
        echo "[gate] ${slug}: terminal assertion failed (${result})" >&2
        return 1
        ;;
      pending|running)
        sleep "$POLL_INTERVAL_SECONDS"
        ;;
      *)
        echo "[gate] ${slug}: unexpected run status '${run_status}' run_id=${run_id}" >&2
        return 1
        ;;
    esac
  done
}

SLUGS=(
  lead-scorer
  competitor-lens
  ai-readiness-audit
  pitch-coach
)

echo "[gate] launch-apps real-run gate start base=${BASE_URL} max_run_ms=${MAX_RUN_MS}"

failed=0
for slug in "${SLUGS[@]}"; do
  echo "[gate] checking ${slug}"
  if ! run_gate_for_slug "$slug"; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "[gate] FAILED: one or more launch apps violated gate assertions" >&2
  exit 1
fi

echo "[gate] PASS: all launch apps returned non-dry-run results within budget"
exit 0
