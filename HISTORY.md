# Floom History

Floom is being released as a source-available repository after a long
development and hardening cycle. The public repository keeps the useful project
history so contributors, security reviewers, and operators can inspect how the
runtime evolved.

Before the public release, private/customer-specific artifacts, hosted
deployment residue, generated audit assets, and obsolete worker experiments were
removed from the current tree and from the main-branch history. That keeps the
repository reviewable without hiding the engineering lineage.

## Public History Policy

The public history is intentionally curated, not squashed.

- Keep normal engineering commits, fixes, tests, and design decisions visible.
- Remove files that are private, generated, obsolete, or not part of the OSS
  product surface.
- Keep local databases, screenshots, logs, feedback folders, credentials, and
  hosted deployment artifacts out of public history.
- Make future public development normal: issues, pull requests, changelog
  entries, release tags, and reviewable commits.

## Development Milestones

These are the major areas built and hardened before the first public release.

### Worker Runtime

- Manifest-driven workers with `schema_version: "0.3"`.
- Pure-script workers that run in E2B sandboxes by default.
- Agent workers powered by `SKILL.md` and the API-hosted AgentDriver loop.
- Manual, scheduled, webhook, and Composio-triggered runs.
- Run logs, artifacts, transcripts, replay state, and failure summaries.
- Explicit worker limits for timeouts, tool iterations, token budgets, and
  output sizes.

### Isolation And Secret Handling

- No supported local in-process worker execution path.
- Platform secrets stay on the API side; workers call scoped proxy endpoints.
- Run-scoped tokens for worker-to-worker and sandbox-to-API calls.
- Guardrails for upload/download tokens, share links, path traversal, archive
  extraction, and SSRF-sensitive URLs.
- Local environment files and runtime data are excluded from the public source
  tree.

### Connections And Integrations

- Composio-backed OAuth connections for Gmail and other tools.
- Server-side Composio proxying so sandbox code never receives the Composio API
  key.
- Connection declarations in `worker.yml`, including allowed tool lists.
- Examples for Gmail, GitHub, Slack, WhatsApp, and generic MCP/HTTP tools.

### Approvals And Operations

- Human approval flows for workers that need review before side effects.
- Worker visibility and workspace sharing controls.
- Context packs for reusable worker knowledge.
- Git-backed workspace export/version history when configured outside the engine
  source checkout.
- Operational health, overview, run telemetry, and failure panels.

### Developer Experience

- FastAPI backend, Next.js web app, and MCP/CLI package in one repository.
- Setup scripts for Linux, macOS, and Windows PowerShell.
- Contributor guide with local test commands.
- Issue templates, PR template, code of conduct, security policy, and roadmap.
- Seed workers that demonstrate script, skill, Gmail, GitHub, scheduler, and
  listener patterns.

## Release Line

The public release line starts at `v1.0.0`.
