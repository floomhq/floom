/**
 * Public manifest + result types for @floom/runtime.
 *
 * These are shared across every provider (ax41-docker, fly-machines,
 * e2b-if-we-revive-it). Keep them stable: add fields, don't rename or
 * remove.
 *
 * Grounding docs:
 *   - docs/PRODUCT.md — why the pipeline exists and who it serves
 *   - h2-suite-h-random-repos.md — `workdir` comes from Go monorepo case
 *   - h2-full-tests.md — `memoryMb` tracks the OOM finding from Suite D
 */

export type Runtime =
  | 'python3.12'
  | 'python3.11'
  | 'node20'
  | 'node22'
  | 'go1.22'
  | 'rust'
  | 'docker'
  | 'auto';

export type InputType = 'string' | 'number' | 'boolean' | 'file' | 'json';

export interface Input {
  name: string;
  type: InputType;
  required: boolean;
  default?: unknown;
  label?: string;
  description?: string;
  placeholder?: string;
  /**
   * Where to inject the input.
   *   - argv   pass as `--<name> <value>` on the run command line
   *   - env    pass as environment variable `<NAME>=<value>`
   *   - stdin  feed on stdin before running
   *
   * Defaults to 'argv' when omitted.
   */
  from?: 'argv' | 'env' | 'stdin';
}

export type OutputType = 'markdown' | 'json' | 'html' | 'stdout' | 'file';

export interface Output {
  type: OutputType;
  /** For `file` output, the in-container path to read back after the run. */
  field?: string;
}

export interface Manifest {
  /** slug-safe, lowercase. Used as part of the app identifier. */
  name: string;
  displayName: string;
  description: string;
  creator: string;
  category?: string;

  runtime: Runtime;
  /** Shell command run once at build/deploy time (e.g. `pip install -e .`). */
  build?: string;
  /** Shell command run every time the app is invoked. */
  run: string;

  inputs: Input[];
  outputs: Output;

  /**
   * Names of env vars that must be supplied at run time (e.g. `OPENAI_API_KEY`).
   * The provider injects these into the container/VM env before running.
   */
  secrets?: string[];

  /** Memory request in MB. Provider-dependent defaults. */
  memoryMb?: number;

  /** Default timeout for `run`. Accepts `'60s'`, `'5m'`, or a raw ms number. */
  timeout?: string;

  /** For monorepos: relative path inside the clone to the actual package. */
  workdir?: string;

  /** Egress allowlist (host:port patterns). Not enforced today. */
  egressAllowlist?: string[];
}

/**
 * Result of a deploy pipeline run. The caller (server route, CLI) turns
 * this into a registry entry + SSE response.
 */
export interface DeployResult {
  success: boolean;
  manifest?: Manifest;
  /** Provider-opaque artifact id for re-running this app. */
  artifactId?: string;
  /** Which provider produced the artifact (for dispatch on re-run). */
  provider?: string;
  /** Commit SHA the artifact was built from. */
  commitSha?: string;
  /** Tail of the build log, suitable for UI display. */
  buildLog?: string;
  /**
   * When auto-detect fails, the pipeline ships a best-effort draft YAML
   * that the user can edit and resubmit.
   */
  draftManifest?: string;
  /** Human-readable error string on failure. */
  error?: string;
  /** Smoke-test response body (first few KB) on success. */
  smokeTestOutput?: string;
}
