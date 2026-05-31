# Workspace Agent

The workspace agent is the operator-facing assistant for a Workeros workspace.
It combines:

- `workspace.md`: editable workspace instructions owned by the operator.
- A live workspace snapshot: workers, recent run state, brain packs, and
  pending approvals.
- The engine prompt and tool contract from the `workspace-agent` worker.

## Editing Instructions

Open `Agent -> Instructions` in the dashboard. Changes are saved to
`workspace.md` through:

- `GET /workspace`
- `PUT /workspace`

The resolved prompt is visible in `Agent -> Resolved prompt`. It is read-only
because it includes generated runtime context.

## Channels

Slack and other channels use the same workspace instructions. Channel-specific
behavior belongs in `workspace.md`, for example the tone, escalation rules, and
which workers the agent can use for a Slack workspace.

## Connections And Scopes

OAuth scopes are granted at the provider connection level. Workeros can enforce
per-worker capability allowlists in its own proxy layer, but it cannot make an
already-broad upstream OAuth token cryptographically narrower at the provider.
For hard isolation, create a separate provider connection with narrower scopes.

## Brain Packs

The old `contexts` API and route remain for compatibility. The product language
is now Brain / brain packs in the UI and docs.
