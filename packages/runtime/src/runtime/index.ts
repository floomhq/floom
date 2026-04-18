/**
 * Public API of @floom/runtime.
 *
 * Shape:
 *   - `deployFromGithub(url, { provider })` — orchestrates a repo->hosted
 *     deployment. See `src/deploy/pipeline.ts`.
 *   - `Ax41DockerProvider` — day-one runtime backend. Uses the same Docker
 *     daemon as Floom itself. See `src/provider/ax41-docker.ts` and
 *     `docs/PRODUCT.md` for the isolation model.
 *   - `RuntimeProvider` interface — any future sandbox/host (Fly Machines,
 *     e2b, self-managed Firecracker) implements this.
 */
export type {
  Manifest,
  Input,
  InputType,
  Output,
  OutputType,
  Runtime,
  DeployResult,
} from './types.ts';

export type {
  RuntimeProvider,
  ProviderName,
  RepoSource,
  RepoSnapshot,
  BuildOptions,
  BuiltArtifact,
  RunOptions,
  RunningInstance,
  HealthProbe,
  SmokeResult,
  ResourceLimits,
} from '../provider/types.ts';

export { Ax41DockerProvider, NotImplemented } from '../provider/ax41-docker.ts';
export { deployFromGithub } from '../deploy/pipeline.ts';
export type { DeployOptions } from '../deploy/pipeline.ts';
export { buildRegistryEntry, serializeRegistryEntry } from '../deploy/register.ts';
export type { RegistryEntry } from '../deploy/register.ts';
