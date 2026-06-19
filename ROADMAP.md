# Workeros Roadmap

This roadmap is for contributors and users who want to understand where the
source-available project is headed. It is intentionally deployment-neutral: Workeros
can run locally, on your own server, or behind whatever hosting stack you choose.

## Current Focus

The near-term goal is a reliable self-hosted runtime for creating, running, and
observing AI workers.

- Keep local setup simple on Linux, macOS, and Windows.
- Keep script workers isolated in E2B sandboxes by default.
- Make agent workers predictable through explicit manifests, limits, outputs,
  approvals, and connection declarations.
- Keep the CLI and MCP tools useful for agents and human operators.
- Improve documentation and examples so new contributors can build a worker
  without reading the entire codebase.

## Shipped Foundations

- Worker manifests with `schema_version: "0.3"`.
- Script workers with explicit `run.py` process contracts.
- Agent workers powered by `SKILL.md` and the AgentDriver tool loop.
- Manual, schedule, webhook, and Composio-triggered runs.
- Human approval flows for side-effecting workers.
- Content-hashed uploads and run artifacts.
- Context/brain packs for worker reference material.
- Git-backed worker and context version history when the workspace lives outside
  the engine source checkout.
- CLI and MCP package published as `@floomhq/workeros`.
- Web UI for workers, runs, connections, approvals, contexts, and settings.
- Security posture for platform secrets, sandbox payloads, SSRF-sensitive MCP
  URLs, webhook tokens, magic links, and upload download tokens.

## Active Improvement Areas

These are good places for focused contributions:

- **Examples:** more small, real workers that demonstrate one concept each.
- **Docs:** clearer recipes for self-hosting, worker authoring, and MCP setup.
- **Windows parity:** keep setup, tests, and lint commands working on Windows.
- **Runtime reliability:** tighter cancellation, retries, timeouts, and error
  messages around long-running workers.
- **Observability:** clearer run logs, transcripts, artifacts, and failure
  summaries.
- **Integrations:** better examples for Composio, Slack, WhatsApp, and generic
  HTTP/MCP tools.
- **Frontend polish:** accessible states, compact workflows, and clearer empty
  states without changing the underlying runtime contract.

## Larger Ideas

These are intentionally not committed scope until someone proposes a concrete
design and implementation path:

- Multi-user/team self-hosting beyond the current workspace model.
- Marketplace-style worker installation.
- More granular capability enforcement for untrusted worker bundles.
- Richer typed inputs and outputs, including nested JSON schemas.
- First-class SDK/library mode for embedding workers in Python or TypeScript
  applications.
- Advanced scheduling, notifications, and health checks.

## How To Propose Roadmap Changes

Open a GitHub issue with:

1. The user problem.
2. The smallest useful version of the feature.
3. The worker/runtime/API surface it touches.
4. The tests or examples that would prove it works.

Prefer small, testable changes over broad platform proposals. If a change affects
worker manifests, runtime behavior, auth, secrets, or sandboxing, update the
relevant docs in the same PR.
