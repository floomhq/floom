/**
 * Public API surface of @floom/e2b-runtime.
 *
 * Callers should only import from this file. The submodules (sandbox,
 * executor, template, snapshot) are implementation details and may change.
 *
 * High-level API:
 *   - runApp(manifest, inputs, secrets, onStream)
 *   - deployFromGithub(repoUrl, options)
 *   - buildTemplate(manifest) — pre-bake a warm snapshot
 *   - resumeFromSnapshot(snapshotId) — open a paused sandbox
 */
export type {
  Manifest,
  Input,
  InputType,
  Output,
  OutputType,
  Runtime,
  RunResult,
  RunTiming,
  DeployResult,
  RunOptions,
} from './types.ts';

import type {
  Manifest,
  RunResult,
  RunTiming,
  RunOptions,
} from './types.ts';
import type { Sandbox } from '@e2b/code-interpreter';

import { execute } from './executor.ts';
import { createColdSandbox, resumeFromSnapshot as _resumeFromSnapshot, buildTemplate as _buildTemplate } from './template.ts';
import { pauseForReuse } from './snapshot.ts';
import { closeSandbox } from './sandbox.ts';
import { logger } from '../lib/logger.ts';

/**
 * Run a Floom app end-to-end: open (or resume) a sandbox, inject secrets,
 * run the command, stream stdout back, pause (for reuse) or kill.
 *
 * Warm path (inputs.reuseSandboxId set):
 *   resume(sandboxId) -> run -> pause -> return
 *
 * Cold path (inputs.reuseSandboxId unset):
 *   create(base) -> (build is assumed already done) -> run -> pause -> return
 *
 * NOTE: runApp does NOT run the build step. The caller is expected to have
 * called buildTemplate or deployFromGithub first to produce a warm
 * sandboxId. runApp on a cold sandbox with no pre-build will still work for
 * self-contained run commands (e.g. `python -c "print(1)"`).
 */
export async function runApp(
  manifest: Manifest,
  inputs: Record<string, unknown>,
  secrets: Record<string, string>,
  onStream: (chunk: string) => void,
  options: RunOptions = {},
): Promise<RunResult> {
  const totalStart = Date.now();
  const pauseAfter = options.pauseAfter ?? true;

  let sandbox: Sandbox;
  let coldStartMs: number;

  if (options.reuseSandboxId) {
    // Warm path: reconnect to a paused sandbox. Per H2 Test 4A: ~611ms median.
    const t0 = Date.now();
    sandbox = await _resumeFromSnapshot(options.reuseSandboxId);
    coldStartMs = Date.now() - t0;
  } else {
    // Cold path: fresh base sandbox. Per H2 Test 1: ~640ms median.
    const t0 = Date.now();
    sandbox = await createColdSandbox(manifest, secrets);
    coldStartMs = Date.now() - t0;
  }

  try {
    const execResult = await execute(sandbox, manifest, inputs, {
      onStream,
      secrets,
      timeoutMs: options.timeoutMs,
    });

    let pauseMs: number | undefined;
    let sandboxId = sandbox.sandboxId;

    if (pauseAfter) {
      const t0 = Date.now();
      const paused = await pauseForReuse(sandbox);
      pauseMs = Date.now() - t0;
      sandboxId = paused;
    } else {
      await closeSandbox(sandbox, { pause: false });
    }

    const timingMs: RunTiming = {
      coldStartMs,
      runMs: execResult.runMs,
      pauseMs,
      totalMs: Date.now() - totalStart,
    };

    logger.info('runApp.ok', {
      manifest: manifest.name,
      exitCode: execResult.exitCode,
      sandboxId,
      timingMs,
    });

    return {
      exitCode: execResult.exitCode,
      output: execResult.stdout,
      stderr: execResult.stderr,
      timingMs,
      sandboxId,
    };
  } catch (err) {
    // Best-effort cleanup; if pause fails, kill so we don't leak a sandbox.
    await closeSandbox(sandbox, { pause: false });
    throw err;
  }
}

/**
 * Deploy a GitHub repo end-to-end: clone, auto-detect, generate manifest,
 * build, smoke test. Returns a DeployResult with the paused `templateId`
 * ready to be called via runApp({ reuseSandboxId: templateId }).
 *
 * This is the logic that will later run inside the `floom-deploy` app's
 * own sandbox (see h5-h6-recursion-failure-ux.md for the recursive model).
 */
export { deployFromGithub } from '../deploy/pipeline.ts';

/**
 * Pre-bake a template for a manifest. Caller must have an already-open
 * sandbox with the source code cloned inside. Returns the paused sandbox id.
 *
 * For end-to-end "repo URL -> ready template", use `deployFromGithub`.
 */
export async function buildTemplate(
  sandbox: Sandbox,
  manifest: Manifest,
): Promise<string> {
  const result = await _buildTemplate(sandbox, manifest);
  return result.templateId;
}

/**
 * Resume a paused sandbox by id. The caller owns the returned sandbox and
 * must call `pauseForReuse` or `closeSandbox` when done.
 */
export async function resumeFromSnapshot(snapshotId: string): Promise<Sandbox> {
  return _resumeFromSnapshot(snapshotId);
}
