# Floom

Deploy Python scripts as cloud automations. No infra, no Docker, no YAML. Just use this skill, get a shareable web UI with scheduling, managed secrets, and execution history.

## Install (Claude Code)

```bash
git clone https://github.com/floom-dev/floom.git ~/.claude/skills/floom
cd ~/.claude/skills/floom && ./setup
```

Setup will ask for your API key — get it from [dashboard.floom.dev/settings](https://dashboard.floom.dev/settings).

Then type `/floom` in Claude Code to deploy your first script.

## What it does

- Adapts your Python script to a cloud-ready format
- Tests it in a secure sandbox before deploying
- Gives you a shareable URL where your agents or coworkers can run it
- Manages secrets, scheduling, and version history
