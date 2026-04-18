# @floom/runtime

The repo→hosted deployment pipeline for Floom. Auto-detects a GitHub repo's
runtime, generates a Floom manifest, and hands off to a pluggable runtime
provider that clones, builds, runs, and smoke-tests the app.

Day-one provider: `Ax41DockerProvider` — runs on the same Docker daemon as
Floom itself. Future providers (Fly Machines, Firecracker, Modal) implement
the same `RuntimeProvider` interface so swaps are isolated.

See [`docs/PRODUCT.md`](../../docs/PRODUCT.md) for the product framing and
isolation model.

## Install

Workspace-local package. Not published to npm.

## Public API

```typescript
import {
  deployFromGithub,
  Ax41DockerProvider,
  type DeployResult,
  type RuntimeProvider,
} from '@floom/runtime';
```

### `deployFromGithub(repoUrl, options) → Promise<DeployResult>`

Orchestrates the full repo→hosted flow:

1. Fetches GitHub metadata (API-only, no clone yet).
2. Runs auto-detect via `@floom/manifest` → draft manifest.
3. Hands off to `options.provider`: `clone` → `build` → `run` → `smokeTest`.
4. On success: `DeployResult { success: true, artifactId, manifest, commitSha, provider }`.
5. On failure: `DeployResult { success: false, error, draftManifest?, ... }`.

On any failure after clone, the pipeline destroys the provider's working
directory so we don't leak state.

```typescript
import { deployFromGithub, Ax41DockerProvider } from '@floom/runtime';

const provider = new Ax41DockerProvider();
const result = await deployFromGithub('https://github.com/owner/repo', {
  provider,
  ref: 'main',
  githubToken: process.env.GITHUB_TOKEN,
  onLog: (chunk) => process.stdout.write(chunk),
});
```

## RuntimeProvider interface

A backend must implement five methods (see `src/provider/types.ts`):

- `clone(source) → RepoSnapshot` — fetch source into a provider-owned dir.
  Must scrub any GitHub token out of on-disk artifacts before returning.
- `build(snapshot, opts) → BuiltArtifact` — turn source into a runnable
  image/VM/whatever.
- `run(opts) → RunningInstance` — start an instance of the artifact.
- `smokeTest(instance, probe?) → SmokeResult` — HTTP probe the instance.
- `destroySnapshot(snapshot)` — clean up the working directory.

## Ax41DockerProvider status

- `clone` — local `git clone --depth 1`, token scrubbed from `.git/config`.
- `build` — `docker build` in the manifest `workdir` (or repo root). If the
  repo has no `Dockerfile`, Floom writes `floom-entry.sh` + `Dockerfile.floom`
  from the detected `build` / `run` commands and sets `EXPOSE 8080` (override
  with a `Dockerfile` + `EXPOSE` if your app uses another port).
- `run` — `docker run -d --rm -p 127.0.0.1::<containerPort> -m … --cpus …`.
- `smokeTest` — HTTP GET retries against `instance.url` (defaults to accepting
  status 200–499 so JSON APIs that 404 on `/` still pass).
- `destroySnapshot` — removes the clone working directory.

Still not wired: `POST /api/deploy-github`, `/build` “host this repo” tile, and
per-user deploy quotas — those live in `apps/server` + `apps/web`.
