# @floom/e2b-runtime

The e2b-backed runtime for Floom v2. Wraps any GitHub repo (MCP server, CLI tool, Python library) into a runnable sandbox with auto-generated manifest.

## What it does

- **Auto-detects** the runtime, build command, and run command for any public GitHub repo.
- **Deploys** it to an e2b sandbox: clone, build, smoke test, pause.
- **Runs** it on demand via a warm pause/connect cycle (~600ms cold start vs ~20-300s fresh build).
- Returns streaming stdout so the caller (web renderer, CLI, or MCP client) can render output as it arrives.

## Install

This is a local package under `/opt/floom-e2b-runtime`. Not yet published to npm.

```bash
# From the floom repo (future integration):
npm install /opt/floom-e2b-runtime
```

## Public API

```typescript
import { deployFromGithub, runApp, buildTemplate, resumeFromSnapshot } from '@floom/e2b-runtime';
import { generateManifest } from '@floom/e2b-runtime/manifest';
import { detect } from '@floom/e2b-runtime/detect';
```

### `deployFromGithub(repoUrl, options) → DeployResult`

Full pipeline: fetch GitHub snapshot, auto-detect runtime, generate manifest, spin up e2b sandbox, clone repo, build, smoke test, pause. Returns a `DeployResult` with `templateId` for warm reuse.

```typescript
const result = await deployFromGithub('owner/repo', {
  smokeWithHelp: true,     // append --help to smoke test (default: true)
  onStream: (chunk) => ..., // stream build output
  githubToken: '...',       // for private repos
});
// result.templateId = paused sandbox id for runApp warm path
```

### `runApp(manifest, inputs, secrets, onStream, options) → RunResult`

Run a Floom app. Warm path (paused sandbox) or cold path (fresh base sandbox).

```typescript
const result = await runApp(
  manifest,
  { topic: 'floom' },    // input values
  { OPENAI_API_KEY: '...' },  // injected as env vars
  (chunk) => process.stdout.write(chunk),
  { reuseSandboxId: templateId },  // warm path
);
// result.sandboxId = new paused id for next call
```

### `buildTemplate(sandbox, manifest) → string`

Pre-bake a template for a manifest. Runs the build command in the given sandbox, pauses, returns the templateId.

### `resumeFromSnapshot(snapshotId) → Sandbox`

Resume a paused sandbox by id. Caller owns the sandbox and must pause or kill when done.

## Auto-detect ruleset (5 Suite H fixes)

| Fix | Rule | Trigger |
|-----|------|---------|
| `workdir-detect` | Deepest-manifest detection | Monorepos with Go/Python in a subdir |
| `pnpm-detect` | `workspace:*` in package.json | BrowserMCP, any pnpm workspace |
| `uv-detect` | `uv.lock` or PEP 723 `# /// script` | karpathy/autoresearch, uv projects |
| `src-layout` | `[tool.setuptools.packages.find]` + `src/` dir | crewAI, FastAPI, most modern Python packages |
| `php-ext` | `ext-*` in composer.json `require` | aimeos/ai-client-html, PHP extensions |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/deploy-github.ts` | CLI: deploy a GitHub repo and print the DeployResult JSON |
| `scripts/opendraft-e2e.ts` | End-to-end proof: deploy OpenDraft + runApp warm path |
| `scripts/rerun-suite-h.ts` | Validate Suite H 10-repo sample with 5 fixes applied |
| `scripts/build-templates.ts` | Pre-bake templates for the top Floom apps |

```bash
# Deploy a repo
export E2B_API_KEY=...
npx tsx scripts/deploy-github.ts owner/repo

# Run e2e proof
npx tsx scripts/opendraft-e2e.ts

# Validate Suite H
npx tsx scripts/rerun-suite-h.ts
```

## Tests

```bash
# Unit tests (pure logic, no network, no sandbox)
npx tsx --test tests/detect/*.test.ts   # 29 tests: detect rules
npx tsx --test tests/runtime/*.test.ts  # 13 tests: executor + manifest parser

# All tests
npm test && npm run test:runtime
```

42 unit tests total, all passing.

## Environment

Requires `E2B_API_KEY` in the environment or in `/opt/floom-marketplace-deploy/.env`.

```bash
export E2B_API_KEY=e2b_...
```

## Architecture

```
deployFromGithub(repoUrl)
  └── fetchSnapshotFromApi       GitHub API, no sandbox
  └── generateManifest           auto-detect + YAML generation
  └── openSandbox                e2b base template
  └── cloneInSandbox             git clone --depth 1
  └── runBuildStep               pip install / npm install / etc
  └── smokeTest                  run --help or default inputs
  └── pauseForReuse              returns templateId

runApp(manifest, inputs, secrets, onStream)
  └── resumeFromSnapshot         ~600ms warm connect
  └── execute                    run command, stream stdout
  └── pauseForReuse              returns new sandboxId
```

See `/opt/floom-marketplace-src/docs/architecture/` for the full design docs.
