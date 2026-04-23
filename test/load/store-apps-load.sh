#!/usr/bin/env bash
# Launch-hardening 2026-04-23: load test for the 3 hero public-runnable
# store apps on floom.dev (lead-scorer, competitor-analyzer,
# resume-screener). Run BEFORE merging to main; attach the output to
# the PR body.
#
# Target: <1% error rate, p95 < 30s. Anonymous-mode hits go through the
# BYOK gate (5 free runs per IP per 24h) then return 402 — that's
# expected and counted as "gated" rather than "error".
#
# What it does:
#   - For each slug, posts a single JSON body (valid inputs including
#     a bundled file envelope where required) to `/api/<slug>/run`.
#   - Drives 50 concurrent VUs for 60s using `hey` (preferred) or
#     falls back to a Bash parallel loop with curl when `hey` isn't
#     available on the host.
#   - Prints p50/p95/p99 + error rate per app.
#
# Usage:
#   BASE=http://127.0.0.1:8787 bash test/load/store-apps-load.sh
#   BASE=https://floom-preview.onrender.com COOKIE="floom.session_token=..." \
#     bash test/load/store-apps-load.sh
#
# CAUTION: Do NOT aim this at production floom.dev. Use a preview
# deploy or a local dev server.

set -u

BASE="${BASE:-http://127.0.0.1:8787}"
DURATION="${DURATION:-60s}"
CONCURRENCY="${CONCURRENCY:-50}"
COOKIE="${COOKIE:-}"
OUT_DIR="${OUT_DIR:-/tmp/floom-store-load}"

mkdir -p "$OUT_DIR"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_BODIES="$OUT_DIR/bodies"
mkdir -p "$TMP_BODIES"

HAS_HEY=0
if command -v hey >/dev/null 2>&1; then
  HAS_HEY=1
else
  echo "(!) 'hey' not found on PATH — will fall back to a curl-parallel loop."
  echo "    Install: brew install hey  # macOS"
  echo "             go install github.com/rakyll/hey@latest  # Linux"
fi

# ---------------------------------------------------------------------------
# Build JSON bodies once (each slug gets a file at $TMP_BODIES/<slug>.json).
# ---------------------------------------------------------------------------

node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[1];
const OUT = process.argv[2];

function b64(buf) { return Buffer.from(buf).toString("base64"); }

function envelope(name, mime, bytes) {
  return { __file: true, name, mime_type: mime, size: bytes.length, content_b64: b64(bytes) };
}

const csv = "company,website,industry,country\nStripe,stripe.com,fintech,US\nMonzo,monzo.com,fintech,UK\nRevolut,revolut.com,fintech,UK\nN26,n26.com,fintech,DE\nBrex,brex.com,fintech,US\n";

const zipPath = path.resolve(ROOT, "examples/resume-screener/sample-cvs/cvs.zip");
const zipBytes = readFileSync(zipPath);

const bodies = {
  "lead-scorer": {
    action: "score",
    inputs: {
      data: envelope("leads.csv", "text/csv", Buffer.from(csv)),
      icp: "B2B SaaS CFOs at fintechs in EU."
    }
  },
  "competitor-analyzer": {
    action: "analyze",
    inputs: {
      urls: ["https://linear.app", "https://notion.so", "https://asana.com"],
      your_product: "B2B sales automation software for EU mid-market teams."
    }
  },
  "resume-screener": {
    action: "screen",
    inputs: {
      cvs_zip: envelope("sample-cvs.zip", "application/zip", zipBytes),
      job_description: "Senior Backend Engineer (Remote EU). 5+ years Python. Postgres, FastAPI, Redis, AWS.",
      must_haves: "5+ years Python\nProduction Postgres experience"
    }
  }
};

for (const [slug, body] of Object.entries(bodies)) {
  writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify(body));
}
' "$ROOT" "$TMP_BODIES"

echo "Load test target: $BASE"
echo "  VUs=$CONCURRENCY duration=$DURATION"
echo "  cookie=$([ -n "$COOKIE" ] && echo set || echo '(anonymous)')"
echo

# ---------------------------------------------------------------------------
# Per-slug driver.
# ---------------------------------------------------------------------------

run_with_hey() {
  local slug="$1"
  local body="$TMP_BODIES/$slug.json"
  local out="$OUT_DIR/$slug.hey.txt"
  local args=(-z "$DURATION" -c "$CONCURRENCY" -m POST -T "application/json" -D "$body")
  [ -n "$COOKIE" ] && args+=(-H "cookie: $COOKIE")
  # `hey` buffers all response bodies; pipe stderr to silence its "error"
  # messages for BYOK-gated 402 responses (they're expected).
  hey "${args[@]}" "$BASE/api/$slug/run" >"$out" 2>&1 || true
  echo "=== $slug ==="
  # Extract the interesting lines from hey's summary.
  grep -E "Requests/sec|Total:|Slowest:|Fastest:|Average:|Status code distribution|^\s+\[[0-9]+\]" "$out" \
    || cat "$out"
  # Latency distribution block.
  grep -A 10 "Latency distribution" "$out" || true
  echo
}

run_with_curl_parallel() {
  local slug="$1"
  local body="$TMP_BODIES/$slug.json"
  local out="$OUT_DIR/$slug.curl.txt"
  : >"$out"
  local end=$(( $(date +%s) + 60 ))
  # Launch $CONCURRENCY curl workers in a loop until DURATION is up.
  spawn_one() {
    while [ "$(date +%s)" -lt "$end" ]; do
      local t0 t1 code
      t0=$(date +%s%N)
      code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST -H "content-type: application/json" \
        ${COOKIE:+-H "cookie: $COOKIE"} \
        --data-binary "@$body" "$BASE/api/$slug/run" || echo "000")
      t1=$(date +%s%N)
      echo "$code $(( (t1 - t0) / 1000000 ))" >>"$out"
    done
  }
  local pids=()
  for _ in $(seq 1 "$CONCURRENCY"); do spawn_one & pids+=("$!"); done
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
  local total ok gated err
  total=$(wc -l <"$out" | tr -d ' ')
  ok=$(awk '$1 ~ /^20[0-2]$/ {n++} END{print n+0}' "$out")
  gated=$(awk '$1 == 402 || $1 == 429 {n++} END{print n+0}' "$out")
  err=$(awk '$1 ~ /^5/ || $1 == "000" {n++} END{print n+0}' "$out")
  echo "=== $slug ==="
  echo "  total=$total  2xx=$ok  gated(402/429)=$gated  5xx/conn-err=$err"
  # Percentiles over latency (column 2).
  awk '{print $2}' "$out" | sort -n | awk '{
    a[NR]=$1
  } END{
    if (NR == 0) { print "  (no samples)"; exit }
    p50=a[int(NR*0.50)]; p95=a[int(NR*0.95)]; p99=a[int(NR*0.99)];
    printf "  p50=%sms  p95=%sms  p99=%sms  (N=%d)\n", p50, p95, p99, NR
  }'
  echo
}

# ---------------------------------------------------------------------------
# Drive all 3 slugs sequentially (keeps each slug honest on its own
# percentiles — if we drove them concurrently we'd only get a blended
# load number and couldn't attribute a regression).
# ---------------------------------------------------------------------------

for slug in lead-scorer competitor-analyzer resume-screener; do
  if [ "$HAS_HEY" -eq 1 ]; then
    run_with_hey "$slug"
  else
    run_with_curl_parallel "$slug"
  fi
done

echo
echo "Raw output saved under $OUT_DIR/"
echo "Target: <1% 5xx rate, p95 < 30s per app."
