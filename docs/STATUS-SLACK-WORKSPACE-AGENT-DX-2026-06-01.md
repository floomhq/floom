# Slack, Workspace Agent, and DX Status - 2026-06-01

Verified against:

- OSS repo `/tmp/workeros-ui-round2` at `65b065c`
- Cloud wrapper `/root/workeros-cloud` at `794fc8d`
- Cloud engine submodule at `65b065c`

## Capability Matrix

| Area | Implemented | Missing / Open |
|---|---|---|
| Slack catalog visibility | Slack appears in the connections browse catalog and worker examples through generic Composio app handling. | No dedicated Slack product surface beyond generic connections/catalog examples. |
| Slack OAuth install | Generic Composio OAuth is implemented with `POST /connections`, `/connections/callback`, `/connections/{id}/status`, and `/connections/{id}/account-info`. Slack can use this path when Composio supports the Slack app. | No Slack-specific install route, Slack app manifest, bot scope declaration, or Slack workspace/channel selector was found. |
| Slack event ingestion | Generic Composio event ingestion exists at `POST /composio-events` and `/webhooks/composio-events`, with signed webhook validation and worker routing by Composio trigger id/event. | No native Slack Events API route, Slack signature verification, URL challenge handling, slash command route, or interactivity payload route was found. |
| Slack slash/interactivity | None found. | Missing `/slack/events`, `/slack/commands`, `/slack/interactivity`, or equivalent product route. |
| Slack channel binding | Worker manifests can declare Slack as a generic connection and Composio trigger filters can carry arbitrary filter data. | No first-class channel binding table, UI picker, channel id persistence, or channel-to-agent mapping was found. |
| Agent posting to Slack | Workers can call declared Composio tools through the run proxy when their manifest grants Slack tool access. | No workspace-agent-to-Slack listener/posting loop was found. The bundled `slack-weekly-recap` worker explicitly produces pasteable markdown and does not call Slack. |
| Workspace Agent page | OSS and cloud UI include `/assistant` with top-level nav label `Agent` and tabs for Instructions, Resolved prompt, Tools, Channels. | The page label is `Agent`, not `Workspace Agent`. The Channels tab currently explains Slack/Connections but does not manage channel bindings. |
| Editable instructions | OSS exposes `GET /workspace` and `PUT /workspace`; the page loads and saves `workspace.md`. Cloud overrides storage into `workspace_agent_settings` per workspace. | Cloud migration is present locally; production migration state was not verified from DB because credentials were not used in this lane. |
| Model declaration | `WorkspaceAgentInfo` exposes agent id, resolved prompt, and tools. README documents default LLM at a high level. | `/system/workspace-agent` does not return the active model name. The assistant page does not show a model field. |
| DX create/edit/deploy/run | CLI exposes `workeros workers validate`, `workeros workers push`, `workeros run`, `workeros workers info`, cloud login, and workspace selection. MCP exposes worker create/update/delete/run plus secrets/connections/contexts tools. | No `workers create --prompt` CLI command. `workers push` is source-directory based and depends on `PUT /workers/{id}` support for updates. |
| Stale list cache / update path | `workers push` checks existence with `GET /workers/{id}`, creates with `POST /workers`, updates with `PUT /workers/{id}`. The API invalidates worker cache after source writes. | Older DELETE+POST update UX is replaced in code, but live workers-api was Cloudflare-blocked from this AX41 curl path, so OSS live behavior was not verified over HTTP. |
| Binary naming | CLI program detects `workeros` vs `floom`; package exposes `workeros`, `floom`, and `workeros-mcp`. README marks `workeros` as preferred and `floom` as compatibility alias. | Completion output still uses `floom` command strings. This is compatibility copy, not a runtime blocker. |
| Connections visibility | Connection list returns app name, status, scopes, account label, MCP metadata, and test/status endpoints. Worker detail/CLI info surfaces required connections and secrets by name. | Granular Composio allowed tool access is visible in manifests and validation, but no dedicated per-worker permission review page was verified here. |
| Secrets visibility | Secrets are managed by name only through `/secrets`; workspace export excludes secret-bearing files and only writes required secret names. | Secret values are intentionally not visible. |
| Brain packages | Worker manifests support `contexts`; workspace export includes operator contexts and required secret/connection names. | This lane did not edit Source/Brain UI. Any Brain UX gaps belong to that lane. |

## Code Evidence

- Generic Composio OAuth and connection account/status routes: `engine/apps/api/main.py` mirrored from `/tmp/workeros-ui-round2/apps/api/main.py` around `list_connections`, `initiate_connection`, `connections_callback`, `get_connection_status`, and `get_connection_account_info`.
- Generic Composio event receiver: `/tmp/workeros-ui-round2/apps/api/main.py` `POST /composio-events` and `/webhooks/composio-events`.
- Workspace Agent API: `/tmp/workeros-ui-round2/apps/api/main.py` `GET /system/workspace-agent`, `GET /workspace`, `PUT /workspace`, `POST /chat`, and conversation routes.
- Workspace Agent UI: `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx` and `/root/workeros-cloud/web/app/assistant/page.tsx`.
- Cloud workspace-agent persistence: `/root/workeros-cloud/apps/api/cloud_workspace_agent.py` and `/root/workeros-cloud/supabase/migrations/0014_workspace_agent_settings.sql`.
- Cloud wrapper mount/auth/workspaces: `/root/workeros-cloud/apps/api/main.py`, `/root/workeros-cloud/apps/api/startup.py`, and `/root/workeros-cloud/apps/api/routes/workspaces.py`.
- CLI deploy path: `/tmp/workeros-ui-round2/apps/mcp/src/commands/workers.ts` and `/tmp/workeros-ui-round2/apps/mcp/src/cli.ts`.

## Live Route Evidence

- `https://workeros-api.floom.dev/healthz` returned `200` with `{"status":"ok","deploy":"cloud"}`.
- `https://workeros.floom.dev/app/assistant` redirected unauthenticated traffic to Google/Supabase login.
- `https://workeros.floom.dev/app/connections` redirected unauthenticated traffic to Google/Supabase login.
- `https://workers.floom.dev/assistant` returned `200` and the HTML contained Agent and Workspace instructions content.
- `https://workers.floom.dev/connections/browse` returned `200` and the HTML contained Slack browse content.
- `https://workers-api.floom.dev/healthz`, `/connections`, `/integrations/triggers?app=slack`, `/system/workspace-agent`, `/workspace`, and `/chat` were Cloudflare-blocked from this AX41 curl path with `403`. `GET /composio-events` returned `405`, confirming the route exists and rejects the wrong method.

## Patch Plan for Owned Scopes

No code changes were made to Slack runtime, Workspace Agent behavior, Source/Brain UI, Composio execution, or Cloud proxy routing.

Recommended follow-up implementation plan for the Slack/Workspace Agent owner:

1. Add a Slack channel binding model keyed by workspace id, Slack team id, channel id, and worker/agent id.
2. Add Slack-specific routes for OAuth callback metadata, Events API URL verification, signed event ingestion, slash commands, and interactivity.
3. Add a Channels management tab that lists connected Slack accounts, lets users bind channels, and shows listener status.
4. Extend `/system/workspace-agent` to return the active model declaration and render it on `/assistant`.
5. Add tests for Slack signature verification, channel binding authorization, and workspace-scoped agent posting.
