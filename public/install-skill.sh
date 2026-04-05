#!/bin/bash
# Floom installer — clones the repo and runs setup
set -e

SKILL_REPO="https://github.com/floom-dev/floom.git"
CLONE_DIR="$HOME/.claude/skills/floom-repo"

echo "Installing floom..."

if [ -d "$CLONE_DIR" ]; then
  echo "Updating existing installation..."
  git -C "$CLONE_DIR" pull --ff-only
else
  git clone "$SKILL_REPO" "$CLONE_DIR"
fi

exec "$CLONE_DIR/scripts/setup"
