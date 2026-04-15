# Integrating @floom/e2b-runtime into floom-monorepo

This document is for the integration pass that wires `@floom/e2b-runtime` into the `floomhq/floom-monorepo` repo (legacy name: `floom-chat`). The runtime is complete and locally verified at `/opt/floom-e2b-runtime/`.

## What this package exposes

Three capabilities:

1. **Deploy**: `deployFromGithub(repoUrl)` — takes any public GitHub repo, runs auto-detect, spins up an e2b sandbox, builds, smoke-tests, and returns a paused `templateId`.
2. **Run**: `runApp(manifest, inputs, secrets, onStream)` — connects to a paused sandbox (~600ms), executes the run command, streams stdout to the caller (the web renderer at `/p/:slug`, the CLI, or an MCP client).
3. **Detect only**: `generateManifest(repoSnapshot)` — run the auto-detect pipeline offline (no sandbox, no e2b cost) to preview what would be deployed.

## How to import

From `floom-monorepo`:

```typescript
// npm install /opt/floom-e2b-runtime  (or publish to npm first)
import { deployFromGithub, runApp } from '@floom/e2b-runtime';
import type { Manifest, RunResult, DeployResult } from '@floom/e2b-runtime';
```

## Where in floom-monorepo to add it

### 1. Replace the Docker runner

The current `apps/server/src/services/runner.ts` (or equivalent) likely creates per-app Docker containers. Replace it with a switchable runtime:

```typescript
// apps/server/src/services/runner.ts

type RuntimeKind = 'docker' | 'e2b';
const RUNTIME: RuntimeKind = process.env.FLOOM_RUNTIME as RuntimeKind ?? 'e2b';

export async function runAppRequest(req: RunRequest): Promise<RunResponse> {
  if (RUNTIME === 'e2b') {
    return runViaE2b(req);
  }
  return runViaDocker(req);
}

async function runViaE2b(req: RunRequest) {
  const result = await runApp(
    req.manifest,
    req.inputs,
    req.secrets,
    (chunk) => req.onStream(chunk),
    { reuseSandboxId: req.templateId },
  );
  return { exitCode: result.exitCode, output: result.output, sandboxId: result.sandboxId };
}
```

### 2. Add deploy endpoint

The deploy endpoint triggers `deployFromGithub` when a user pastes a GitHub URL. Wire it into the deploy request handler:

```typescript
// apps/server/src/routes/deploy.ts

import { deployFromGithub } from '@floom/e2b-runtime';

app.post('/deploy', async (req, res) => {
  const { repoUrl, override } = req.body;
  const result = await deployFromGithub(repoUrl, {
    smokeWithHelp: true,
    onStream: (chunk) => res.write(chunk),  // SSE stream
    override,
  });
  
  if (result.success && result.templateId && result.manifest) {
    // Persist: save manifest + templateId to DB
    await db.apps.upsert({
      slug: result.manifest.name,
      templateId: result.templateId,
      manifest: result.manifest,
    });
  }
  
  res.json(result);
});
```

### 3. Persist templateIds

The `templateId` is a paused e2b sandbox ID. It must be persisted so subsequent `runApp` calls can take the warm path. Add a column to the apps table:

```sql
ALTER TABLE apps ADD COLUMN template_id TEXT;
ALTER TABLE apps ADD COLUMN manifest JSONB;
```

### 4. Feature flag

Add `FLOOM_RUNTIME=e2b` to the floom-monorepo `.env.local`. Default to `docker` until the e2b path is validated in production.

## Env vars to add

```bash
# Required
E2B_API_KEY=e2b_...

# Optional
GITHUB_TOKEN=...    # for private repos
FLOOM_RUNTIME=e2b   # or docker (default)
FLOOM_LOG_DEBUG=1   # verbose logging from the runtime
```

## What you still need to build

| Item | Notes |
|------|-------|
| DB schema for `template_id` | Add to apps table migration |
| SSE streaming endpoint | Currently all runs are synchronous in floom-monorepo |
| Rate limiting for deploy | Each deploy costs ~$0.01 in e2b credit + compute |
| Error UX for draft manifests | When `isDraft: true`, show the YAML editor (H6 Scenario 2) |
| Template refresh cron | Paused sandboxes expire (check e2b TTL, default 24h) |
| Secret injection UI | Users need to provide API keys that map to `manifest.secrets` |
| Multi-tenant isolation | Each user's runs should be isolated — use per-user e2b API keys or sandboxes |

## Sandbox lifecycle

```
Deploy phase (once per repo):
  GitHub URL → auto-detect → build in sandbox → pause → templateId (store in DB)

Run phase (every user request):
  templateId → Sandbox.connect (~600ms) → execute → pause → new templateId (update DB)

Expiry:
  e2b paused sandboxes TTL. When sandbox expires, trigger redeploy from the stored manifest.
```

## Known gaps in the runtime (as of 2026-04-13)

1. **Memory limits** — `memoryMb` field in manifest is not enforced by the JS SDK (only settable at template build time). Rust and large Python apps may OOM on the 512MB default.
2. **Docker runtime** — Docker-in-Docker is not available in the default e2b template. Repos that require Docker to build/run will fail.
3. **PHP/Ruby** — The manifest coerces these to `runtime: 'auto'`. The e2b base template has PHP and Ruby installed, but Composer and Bundler may need custom templates for large deps.
4. **Private repos** — Need a `GITHUB_TOKEN` for clone. The UI needs a way to collect this at deploy time.
5. **Sandbox GC** — When `Sandbox.connect` throws `SandboxNotFoundError` (sandbox expired), the caller needs to redeploy from scratch. The runtime throws; the Floom backend must catch and redeploy.

## Files in this package

```
/opt/floom-e2b-runtime/
├── src/
│   ├── detect/     Auto-detect rules (5 Suite H fixes)
│   ├── manifest/   YAML parser + generator
│   ├── runtime/    Executor, sandbox, types
│   ├── deploy/     Clone, build, smoke test, pipeline
│   └── lib/        Logger, timer
├── tests/          42 unit tests (no network required)
├── scripts/        Deploy CLI, e2e proof, Suite H rerun
├── README.md       Public API reference
└── HANDOFF.md      This file
```
