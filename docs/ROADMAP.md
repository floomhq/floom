# Floom Roadmap

Living document. Snapshot as of **2026-04-17**.

Floom is pre-1.0. Anything here can shift as we learn from real usage.

## Current state

Shipped layers (6): manifest, ingest, runner, 3 surfaces (web + MCP + HTTP), runs, auth. The cloud tier at [floom.dev](https://floom.dev) runs the same image as the self-host Docker release.

- Web form + output renderer at `/p/:slug`
- Per-app MCP server at `/mcp/app/:slug`
- HTTP endpoint at `/api/:slug/run`
- Four MCP admin tools at `/mcp` root: `ingest_app`, `list_apps`, `search_apps`, `get_app`

Self-host image: `ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4` (CI publishes on `v*` tags).

## Shipped backend, UI pending

Backends land; the UI to drive them is re-enabled incrementally.

| Feature | Status |
|---|---|
| Workspace switcher | Backend shipped, UI stub |
| Composio connections (150+ OAuth tools) | Backend shipped, UI stub |
| Async job queue | Shipped (`RunSurface.tsx`, `JobProgress.tsx`) |
| Custom renderer upload | Shipped (`CustomRendererPanel.tsx`) |
| Stripe Connect monetization | Backend stub, UI deferred to v1.1+ |
| App memory per-user | Backend stub, UI deferred to v1.1+ |

## Prioritized roadmap

### P0 — Launch blockers

- Async job queue UI (re-enable)
- Custom renderer upload UI (re-enable)
- Rate-limit all `/api/*/run` endpoints
- Legal: imprint, privacy policy, terms, cookie consent
- Landing + public-page polish (wireframes v13)
- **Repo → hosted pipeline** (`packages/runtime` + `packages/detect` + `packages/manifest`). Paste a GitHub URL, Floom clones, detects the runtime, `docker build`s (or generates a Dockerfile), runs a container, and smoke-tests over HTTP — core to the ICP; see [`PRODUCT.md`](./PRODUCT.md). **Library path implemented** (`deployFromGithub` + `Ax41DockerProvider`). **Still to land:** server route (`POST /api/deploy-github` + SSE log), `/build` “host this repo” ramp (distinct from OpenAPI-in-repo discovery), per-user deploy quota, and hardened defaults in `services/docker.ts` for all hosted workloads.

### P1 — Week one

- End-to-end functional test suite in CI (currently manual)
- URL-to-run restore (`?run=<id>` loads prior run state)
- Responsive output renderer (embedded deck / long tables)
- Per-app custom renderers for the top five JSON-heavy apps
- Error tracking (Sentry or similar)
- Uptime monitoring
- Lighthouse / Core Web Vitals pass
- Real docs content (shell is live; copy is thin)

### P2 — Month one

- Workspace switcher UI (re-enable)
- Composio connections UI (re-enable)
- App memory UI
- Stripe Connect UI
- Per-app OG images (render pipeline)
- Visual regression tests
- Secrets rotation process
- GitHub SSO (decide whether to add back; cut during magic-link removal)

### P3 — v1.1 and later

- GraphQL wrapping
- gRPC surface
- WebSocket / AsyncAPI
- Enterprise RBAC
- "Describe it" AI-generate ingest ramp
- Versions / staging environments
- Schedules
- Custom domains
- Fine-grained access control
- Webhook delivery
- Analytics / observability dashboards

## How to weigh in

- Thumbs-up an [issue](https://github.com/floomhq/floom/issues) to vote priority.
- Open an issue for anything missing.
- PRs for P1/P2 items are welcome; coordinate on the issue first.
