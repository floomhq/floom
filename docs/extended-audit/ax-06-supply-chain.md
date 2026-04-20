# ax-06 — Supply chain & dependency hygiene

Scope: monorepo package manager, lockfile, overrides, audit surface, license posture, automation.

**`pnpm audit` (2026-04-21, repo root):** exit 0 — *No known vulnerabilities found* (re-run before releases; advisory DB updates daily).

## Facts from repo

| Item | Observation |
|------|----------------|
| Package manager | `pnpm@9.0.0` (`package.json` `packageManager`) |
| Lockfile | Single root `pnpm-lock.yaml` (workspace-wide) |
| Monorepo | Turborepo (`turbo build`, `turbo test`) |
| Overrides | Root `pnpm.overrides`: `tar-fs@>=2.0.0 <2.1.4` → `>=2.1.4` (`package.json`) — explicit supply-chain patch |
| Renovate / Dependabot | No `renovate.json` / `.github/dependabot.yml` found in tree at audit time — **gap** for drift |
| Server stack | Hono, better-sqlite3, esbuild, Stripe, Composio, MCP SDK, Sentry (`apps/server/package.json`) — high-value audit targets |

## Recommended commands (owner / CI)

```bash
cd /path/to/floom
pnpm audit --audit-level=moderate
pnpm -r outdated
# Optional: license policy
pnpm dlx license-checker --production --summary
```

Wire `pnpm audit` into an existing workflow (see `ax-04-ci-workflows.md`) with **non-blocking** or **blocking** policy explicitly chosen.

## Risk register

| ID | Topic | Note |
|----|-------|------|
| SC-1 | Transitive vulns | esbuild, dockerode, yaml, zod — keep on minor/patch cadence; esbuild is compile-time + runtime bundler for renderers |
| SC-2 | GitHub MCP / Composio | Third-party SDKs; pin semver ranges already tight (`@composio/core` exact minor) — watch advisories |
| SC-3 | Lockfile-only installs | Docker and CI should use `pnpm fetch` / `pnpm install --frozen-lockfile` (verify in Dockerfiles — out of scope here) |
| SC-4 | License compliance | No `LICENSE` aggregation automated; if distributing Docker image with app, confirm `better-sqlite3` native binding and Stripe SDK terms |

## Renovabot / Dependabot posture (proposal)

1. **Dependabot** (simplest): weekly `pnpm` ecosystem on root + grouped devDependencies.
2. **Renovate** (fine-grained): separate rules for `apps/server` vs `apps/web`, auto-merge patch-only after CI green.

## Deliverable status

Static analysis complete. Registry `pnpm audit` executed successfully (see header). **License aggregation** and **Dependabot/Renovate** wiring still optional follow-ups.
