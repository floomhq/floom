# Workeros History

Workeros is being released as a clean source-available repository after a long
internal development cycle. The public history starts at a readable release
commit so installers, contributors, and security reviewers do not have to sort
through internal artifacts, generated logs, old experiments, or private
operational history.

Before this public release, the project went through the preserved internal
commits and hundreds of tracked issues across the API, web app, worker runtime,
MCP surface, integrations, tests, and deployment hardening. This repository is
the curated release cut.

## Why The Public History Starts Clean

The first public commit is intentionally not a full dump of the internal history.
That is a security and usability decision.

- It keeps accidental secrets, local databases, screenshots, logs, feedback
  folders, and generated audit artifacts out of public history.
- It gives new users a small, understandable baseline for installation and
  review.
- It lets contributors work from a coherent v1 source tree instead of a long
  internal timeline with private context.
- It makes future security review and release tagging simpler.

The clean start does not mean the project is new. It means the public repo is
the safe release artifact.

## Development Milestones

These are the major areas that were built and hardened before the first public
release.

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

Future history in this repository should be normal public project history:
issues, pull requests, changelog entries, release tags, and reviewable commits.
