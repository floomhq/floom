# Getting started

Floom is the production layer for AI apps that do real work. It takes one manifest (an OpenAPI spec plus a short `floom.yaml`) and turns it into five production surfaces at once: an HTTP endpoint, an MCP server your MCP client can dial, a CLI command, a web form at `/p/:slug`, and an MCP admin surface for programmatic app creation. Vibe-coding speed, production-grade safety.

Floom targets the shape of apps most builders ship: internal tooling, productivity apps, and weekend-project vibe-coded apps (OpenDraft, FlyFast, OpenPaper). 3-50 operations per app, JSON in, bearer or API-key auth, runtime under a few minutes with an async job queue for longer runs. Not n8n, not Lovable, not Hugging Face Spaces, not enterprise wrappers.

## Install Floom on your Mac in 60 seconds

One Docker command, no registry credentials, no build step:

```bash
docker run -p 3051:3051 \
  -v floom_data:/data \
  ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4
```

Expected output after a few seconds:

```
[floom] booting on :3051
[floom] public url http://localhost:3051
[floom] data dir /data
[floom] seeded 0 apps from apps.yaml
[floom] ready
```

Verify the server responds:

```bash
curl http://localhost:3051/api/health
# {"status":"ok","version":"0.4.0-mvp.4"}
```

Open `http://localhost:3051` in a browser. The hub is empty by default, which is exactly what you want — you now pick what apps Floom hosts.

## Create your first app from an OpenAPI URL

The fastest path: paste any OpenAPI URL into the `/build` page. Floom fetches the spec, walks `$refs`, auto-detects the base URL from `spec.servers[]`, and publishes a working app in under ten seconds.

1. Open [floom.dev/build](https://floom.dev/build) (or your self-hosted `/build`)
2. Paste a URL like `https://petstore3.swagger.io/api/v3/openapi.json`
3. Click **Detect**. Floom previews the operations inline
4. Click **Publish**. Anonymous visitors are prompted to sign up first; signed-in users go straight to the share sheet.

You now have four live surfaces for the new app:

- **Web form**: `https://floom.dev/p/petstore-<hash>` — shareable run UI
- **HTTP**: `POST /api/petstore-<hash>/run` — direct JSON calls
- **MCP per-app**: `POST /mcp/app/petstore-<hash>` — for Claude Desktop, Cursor, any MCP client
- **CLI**: `floom run petstore-<hash>/listPets --inputs '{}'`

Each surface reads from the same manifest. Change the spec, every surface updates on next request.

## Next steps

- Read the [Protocol](/docs/protocol) page for one code example per surface
- Follow the [Self-host](/docs/self-hosting) guide for `apps.yaml`, env vars, and secrets
- Learn the [API reference](/docs/api) for `POST /api/:slug/run`, `POST /api/:slug/jobs`, and the MCP admin surface
