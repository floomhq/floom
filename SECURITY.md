# Security Policy

## Reporting a vulnerability

Please email **team@floom.dev** with the details. Do **not** open a public GitHub issue for security problems.

Include:

- A description of the issue and impact
- Steps to reproduce (ideally a minimal PoC)
- Affected version or commit SHA
- Your contact for follow-up

## Response expectations

- Acknowledgement within **2 business days**.
- Initial assessment and severity within **7 days**.
- A fix, mitigation, or timeline within **30 days** for high-severity issues.

We credit reporters in the release notes unless you prefer to stay anonymous.

## Supported versions

Floom is pre-1.0. Security fixes land on `main` and the latest `v0.x` Docker image tag on [GHCR](https://github.com/floomhq/floom/pkgs/container/floom-monorepo). Older tags are not patched.

## Scope

In scope:

- `apps/server` (Hono API, auth, runner, MCP)
- `apps/web` (React SPA)
- `packages/*` (runtime, manifest, detect, CLI)
- Docker image `ghcr.io/floomhq/floom-monorepo`

Out of scope:

- Third-party APIs wrapped via proxied-mode manifests (report to the upstream vendor)
- User-uploaded custom renderers running in sandbox (report sandbox-escape issues only)
- Issues requiring physical access to the host or an already-compromised account
