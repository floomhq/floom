# Floom — Product Source of Truth

**This file is the single source of truth for what Floom is and for whom. Read it before proposing to delete, deprecate, or consolidate any code path, package, or feature.**

If a change conflicts with this file, the file is wrong and needs an explicit update from the owner (Federico) before the code changes. Do not "clean up" load-bearing paths just because they look half-built — half-built is the natural state of a pre-1.0 product, and the surface area here is the product.

---

## ICP (one sentence)

**A non-developer AI engineer who has a working prototype on `localhost` and needs to get it to production without learning Docker, reverse proxies, secrets managers, OAuth, or infra.**

They are not stupid. They are good at LLMs, data, product thinking. They are not good at (and should never have to be good at) deployment plumbing. Any feature that assumes they know how to host a Node server, manage TLS, or wire a queue is a feature aimed at the wrong person.

## Core value proposition

> You have a prototype running on localhost. Paste the repo URL. Floom hosts it in production in 30 seconds, gives it an auth layer, rate limits, secret injection, a web form, an MCP server, and an HTTP endpoint.

Hosting is the product. "OpenAPI wrapping" is a convenience path for people who already have a hosted API. The default is: **Floom runs your code.**

## Deployment paths, in order of priority

1. **Repo → hosted** (primary). User pastes a GitHub URL. Floom clones, detects runtime, builds, runs, and exposes it on all surfaces. **This is what the ICP needs.** Code lives in `packages/runtime`, `packages/detect`, `packages/manifest`, and the `/api/deploy-github` server route (when present).
2. **Docker → hosted** (self-host path, second class). Operator writes `apps.yaml` with `type: hosted`, Floom runs the container. Implemented in `apps/server/src/services/{docker,runner,seed}.ts` and `apps/server/src/lib/entrypoint.{mjs,py}`. Load-bearing for self-hosters and for the internal hosted-execution layer that path 1 builds on.
3. **OpenAPI → proxied** (advanced path). User pastes an OpenAPI spec for an API they already host somewhere. Floom wraps it. This is the simplest path to ship but not the primary onboarding — most ICP users don't have a hosted API; they have a localhost script.

**All three paths produce the same three surfaces**: web form (`/p/:slug`), MCP server (`/mcp/app/:slug`), HTTP endpoint (`/api/:slug/run`).

## Host requirements (operator-side, never user-side)

End users never install tooling. The `git` and `docker` binaries that the
repo→hosted path shells out to are required on the **machine that runs the
Floom server process**, not on any user's laptop.

- Cloud-hosted Floom (the default that the ICP uses): satisfied once on the
  operator's host. Users only ever see the three surfaces.
- Self-hosted Floom, run as a normal process on a host that has `git` +
  `docker`: supported.
- Self-hosted Floom, run *inside* a container, attempting to deploy other
  repos: **not supported.** We do not mount the host's Docker socket into
  Floom's container, and Docker-in-Docker is not configured. Run Floom on
  the host directly if a self-hoster needs path 1.

## Load-bearing paths (do not delete without explicit owner sign-off)

Even if these look abandoned, broken, or unwired, they are shaped to hold a product pillar. Fix, don't remove.

| Path | Why it's load-bearing |
|---|---|
| `packages/runtime` | Deploy-from-GitHub pipeline. This is path 1 of 3. Without it, the primary onboarding story doesn't exist. |
| `packages/detect` | Runtime auto-detection (Node, Python, PHP, etc.). The "paste a repo" path is dead without it — we'd have to ask the user which runtime, which defeats the ICP promise. |
| `packages/manifest` | Parses/generates the Floom manifest from a detected repo. Bridges detection → runtime. |
| `apps/server/src/services/docker.ts`, `services/runner.ts`, `services/seed.ts` | Hosted-mode Docker runner. Path 2. Also the execution layer that path 1 plugs into. |
| `apps/server/src/lib/entrypoint.{mjs,py}` | Shim scripts the runner injects into hosted containers. Deleting these breaks every `type: hosted` app. |
| `apps/server/src/routes/mcp.ts` | MCP admin tools (`ingest_app`, `list_apps`, etc.). Agent-native ingest is a core promise. |
| `apps/server/src/services/renderer-bundler.ts` + `apps/web/src/components/CustomRendererPanel.tsx` + `CustomRendererHost.tsx` | Custom renderer pipeline. P0 differentiator vs. "just an API gateway". |
| Async job queue (`apps/server/src/routes/jobs.ts`, `apps/web/src/components/runner/JobProgress.tsx`) | Long-running ops are a real user need and a real differentiator. |

## Non-load-bearing — safe to prune with normal care

- Example app stubs under `examples/` that are not linked from any README, page, or apps.yaml example.
- Sprint-specific workplan / handoff docs at repo root (they should live in PR descriptions or be deleted once merged).
- Any `DEFERRED-*.md`, `HANDOFF.md`, or `PHASE*-STATUS.md` that describes past work rather than current product shape.

## Past mistakes to not repeat

- **#29 (`chore: drop runtime-deploy path`)** deleted `packages/{runtime,detect,manifest,cli}` on the theory that the code was half-built and unwired. It was half-built, but it was the primary onboarding path for the ICP. The correct action was "fix, wire, and ship", not "delete". This document exists because of that mistake.

## How to propose a deletion safely

1. Read this file.
2. If the path is listed above as load-bearing, stop and ask the owner. Do not propose deletion.
3. If not listed, still write a one-paragraph answer to: "what product pillar does this serve, and what replaces it?" If you can't answer it clearly, you don't have enough context to delete.
4. Always prefer moving to `docs/deprecated/` or gating behind a feature flag over hard deletion, when in doubt.

## Keep this file current

When a new load-bearing path lands, add it to the table in the same PR. When a path genuinely sunsets, update the "Past mistakes" section or remove its row with a note in the PR description explaining why.
