#!/bin/bash
# Local dev installer — installs the floom skill from this repo and configures dev environment
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$HOME/.claude/skills/floom"
CONFIG_FILE="$HOME/.claude/floom-config.json"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

PLATFORM_URL=$(grep '^NEXT_PUBLIC_CONVEX_SITE_URL=' "$ENV_FILE" | cut -d'=' -f2-)
if [ -z "$PLATFORM_URL" ]; then
  echo "Error: NEXT_PUBLIC_CONVEX_SITE_URL not set in .env.local"
  exit 1
fi

echo "Installing floom skill (local dev)..."

# Install skill from local source
mkdir -p "$SKILL_DIR"
cp "$REPO_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "  Copied skill/SKILL.md -> $SKILL_DIR/SKILL.md"

# Load api_key from .env.local
FLOOM_DEV_AGENT_KEY=$(grep '^FLOOM_DEV_AGENT_KEY=' "$ENV_FILE" | cut -d'=' -f2-)
if [ -z "$FLOOM_DEV_AGENT_KEY" ]; then
  echo "Error: FLOOM_DEV_AGENT_KEY not set in .env.local"
  exit 1
fi

# Write dev config
echo "{\"api_key\": \"$FLOOM_DEV_AGENT_KEY\", \"platform_url\": \"$PLATFORM_URL\"}" | python3 -c "import sys,json; json.dump(json.load(sys.stdin), open('$CONFIG_FILE','w'), indent=2)"
echo "  Wrote config (api_key from .env.local, platform_url: $PLATFORM_URL)"

echo ""
echo "Done! Dev environment configured:"
echo "  Skill:  $SKILL_DIR/SKILL.md"
echo "  Config: $CONFIG_FILE"
echo "  API:    $PLATFORM_URL"
echo ""
echo "Next: open Claude Code and type /floom"
