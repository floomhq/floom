#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
SHARE_TOKEN="${SHARE_TOKEN:-}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

check_status() {
  local path="$1"
  local expected="${2:-200}"
  local code
  code="$(curl -sS -o "$tmp_dir/body" -w "%{http_code}" "${BASE_URL}${path}")"
  if [[ "$code" != "$expected" ]]; then
    printf 'route smoke failed: %s returned %s, expected %s\n' "$path" "$code" "$expected" >&2
    return 1
  fi
  printf 'ok %s %s\n' "$code" "$path"
}

check_status_any() {
  local path="$1"
  shift
  local code
  code="$(curl -sS -o "$tmp_dir/body" -w "%{http_code}" "${BASE_URL}${path}")"
  for expected in "$@"; do
    if [[ "$code" == "$expected" ]]; then
      printf 'ok %s %s\n' "$code" "$path"
      return 0
    fi
  done
  printf 'route smoke failed: %s returned %s, expected one of %s\n' "$path" "$code" "$*" >&2
  return 1
}

check_header() {
  local path="$1"
  local header_name="$2"
  local expected="$3"
  local headers
  headers="$tmp_dir/headers"
  curl -sS -D "$headers" -o "$tmp_dir/body" "${BASE_URL}${path}" >/dev/null
  if ! awk -v name="$header_name" -v expected="$expected" '
    BEGIN { found = 0 }
    tolower($0) ~ "^" tolower(name) ":" {
      value = $0
      sub("^[^:]+:[[:space:]]*", "", value)
      sub("\r$", "", value)
      if (tolower(value) == tolower(expected)) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$headers"; then
    printf 'route smoke failed: %s missing %s: %s\n' "$path" "$header_name" "$expected" >&2
    return 1
  fi
  printf 'ok header %s %s\n' "$header_name" "$path"
}

check_status_any "/" 200 307
check_status_any "/workers" 200 307
check_status_any "/contexts" 200 307
check_status "/login"

if [[ -n "$SHARE_TOKEN" ]]; then
  check_status "/s/${SHARE_TOKEN}"
  check_header "/s/${SHARE_TOKEN}" "x-robots-tag" "noindex, nofollow"
else
  printf 'skip /s token smoke: set SHARE_TOKEN to check a standalone share page\n'
fi
