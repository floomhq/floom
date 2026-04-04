#!/bin/bash
# Floom installer — installs the floom skill into Claude Code

set -e

PLATFORM_URL="${1:-https://dashboard.floom.dev}"
SKILL_DIR="$HOME/.claude/skills/floom"
CONFIG_FILE="$HOME/.claude/floom-config.json"

echo "Installing floom from $PLATFORM_URL..."

mkdir -p "$SKILL_DIR"

curl -sL "$PLATFORM_URL/api/skill" -o "$SKILL_DIR/SKILL.md"

# Update platform_url in existing config to match the install source
if [ -f "$CONFIG_FILE" ]; then
  CURRENT_URL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('platform_url',''))" 2>/dev/null || true)
  if [ -n "$CURRENT_URL" ] && [ "$CURRENT_URL" != "$PLATFORM_URL" ]; then
    python3 -c "
import json
cfg = json.load(open('$CONFIG_FILE'))
cfg['platform_url'] = '$PLATFORM_URL'
json.dump(cfg, open('$CONFIG_FILE', 'w'), indent=2)
"
    echo "✓ Updated platform_url in config: $CURRENT_URL → $PLATFORM_URL"
  fi
fi

echo ""
echo "✓ floom installed at $SKILL_DIR/SKILL.md"
echo ""
echo "Next steps:"
echo "  1. Open Claude Code in any project"
echo "  2. Get your API key from $PLATFORM_URL/settings"
echo "  3. Type /floom to get started"
