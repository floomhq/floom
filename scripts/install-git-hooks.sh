#!/usr/bin/env bash
# install-git-hooks.sh
#
# Installs repo-level git hooks into .git/hooks/.
# .git/hooks/ is NOT tracked by git, so each contributor must run this once
# after cloning.
#
# Idempotent — safe to re-run.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_dir="$repo_root/.git/hooks"

install_hook() {
  local name="$1"
  local body="$2"
  local target="$hooks_dir/$name"

  if [[ -f "$target" ]] && ! grep -q "floom-managed-hook" "$target" 2>/dev/null; then
    echo "WARN: $name already exists and is not managed by Floom. Leaving alone."
    echo "      To install the Floom hook, move your existing $target aside."
    return 0
  fi

  printf '%s\n' "$body" > "$target"
  chmod +x "$target"
  echo "Installed: $target"
}

install_hook pre-commit "$(cat <<'EOF'
#!/usr/bin/env bash
# floom-managed-hook
# Runs boundary check on staged files. See scripts/check-no-internal-docs.sh.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
bash "$repo_root/scripts/check-no-internal-docs.sh" pre-commit
EOF
)"

echo "Done. Boundary hook is now active."
