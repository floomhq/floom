#!/bin/bash
# Uninstall floom skill and config from this machine
set -e

SKILL_DIR="$HOME/.claude/skills/floom"
CONFIG_FILE="$HOME/.claude/floom-config.json"
TMP_DEPLOY="/tmp/floom-deploy"
TMP_LOG="/tmp/floom-dev.log"

removed=0

for target in "$SKILL_DIR" "$CONFIG_FILE" "$TMP_DEPLOY" "$TMP_LOG"; do
  if [ -e "$target" ]; then
    rm -rf "$target"
    echo "Removed $target"
    removed=$((removed + 1))
  fi
done

if [ "$removed" -eq 0 ]; then
  echo "Nothing to clean up — floom is not installed."
else
  echo ""
  echo "Done! Removed $removed item(s)."
fi
