/**
 * Public types for the Floom e2b runtime v2.
 *
 * These are the types the Floom backend (and any future caller) will
 * import. Keep them stable. If you need to evolve them, add fields, don't
 * rename or remove.
 *
 * Grounding docs:
 *   - github-to-sandbox.md (the original architecture)
 *   - h2-full-tests.md (memory_mb comes from Suite D OOM finding)
 *   - h5-h6-recursion-failure-ux.md (deploy output contract)
 *   - h2-suite-h-random-repos.md (workdir comes from Go monorepo case)
 *
 * NOTE: `Runtime` type is defined in @floom/detect (the lowest-level package)
 * to avoid circular dependencies. It is re-exported here for convenience.
 */

export type { Runtime } from '@floom/detect';

export type InputType = 'string' | 'number' | 'boolean' | 'file' | 'json';

export interface Input {
  name: string;
  type: InputType;
  required: boolean;
  /**
   * JSON-serialisable default. We use `unknown` (not `any`) because the
   * runtime does not need to introspect the shape — it is simply passed
   * through to the sandbox as argv or env.
   */
  default?: unknown;
  label?: string;
  description?: string;
  placeholder?: string;
  /**
   * Where to inject the input.
   *   - argv    pass as `--<name> <value>` on the run command line
   *   - env     pass as environment variable `<NAME>=<value>`
   *   - stdin   feed on stdin before running
   *
   * Defaults to 'argv' when omitted.
   */
  from?: 'argv' | 'env' | 'stdin';
}

export type OutputType = 'markdown' | 'json' | 'html' | 'stdout' | 'file';

export interface Output {
  type: OutputType;
  /** For `file` output, the in-sandbox path to read back after the run. */
  field?: string;
}

export interface Manifest {
  /** slug-safe, lowercase. Used as part of the app identifier. */
  name: string;
  displayName: string;
  description: string;
  creator: string;
  category?: string;

  runtime: import('@floom/detect').Runtime;
  /** Shell command run once at build/deploy time (e.g. `pip install -e .`). */
  build?: string;
  /** Shell command run every time the app is invoked. */
  run: string;

  inputs: Input[];
  outputs: Output;

  /**
   * Names of env vars that must be supplied at run time (e.g. `OPENAI_API_KEY`).
   * The runtime will inject these into the sandbox env before running.
   */
  secrets?: string[];

  /**
   * Memory request in MB. Default 512 (the e2b base template spec).
   */
  memoryMb?: number;

  /** Default timeout for `run`. Accepts `'60s'`, `'5m'`, or a raw ms number. */
  timeout?: string;

  /** For monorepos: relative path inside the clone to the actual package. */
  workdir?: string;

  /**
   * Egress allowlist (host:port patterns). Not enforced by e2b today.
   */
  egressAllowlist?: string[];
}

export interface RunTiming {
  /** Time between Sandbox.create/connect and first command dispatch. */
  coldStartMs: number;
  /** Time between `run` command dispatch and its exit. */
  runMs: number;
  /** Time to pause the sandbox after the run (warm path only). */
  pauseMs?: number;
  /** Total wall time from entering runApp to returning. */
  totalMs: number;
}

export interface RunResult {
  exitCode: number;
  output: string;
  /**
   * Stderr output. Useful for debugging; the web renderer typically only
   * surfaces this when exitCode != 0.
   */
  stderr: string;
  timingMs: RunTiming;
  /**
   * The sandbox ID that can be passed back as `options.reuseSandboxId` on the
   * next runApp call to take the warm path (pause/connect) instead of cold.
   */
  sandboxId: string;
}

export interface DeployResult {
  success: boolean;
  manifest?: Manifest;
  /**
   * e2b sandbox id of the PAUSED, post-build sandbox. Use this as the warm
   * template for subsequent runs of this app.
   */
  templateId?: string;
  smokeTestOutput?: string;
  error?: string;
  /**
   * When auto-detect fails, the runtime ships a best-effort draft YAML that
   * the user can edit and resubmit. See h5-h6-recursion-failure-ux.md
   * Scenario 2 for the "?"-comment convention.
   */
  draftManifest?: string;
  buildLog?: string;
}

export interface RunOptions {
  /** Reuse an existing paused sandbox (warm path). */
  reuseSandboxId?: string;
  /** Override manifest timeout. */
  timeoutMs?: number;
  /**
   * If true, sandbox is paused after the run instead of killed. Returns the
   * sandbox id in RunResult.sandboxId for later reuse.
   *
   * Default true — this is the Floom v2 fast-resume model.
   */
  pauseAfter?: boolean;
}
