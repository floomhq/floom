# Workspace Agent

The workspace agent is the operator-facing assistant for a Floom workspace.
It combines:

- `workspace.base.md`: optional editable Emily base-persona override. If absent,
  Floom uses the built-in Emily default.
- `workspace.md`: editable workspace custom instructions layered on top of the
  base persona.
- A live workspace snapshot: workers, recent run state, brain packs, and
  pending approvals.
- The engine prompt and tool contract from the `workspace-agent` worker.

## Editing Instructions

Open `Agent -> Instructions` in the dashboard. Workspace custom-instruction
changes are saved to `workspace.md` through:

- `GET /workspace`
- `PUT /workspace`

Base persona edits are saved separately through:

- `GET /workspace/base`
- `PUT /workspace/base`

The resolved prompt is visible in `Agent -> Resolved prompt`. It is read-only
because it includes the base persona, workspace custom instructions, the
workspace-agent SKILL.md, and generated runtime context.

## Versions

Open `Agent -> Versions` to list automatic snapshots. Each save via
`PUT /workspace` creates a workspace custom-instruction version. Roll back with:

- `GET /workspace/versions`
- `POST /workspace/rollback/{version_id}`

Each save via `PUT /workspace/base` creates a separate base-persona version.
Roll back with:

- `GET /workspace/base/versions`
- `POST /workspace/base/rollback/{version_id}`

AI edits (sandbox run token) are tagged `ai`; operator saves are tagged `user`.

## Channels

Slack and other channels use the same base persona and workspace custom
instructions. Channel-specific preferences can live in `workspace.md`; broad
Emily identity and operating style belong in `workspace.base.md` when an
override is needed.

The docs/DX lane only documents the channel contract. The local Slack listener
manifest lives at [workers/slack-listener/worker.yml](../workers/slack-listener/worker.yml)
as an example of the worker-bundle shape; backend readiness and Slack delivery
status belong to the Slack lane.

## Connections And Scopes

OAuth scopes are granted at the provider connection level. Floom can enforce
per-worker capability allowlists in its own proxy layer, but it cannot make an
already-broad upstream OAuth token cryptographically narrower at the provider.
For hard isolation, create a separate provider connection with narrower scopes.

Agents discover available accounts through the `connections.list` MCP tool and
the dashboard Connections page. Worker authors declare the app and allowed
Composio tool slugs in `worker.yml`:

```yaml
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
```

The structured allowlist is enforced by the Floom Composio proxy for E2B
workers. It is separate from the upstream OAuth scope grant.

## Brain Packs

The old `contexts` API and route remain for compatibility. The product language
is now Brain / brain packs in the UI and docs.

MCP tools still use the stable `contexts.*` names:

- `contexts.list` lists brain packs and file metadata.
- `contexts.read` returns a text file from a brain pack.
- `contexts.write` writes text into a brain pack file.
- `contexts.upload` uploads binary bytes into a brain pack file.

For operator-facing docs and UI copy, use "Brain" or "brain pack". For API and
MCP references, keep the literal `contexts` tool and route names.
