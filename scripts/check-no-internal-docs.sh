#!/usr/bin/env bash
# check-no-internal-docs.sh
#
# Enforces the Floom public/internal repo boundary:
# strategy docs, private backlogs, stash dumps, interview notes, GTM plans,
# and other internal-only material must live in `floomhq/floom-internal`,
# NEVER in this public `floomhq/floom` repo.
#
# Runs in two contexts:
#   1. As a pre-commit hook: checks staged files
#   2. In CI: checks the full tree for forbidden paths
#
# Exit 0 = clean. Exit 1 = forbidden paths found (block the commit/build).
#
# Forbidden top-level paths:
#   docs/internal/              — see CLAUDE.md "Floom Repo Boundary"
#   internal/                   — any internal-material directory at repo root
#
# History: added 2026-04-23 after the P0-2 leak (commit 0b8ffcc3) where
# 17,767 lines of local stash dumps were pushed under docs/internal/.

set -euo pipefail

MODE="${1:-ci}"   # "pre-commit" | "ci"

FORBIDDEN_PATTERNS=(
  "^docs/internal/"
  "^internal/"
)

violations=()

if [[ "$MODE" == "pre-commit" ]]; then
  # Only look at staged-for-commit files (added, copied, modified, renamed)
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
else
  # CI mode: check the entire tracked tree
  mapfile -t files < <(git ls-files)
fi

for file in "${files[@]}"; do
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if [[ "$file" =~ $pattern ]]; then
      violations+=("$file")
      break
    fi
  done
done

if [[ ${#violations[@]} -gt 0 ]]; then
  cat >&2 <<EOF
ERROR: forbidden path(s) detected in the public repo floomhq/floom.

Internal content (strategy, GTM, user interviews, stash dumps, private backlogs)
must live in floomhq/floom-internal, not here. See CLAUDE.md "Floom Repo Boundary".

Offending files:
EOF
  for v in "${violations[@]}"; do
    echo "  - $v" >&2
  done
  cat >&2 <<EOF

Fix:
  - Move the file(s) to floomhq/floom-internal
  - Remove from this commit:  git restore --staged <file> && rm -rf <file>
  - If the file MUST be public, rename it out of docs/internal/ or internal/

EOF
  exit 1
fi

if [[ "$MODE" == "ci" ]]; then
  echo "check-no-internal-docs: clean (no forbidden paths)"
fi
