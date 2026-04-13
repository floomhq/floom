/**
 * Pre-baked template management.
 *
 * In the Floom v2 model, a "template" is just a paused e2b sandbox that has
 * already had its build step run. We don't use the e2b template-build API
 * (which requires a Dockerfile and 30+s build) — we use the much cheaper
 * "create -> build -> pause" dance, which leaves a sandbox id callable via
 * `Sandbox.connect`.
 *
 * Per Suite G of h2-full-tests.md:
 *   - Snapshot spawn ~2.4s median, 1.4s warm, 4.3s cold (cache locality)
 *   - Fresh install ~23s median
 *   - 9.6x speedup from pre-baking
 *
 * So: every deploy pauses post-build. Every run connects to that pause.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { closeSandbox, openSandbox, manifestMetadata } from './sandbox.ts';
import { runShell } from './executor.ts';
import type { Manifest } from './types.ts';
import { Timer } from '../lib/timing.ts';
import { logger } from '../lib/logger.ts';

export interface BuildTemplateResult {
  templateId: string;
  buildMs: number;
  buildLog: string;
  totalMs: number;
}

/**
 * Run the manifest's `build` command in a fresh sandbox, then pause it and
 * return the sandbox id for later use as a warm template.
 *
 * The source code must already be present in the sandbox. Typically the
 * caller has cloned the repo via `deploy/clone.ts` before calling this.
 */
export async function buildTemplate(
  sandbox: Sandbox,
  manifest: Manifest,
): Promise<BuildTemplateResult> {
  const timer = new Timer();
  timer.start('total');

  if (!manifest.build) {
    throw new Error(
      `Manifest has no build command. Cannot bake a template for ${manifest.name}.`,
    );
  }

  let buildLog = '';

  timer.start('build');
  const cwd = manifest.workdir ? `cd ${manifest.workdir} && ` : '';
  const result = await runShell(sandbox, `${cwd}${manifest.build}`, {
    timeoutMs: 600_000, // 10 min — builds can be slow (Suite A showed 22s pip install)
    onStream: (chunk: string) => {
      buildLog += chunk;
    },
  });
  const buildMs = timer.end('build');

  if (result.exitCode !== 0) {
    throw new BuildError(
      `Build failed with exit code ${result.exitCode}`,
      buildLog,
      result.exitCode,
    );
  }

  // Pause — this is the "pre-bake" step. See H2 Test 4A for why pause/connect
  // is strictly better than createSnapshot.
  const templateId = await closeSandbox(sandbox, { pause: true });
  if (!templateId) {
    throw new Error('Failed to pause sandbox after build');
  }

  const totalMs = timer.end('total');
  logger.info('buildTemplate.ok', {
    manifest: manifest.name,
    templateId,
    buildMs,
    totalMs,
  });

  return { templateId, buildMs, buildLog, totalMs };
}

/**
 * Resume a previously paused sandbox. The caller is responsible for calling
 * `closeSandbox({pause:true})` again when they're done so the warm state is
 * preserved for the next call.
 */
export async function resumeFromSnapshot(snapshotId: string): Promise<Sandbox> {
  return openSandbox({ sandboxId: snapshotId, timeoutMs: 300_000 });
}

/**
 * Create a fresh sandbox and (optionally) attach manifest metadata so the
 * sandbox is identifiable in `Sandbox.list`. This is the cold-path entry
 * point for an app that has not been pre-baked.
 */
export async function createColdSandbox(
  manifest: Manifest,
  envs: Record<string, string> = {},
): Promise<Sandbox> {
  if (manifest.memoryMb && manifest.memoryMb > 512) {
    // KNOWN GAP: the JS SDK does NOT expose per-instance memory today.
    // We record the intent in metadata and warn; the real fix is to build a
    // custom template with `memoryMB` set at template-build time.
    logger.warn('memoryMb requested but not enforceable', {
      manifest: manifest.name,
      memoryMb: manifest.memoryMb,
      note:
        'e2b SDK v2.19 only accepts memoryMB at template build time. The sandbox '
        + 'will run with the base template default (~482 MB). Bake a per-app template '
        + 'to enforce the memoryMb limit.',
    });
  }

  return openSandbox({
    template: 'base',
    timeoutMs: 600_000,
    envs,
    metadata: manifestMetadata(manifest),
  });
}

export class BuildError extends Error {
  constructor(
    message: string,
    public readonly buildLog: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'BuildError';
  }
}
