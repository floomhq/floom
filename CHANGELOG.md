# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes yet.

## [1.0.0] - 2026-06-19

Initial source-available release of Workeros, the self-hosted runtime for AI
workers. This public repository starts from a clean release commit after roughly 2,000
internal commits of development, hardening, and production testing. See
[HISTORY.md](HISTORY.md) and [the v1.0.0 release notes](docs/releases/v1.0.0.md)
for provenance and launch context.

### Added

- FastAPI backend for workers, runs, connections, approvals, contexts, users,
  tokens, and operational views.
- Next.js web app for creating, running, monitoring, and sharing workers.
- MCP and CLI package published as `@floomhq/workeros`.
- E2B-sandboxed execution for script workers and agent workers.
- Manifest-driven worker model with `schema_version: "0.3"`.
- Script worker support through `run.py` and agent worker support through
  `SKILL.md`.
- Manual, cron schedule, webhook, and Composio-triggered runs.
- Composio OAuth connections with server-side tool proxying for sandboxed
  workers.
- Human approval flows for workers that need review before side effects.
- Run logs, artifacts, transcript capture, bundle snapshots, replay metadata,
  and share-link/public run views.
- Context packs for reusable worker knowledge.
- Git-backed workspace export/version history when configured outside the
  engine source checkout.
- Seed workers for Gmail, GitHub, Slack, WhatsApp, open blog generation, worker
  authoring, and workspace operations.
- Setup scripts for Linux, macOS, and Windows PowerShell.
- Contributor guide, security policy, code of conduct, roadmap, issue
  templates, PR template, and repository metadata.

### Security

- Workers run in isolated E2B sandboxes by default; there is no supported local
  in-process worker runner.
- Platform secrets remain on the API side and are not injected into sandbox
  worker code unless explicitly declared as worker secrets.
- Run-scoped tokens gate sandbox-to-API proxy calls.
- Connection declarations and allowed Composio tool lists are explicit in
  `worker.yml`.
- Worker bundle extraction, file paths, uploads, markdown links, proxy
  redirects, webhook tokens, MCP URLs, and auth/session/token surfaces include
  dedicated validation and tests.
- Local `.env` files, SQLite databases, run artifacts, and generated runtime data
  are excluded from source control.

### Notes

- Worker execution requires E2B credentials.
- Local setup requires at least one configured model provider.
- Composio event triggers require `COMPOSIO_WEBHOOK_SIGNING_KEY` and a reachable
  webhook URL.
- E2B warm pools are available behind environment flags and should be sized
  conservatively because warm sandboxes are still running compute.

[Unreleased]: https://github.com/floomhq/workeros/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/floomhq/workeros/releases/tag/v1.0.0
