/**
 * RuntimeProvider — the abstraction a sandbox/host backend must implement
 * to plug into Floom's repo->hosted pipeline.
 *
 * Three pieces:
 *   1. `clone` fetches a git repo into a working directory the provider owns.
 *   2. `build` turns that working directory into a runnable artifact (a
 *      Docker image, a Fly machine, a Firecracker VM, etc.).
 *   3. `run` + `smokeTest` + `stop` manage the artifact's lifecycle on the
 *      host/sandbox.
 *
 * Day-one implementation: `Ax41DockerProvider` in `./ax41-docker.ts` — plain
 * Docker on the Floom host. Future providers (Fly Machines, e2b, Modal,
 * Firecracker) implement the same interface so swaps are isolated.
 *
 * See docs/PRODUCT.md for why this layering exists: we ship container-level
 * isolation today with a clean seam for stronger VM-level isolation later,
 * without changing the pipeline, server route, or UI.
 */
import type { Manifest } from '../runtime/types.ts';

export interface RepoSource {
  /** `https://github.com/owner/repo` or `owner/repo`. */
  url: string;
  /** Branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string;
  /**
   * GitHub token for private repos. The provider MUST NOT persist this
   * past the clone step (no `.git/config` leak, no environment capture).
   */
  githubToken?: string;
}

export interface RepoSnapshot {
  /** Absolute path on the provider's filesystem where the repo was cloned. */
  localPath: string;
  /** Resolved commit SHA of the cloned ref. */
  commitSha: string;
  /** `owner/repo`. */
  fullName: string;
  /** Human-readable repo description if available. */
  description?: string;
  /**
   * Opaque snapshot id the provider can later use to destroy the working
   * directory. Pipeline callers should not introspect this.
   */
  snapshotId: string;
}

export interface BuildOptions {
  manifest: Manifest;
  /** Streams build-log chunks to the caller (SSE-friendly). */
  onLog?: (chunk: string) => void;
  /**
   * Build timeout. Defaults are provider-specific; Docker is 10 min, Fly
   * Machines ~5 min. Set higher for ML images with CUDA pulls.
   */
  timeoutMs?: number;
}

export interface BuiltArtifact {
  /** Provider-opaque id (Docker image tag, Fly machine id, etc.). */
  id: string;
  /** Which provider produced this artifact. Used on re-run for dispatch. */
  provider: ProviderName;
  manifest: Manifest;
  /**
   * TCP port the process listens on inside the container (from EXPOSE or
   * generated image). Used for `docker run -p 127.0.0.1::<port>`.
   */
  containerPort?: number;
  /** Build-time metrics for telemetry / billing. */
  metrics?: { buildMs: number; imageSizeBytes?: number };
}

export interface ResourceLimits {
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}

export interface RunOptions {
  artifact: BuiltArtifact;
  /** Env vars passed to the running process. Secrets are injected via this. */
  env?: Record<string, string>;
  /** Port the app listens on inside its container/VM. Defaults to 3000. */
  port?: number;
  limits?: ResourceLimits;
}

export interface RunningInstance {
  /** Provider-opaque id (container id / machine id). */
  id: string;
  /** Base URL the Floom proxy layer forwards requests to. */
  url: string;
  /** Which provider owns this instance. */
  provider: ProviderName;
  /** Stop and clean up. Idempotent. */
  stop(): Promise<void>;
}

export interface HealthProbe {
  /** HTTP path to probe, e.g. `/`, `/health`. Defaults to `/`. */
  path?: string;
  /**
   * HTTP status codes that count as healthy. Defaults to [200, 399]. Useful
   * to set [200, 499] for APIs where `/` returns 404 but the server is up.
   */
  okStatusRange?: [number, number];
  timeoutMs?: number;
  /** Retry attempts before giving up. Default 30 tries, 1s apart = 30s wall. */
  maxAttempts?: number;
}

export interface SmokeResult {
  passed: boolean;
  /** Status code of the last attempt. */
  lastStatus?: number;
  /** Round-trip time of the successful probe. */
  latencyMs?: number;
  /** Error message if all attempts failed. */
  lastError?: string;
  /** Total number of attempts made. */
  attempts: number;
}

export type ProviderName = 'ax41-docker' | 'fly-machines' | 'e2b';

export interface RuntimeProvider {
  name: ProviderName;

  clone(source: RepoSource): Promise<RepoSnapshot>;
  build(snapshot: RepoSnapshot, opts: BuildOptions): Promise<BuiltArtifact>;
  run(opts: RunOptions): Promise<RunningInstance>;
  smokeTest(instance: RunningInstance, probe?: HealthProbe): Promise<SmokeResult>;

  /**
   * Destroy a snapshot's working directory. Called after a failed build or
   * when an app is removed. Idempotent.
   */
  destroySnapshot(snapshot: RepoSnapshot): Promise<void>;
}
