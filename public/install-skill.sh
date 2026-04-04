#!/bin/bash
# Floom installer — installs the floom skill into Claude Code

set -e

PLATFORM_URL="${1:-https://yourplatform.com}"
SKILL_DIR="$HOME/.claude/skills/floom"

echo "Installing floom from $PLATFORM_URL..."

mkdir -p "$SKILL_DIR"

curl -sL "$PLATFORM_URL/api/skill" -o "$SKILL_DIR/SKILL.md"

echo ""
echo "✓ floom installed at $SKILL_DIR/SKILL.md"
echo ""
echo "Next steps:"
echo "  1. Open Claude Code in any project"
echo "  2. Get your API key from $PLATFORM_URL/settings"
echo "  3. Type /floom to get started"
