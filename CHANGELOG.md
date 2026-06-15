# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are managed automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) — entries below 0.1.0
are seeded by hand.

## [0.1.0] - 2026-06-15

First tagged release of the open-source WorkerOS engine (FastAPI API + Next.js web + MCP server, E2B-sandboxed worker execution).

### Security
- Sanitize markdown links in the FilesEditor and contexts renderers — block `javascript:`/`data:`/`vbscript:` (#1043, #1045).
- Validate the proxy upstream `Location` header to prevent open redirects (#1044).
- Cap E2B writeback-tar extraction (per-member + total) to prevent API-host OOM (#1041).
- Clamp worker execution limits to operator maxima and enforce a minimum cron interval (#1067).
- Reject `TRUSTED_PROXIES='*'` wildcard; require explicit IPs/CIDRs (#1042).
- Reject percent-encoded path separators in the worker/context file-path validators (#1052).
- Input-validation hardening: alert recipient restrictions, env-shadowing secret-name blocklist, clean handling of empty secret keys (#1068).

### Fixed
- Workspace-secret writes are now repository-agnostic (real actor + workspace id), fixing a 500 on the managed/cloud repo (#1071).

### Changed
- API port is configurable via `WORKEROS_API_PORT` (default `8000`).
- Adopted a `ruff` lint gate in CI; added `CODE_OF_CONDUCT.md`, issue/PR templates, `CODEOWNERS`, and repository metadata.

[0.1.0]: https://github.com/floomhq/workeros/releases/tag/v0.1.0
