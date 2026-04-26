# Floom docs

## Reference

- [Protocol spec](../spec/protocol.md) — the on-the-wire contracts a Floom server speaks (manifest, run, jobs, share, MCP, hub).
- [Adapter interfaces](../spec/adapters.md) — the five pluggable concerns (runtime, storage, auth, secrets, observability) a Floom server is built out of.
- [Self-host](./SELF_HOST.md) — running a full Floom instance via Docker.
- [Roadmap](./ROADMAP.md) — pre-1.0 priorities and what's shipped.
- [Rollback](./ROLLBACK.md) — rolling a deploy back to a previous tag.
- [Agent tokens quickstart](./agents/quickstart.md) — mint, use, revoke, scope, and rate-limit headless agent tokens.

## Product

- [Product source of truth](./PRODUCT.md) — what Floom is, for whom, and what is load-bearing.
- [Deferred UI](./DEFERRED-UI.md) — features shipped on the backend but hidden in the MVP surface.
- [Monetization](./monetization.md) — Stripe Connect Express partner app.
- [Connections](./connections.md) — per-user OAuth integrations via Composio.

## Setup

- [Claude Desktop](./CLAUDE_DESKTOP_SETUP.md) — connecting a Floom app as an MCP server.
- [Go-public checklist](./GO_PUBLIC_CHECKLIST.md) — the audit we run before flipping the repo to public.
