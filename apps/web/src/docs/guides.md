# Build guides

Short, task-oriented walkthroughs for the four most common builder flows.

## Publish your first app

Go from an OpenAPI URL to a live, shareable app in under a minute.

1. Open [`/build`](https://floom.dev/build). No sign-in needed to preview.
2. Paste any OpenAPI spec URL. Good starting specs: `https://petstore3.swagger.io/api/v3/openapi.json`, any public API with a `/openapi.json` endpoint.
3. Click **Detect**. Floom fetches the spec, walks `$refs`, auto-reads `spec.servers[]` for the base URL, and previews every operation with its full JSON Schema.
4. Pick a slug and display name. (Floom suggests one from the spec's `info.title`.)
5. Click **Publish**. Anonymous visitors are prompted to sign up first; the localStorage cache rehydrates your work if you come back.
6. Share the `/p/:slug` URL. You now have an HTTP endpoint, an MCP server, a CLI target, and a web form pointing at that spec.

Large specs (Stripe, GitHub) have 3000+ `$refs` and can take 1-2 seconds to dereference. Operations are capped at 200 per app by default; set `FLOOM_MAX_ACTIONS_PER_APP=0` to lift that.

## Add a custom renderer

By default, each Floom app renders its response with the type-appropriate default card: table for array-of-objects, markdown for `type: string, format: markdown`, syntax-highlighted code for schemas with `x-floom-language`, PDF viewer for `application/pdf`.

When the default isn't enough (flight cards, charts, download-PPTX buttons), ship a `renderer.tsx` alongside your OpenAPI spec and declare it in `apps.yaml`:

```yaml
apps:
  - slug: flyfast
    type: proxied
    openapi_spec_url: ./openapi.yaml
    display_name: FlyFast
    renderer:
      kind: component
      entry: ./renderer.tsx
      output_shape: table
```

At ingest time Floom compiles the renderer via `esbuild` (ESM, browser target, React + `@floom/renderer` marked as externals) and writes the bundle to `DATA_DIR/renderers/<slug>.js`. Source cap is 512 KB per `renderer.tsx`. Compiled bundle cap is 256 KB post-minification — trim or split if you hit it.

The renderer receives four props from `@floom/renderer/contract`:

```tsx
import React from 'react';
import type { RenderProps } from '@floom/renderer/contract';

export default function FlyFastRenderer({ state, data, error }: RenderProps) {
  if (state === 'input-available') return <div>Searching flights…</div>;
  if (state === 'output-error')    return <div>Error: {error?.message}</div>;

  const flights = (data as { results: Flight[] })?.results ?? [];
  return flights.map((f, i) => <FlightCard key={i} flight={f} />);
}
```

Invocation states are mutually exclusive: `input-available`, `output-available`, `output-error`. If the renderer crashes at runtime, the client falls back to the default shape renderer (`output_shape` in the manifest). Error states always use Floom's default `ErrorOutput` card so error UX stays consistent across apps.

Reference: `examples/flyfast/` in the repo ships a complete `apps.yaml` + `openapi.yaml` + `renderer.tsx`.

## Run long jobs with the async queue

Some apps (research agents, paper generators, slow ML pipelines) take 10-20 minutes to finish. Blocking an HTTP request that long is wrong: proxies kill the connection, MCP clients time out, users get no feedback.

Declare `async: true` in the app's `apps.yaml` entry:

```yaml
apps:
  - slug: openpaper
    type: proxied
    openapi_spec_url: https://api.openpaper.dev/openapi.json
    auth: bearer
    secrets: [OPENPAPER_API_TOKEN]
    async: true
    async_mode: poll           # poll | webhook | stream
    timeout_ms: 1800000        # 30 minutes
    retries: 2
    webhook_url: https://my-collector/hook
```

Every `run` call now flows through `POST /api/:slug/jobs` → `GET /api/:slug/jobs/:job_id` → webhook. The background worker polls the queue at `FLOOM_JOB_POLL_MS` intervals, claims jobs, dispatches them, enforces `timeout_ms`, retries N times, delivers webhooks with 5xx backoff.

Async runs are surfaced on `/me/runs` alongside synchronous runs with a progress indicator while they're pending. The MCP `tools/call` response returns immediately with a job-started payload instead of waiting, so Claude Desktop can kick off a long run and come back to it later.

See [`POST /api/:slug/jobs`](/docs/api) in the API reference for the full request/response shape.

## Install your app in Claude Desktop

Every Floom app is an MCP server at `/mcp/app/:slug`. Claude Desktop reads MCP config from `~/Library/Application Support/Claude/claude_desktop_config.json`.

Four steps, all surfaced in the `/install` wizard on every app page:

1. **Copy the MCP URL.** It looks like `http://localhost:3051/mcp/app/petstore` (self-hosted) or `https://floom.dev/mcp/app/petstore` (Cloud).
2. **Paste into `claude_desktop_config.json`** using the `mcp-remote` bridge:

   ```json
   {
     "mcpServers": {
       "floom-petstore": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://floom.dev/mcp/app/petstore"]
       }
     }
   }
   ```

3. **Restart Claude Desktop.** The new server appears in the MCP picker.
4. **If the app declares secrets**, supply them per call through the `_auth` object on the tool's input schema. Claude Desktop auto-prompts on first call.

`mcp-remote` is needed because Claude Desktop as of April 2026 speaks stdio MCP, not HTTP MCP. `mcp-remote` bridges stdio → HTTP for you.

The same MCP URL works in Cursor, Continue, MCP Inspector, and any other MCP client that speaks the Streamable HTTP transport.
