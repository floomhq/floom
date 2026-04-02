#!/bin/bash
# Deploy Skill installer — installs the deploy-skill into Claude Code

set -e

PLATFORM_URL="${1:-https://yourplatform.com}"
SKILL_DIR="$HOME/.claude/skills/deploy-skill"

echo "Installing deploy-skill from $PLATFORM_URL..."

mkdir -p "$SKILL_DIR"

curl -s "$PLATFORM_URL/skill/SKILL.md" -o "$SKILL_DIR/SKILL.md"

echo ""
echo "✓ deploy-skill installed at $SKILL_DIR/SKILL.md"
echo ""
echo "Next steps:"
echo "  1. Open Claude Code in any project"
echo "  2. Get your API key from $PLATFORM_URL/settings"
echo "  3. Type /deploy-skill to get started"
