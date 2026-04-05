#!/bin/bash
# Local dev installer — installs the floom skill from this repo and configures dev environment
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$HOME/.claude/skills/floom"
CONFIG_FILE="$HOME/.claude/floom-config.json"
ENV_FILE="$SCRIPT_DIR/.env.local"

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
cp "$SCRIPT_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "  Copied skill/SKILL.md -> $SKILL_DIR/SKILL.md"

# Write dev config (preserves existing api_key if present)
if [ -f "$CONFIG_FILE" ]; then
  EXISTING_KEY=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('api_key',''))" 2>/dev/null || true)
  if [ -n "$EXISTING_KEY" ]; then
    python3 -c "
import json
cfg = json.load(open('$CONFIG_FILE'))
cfg['platform_url'] = '$PLATFORM_URL'
json.dump(cfg, open('$CONFIG_FILE', 'w'), indent=2)
print('\n')
"
    echo "  Updated platform_url -> $PLATFORM_URL (kept existing api_key)"
  else
    echo "{\"api_key\": \"\", \"platform_url\": \"$PLATFORM_URL\"}" | python3 -c "import sys,json; json.dump(json.load(sys.stdin), open('$CONFIG_FILE','w'), indent=2)"
    echo "  Wrote config (no api_key found — add one from the app)"
  fi
else
  echo "{\"api_key\": \"\", \"platform_url\": \"$PLATFORM_URL\"}" | python3 -c "import sys,json; json.dump(json.load(sys.stdin), open('$CONFIG_FILE','w'), indent=2)"
  echo "  Created config (add your api_key from the app)"
fi

echo ""
echo "Done! Dev environment configured:"
echo "  Skill:  $SKILL_DIR/SKILL.md"
echo "  Config: $CONFIG_FILE"
echo "  API:    $PLATFORM_URL"
echo ""
echo "Next: open Claude Code and type /floom"
