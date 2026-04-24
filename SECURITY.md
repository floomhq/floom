# Security Policy

## Reporting a vulnerability

Please email **security@floom.dev** (routes to the maintainer). Do **not** open a public GitHub issue for security problems.

## Safe harbor

If you follow this policy — report privately, give us a reasonable window to fix the issue, don't exfiltrate data or harm users — we will not pursue legal action against you for good-faith security research on Floom. This covers first-party code in this repo and the hosted floom.dev deployment. Third-party systems reached via a proxied-mode app are out of scope; report those to the upstream vendor.

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
