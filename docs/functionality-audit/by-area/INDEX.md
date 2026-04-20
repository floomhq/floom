# Per-area functionality (backend) audits

Each file is produced by a **dedicated background subagent**. Lens: **`docs/PRODUCT.md`** (ICP, three surfaces, load-bearing paths), correctness, **security** (authz, secrets, injection), error envelopes, idempotency, observability, and alignment with **web / MCP / HTTP** contracts.

Workspace root: `apps/server/src/`.

| # | Output file | Primary scope |
|---|-------------|----------------|
| 01 | `fn-01-bootstrap.md` | `index.ts` — CORS split, `securityHeaders`, `onError`, route mount order, `FLOOM_AUTH_TOKEN`, rate-limit mounts, startup (`seed`, `ingest`, workers, sidecars) |
| 02 | `fn-02-db.md` | `db.ts` — schema access patterns, queries, transactions, footguns |
| 03 | `fn-03-auth.md` | `lib/auth.ts`, `lib/better-auth.ts` |
| 04 | `fn-04-session.md` | `services/session.ts` — `resolveUserContext`, OSS vs cloud |
| 05 | `fn-05-edge-security.md` | `lib/rate-limit.ts`, `lib/scoped.ts`, `middleware/security.ts` |
| 06 | `fn-06-hub-health.md` | `routes/hub.ts`, `lib/hub-filter.ts`, `lib/hub-cache.ts`, `routes/health.ts` |
| 07 | `fn-07-observability.md` | `routes/metrics.ts`, `routes/og.ts`, `lib/sentry.ts`, `lib/server-version.ts`, `lib/metrics-counters.ts` |
| 08 | `fn-08-run-routes.md` | `routes/run.ts` — `/api/run`, `/api/:slug/run`, `/api/me` slices exported here |
| 09 | `fn-09-proxied-runner.md` | `services/proxied-runner.ts` |
| 10 | `fn-10-runner-docker.md` | `services/runner.ts`, `services/docker.ts` |
| 11 | `fn-11-jobs-worker.md` | `routes/jobs.ts`, `services/jobs.ts`, `services/worker.ts` |
| 12 | `fn-12-mcp.md` | `routes/mcp.ts` |
| 13 | `fn-13-me-apps-secrets.md` | `routes/me_apps.ts`, `services/app_creator_secrets.ts` |
| 14 | `fn-14-memory-user-secrets.md` | `routes/memory.ts`, `services/app_memory.ts`, `services/user_secrets.ts` |
| 15 | `fn-15-openapi-ingest-seed.md` | `services/openapi-ingest.ts`, `services/seed.ts` |
| 16 | `fn-16-manifest-parser.md` | `services/manifest.ts`, `services/parser.ts` |
| 17 | `fn-17-renderer.md` | `routes/renderer.ts`, `services/renderer-bundler.ts`, `lib/renderer-manifest.ts` |
| 18 | `fn-18-triggers-webhook.md` | `routes/triggers.ts`, `routes/webhook.ts`, `services/triggers.ts`, `services/triggers-worker.ts`, `services/webhook.ts` |
| 19 | `fn-19-workspaces-connections.md` | `routes/workspaces.ts`, `services/workspaces.ts`, `routes/connections.ts`, `services/composio.ts` |
| 20 | `fn-20-stripe.md` | `routes/stripe.ts`, `services/stripe-connect.ts` |
| 21 | `fn-21-auxiliary-routes.md` | `routes/parse.ts`, `pick.ts`, `thread.ts`, `feedback.ts`, `reviews.ts`, `deploy-waitlist.ts` |
| 22 | `fn-22-types-adapters-lib.md` | `types.ts`, `adapters/types.ts`, `lib/body.ts`, `lib/ids.ts`, `lib/email.ts`, `lib/log-stream.ts` |
| 23 | `fn-23-embeddings-fastapps-cleanup.md` | `services/embeddings.ts`, `services/fast-apps-sidecar.ts`, `services/cleanup.ts` |

**Status:** 2026-04-20 — **23 area audit files present** (`fn-01` … `fn-23` + this INDEX).
