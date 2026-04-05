# Floom

Deploy Python scripts as cloud automations. No infra, no Docker, no YAML. Get a shareable web UI with scheduling, managed secrets, and execution history.

## Installation

Requirements: Claude Code, Git

```bash
git clone https://github.com/floomhq/floom.git ~/.claude/skills/floom-repo && ~/.claude/skills/floom-repo/scripts/setup
```

Setup symlinks the `/floom` skill into Claude Code. Get your API key from [dashboard.floom.dev/settings](https://dashboard.floom.dev/settings) — the skill will ask for it on first use.

## Quick Start

1. Type `/floom` in Claude Code
2. Point it at any Python script
3. It adapts, tests in a sandbox, and deploys

## What You Get

- Cloud-deployed Python script with a shareable URL
- Typed inputs and outputs with a web UI
- Scheduling, managed secrets, and version history
- Secure sandbox testing before every deploy
