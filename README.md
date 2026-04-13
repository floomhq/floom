# Floom

**Infra for agentic work.**

One manifest, four surfaces. Any CLI, MCP server, or Python library becomes a chat, a tool call, and an HTTP endpoint in 10 seconds.

## What's in this repo

- `apps/web` — the Floom.dev chat UI
- `apps/server` — backend (Hono + SQLite + Docker runner)
- `packages/runtime` — `@floom/runtime`, the e2b-backed execution layer
- `packages/cli` — `@floom/cli`, the command-line tool
- `packages/detect` — `@floom/detect`, auto-detect rules for runtimes and build systems
- `packages/manifest` — `@floom/manifest`, manifest schema and parser
- `spec/protocol.md` — the Floom Protocol spec
- `examples/*` — example manifests for the 15 launch apps

## Install

```bash
npm install -g @floom/cli
floom deploy owner/repo
```

## The manifest

```yaml
name: flyfast
runtime: python3.12
build: pip install .
run: python -m flyfast.search "${query}"
inputs:
  - name: query
    type: string
    required: true
```

Read the full spec: [`spec/protocol.md`](spec/protocol.md)

## Development

```bash
pnpm install
pnpm dev
```

## License

MIT © 2026 Federico De Ponte
