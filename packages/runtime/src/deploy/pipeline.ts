/**
 * `deployFromGithub` — the top-level deploy orchestrator.
 *
 * Steps (from h5-h6-recursion-failure-ux.md §"What floom-deploy does"):
 *   1. Validate URL + fetch repo snapshot via GitHub API (no sandbox yet).
 *   2. Auto-detect runtime/build/run, apply the 5 Suite H fixes.
 *   3. Generate a floom.yaml. If incomplete, return a draft for the user.
 *   4. Spin up an e2b sandbox, clone the repo with git, run the build.
 *   5. Smoke test with default inputs.
 *   6. On success: pause the sandbox, return `templateId` + manifest + smoke
 *      output as a DeployResult.
 *   7. On failure: return a DeployResult with `error`, the build log, and
 *      the draft manifest so the caller can present H6-style failure UX.
 */
import type { Manifest, DeployResult } from '../runtime/types.ts';
import { fetchSnapshotFromApi, cloneInSandbox, parseRepoUrl, WORKSPACE_PATH } from './clone.ts';
import { generateManifest } from '@floom/manifest';
import { runBuildStep } from './build.ts';
import { smokeTest } from './smoke-test.ts';
import { openSandbox, closeSandbox, manifestMetadata } from '../runtime/sandbox.ts';
import { Timer } from '../lib/timing.ts';
import { logger } from '../lib/logger.ts';

/**
 * Rewrite the manifest so its `workdir` points inside the sandbox's
 * workspace path. The detect pass records the workdir RELATIVE to the repo
 * root; for the actual sandbox run we need the absolute path where we
 * cloned.
 */
function anchorManifestToWorkspace(manifest: Manifest): Manifest {
  const subdir = manifest.workdir ? `/${manifest.workdir}` : '';
  return { ...manifest, workdir: `${WORKSPACE_PATH}${subdir}` };
}

export interface DeployOptions {
  branch?: string;
  /**
   * Optional overrides merged into the auto-detected manifest. Used when a
   * user has already edited the draft yaml and wants to retry with their
   * changes.
   */
  override?: Partial<Manifest>;
  /**
   * If true (default), smoke-test with a `--help` flag appended to the run
   * command. This is a strong "the build worked" signal without requiring
   * real inputs or secrets. Turn off for apps whose main command produces
   * useful output without any flags.
   */
  smokeWithHelp?: boolean;
  /** GitHub token for private repos. */
  githubToken?: string;
  /** Stream builder output to this callback. */
  onStream?: (chunk: string) => void;
}

export async function deployFromGithub(
  repoUrl: string,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const timer = new Timer();
  timer.start('total');

  // Phase 1: parse URL (throws on malformed)
  let repoRef;
  try {
    repoRef = parseRepoUrl(repoUrl);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Phase 2: fetch snapshot via GitHub API (no sandbox yet)
  let snapshot;
  try {
    snapshot = await timer.measure('fetch', () =>
      fetchSnapshotFromApi(repoUrl, { ref: options.branch, githubToken: options.githubToken }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('deploy.fetch failed', { repoUrl, error: msg });
    return {
      success: false,
      error: `Could not fetch ${repoRef.owner}/${repoRef.name} from GitHub: ${msg}`,
    };
  }

  // Phase 3: auto-detect + manifest generation
  const gen = generateManifest(snapshot, options.override);
  if (!gen.manifest) {
    return {
      success: false,
      error: `Auto-detect could not produce a runnable manifest for ${repoRef.owner}/${repoRef.name}`,
      draftManifest: gen.yaml,
    };
  }
  const manifest = gen.manifest;
  logger.info('deploy.detect ok', {
    manifest: manifest.name,
    fixes: gen.detect.fixesApplied,
    warnings: gen.detect.warnings,
  });

  // Phase 4: spin up sandbox and clone
  let sandbox;
  try {
    sandbox = await timer.measure('create', () =>
      openSandbox({
        template: 'base',
        timeoutMs: 900_000, // 15 min for build-heavy apps
        metadata: manifestMetadata(manifest),
      }),
    );
  } catch (err) {
    return {
      success: false,
      error: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
      manifest,
    };
  }

  try {
    await timer.measure('clone', () =>
      cloneInSandbox(sandbox!, repoUrl, {
        branch: options.branch,
        githubToken: options.githubToken,
      }),
    );

    // Phase 5: build
    timer.start('build');
    const build = await runBuildStep(sandbox, manifest, options.onStream);
    timer.end('build');

    if (build.exitCode !== 0) {
      await closeSandbox(sandbox, { pause: false });
      return {
        success: false,
        error: `Build failed with exit code ${build.exitCode}`,
        manifest,
        draftManifest: gen.yaml,
        buildLog: tail(build.buildLog, 4000),
      };
    }

    // Phase 6: smoke test — anchor the manifest to the cloned workspace
    // path so `cd workdir && run` resolves correctly.
    const anchoredManifest = anchorManifestToWorkspace(manifest);
    timer.start('smoke');
    const smoke = await smokeTest(sandbox, anchoredManifest, {
      forceHelpFlag: options.smokeWithHelp !== false,
    });
    timer.end('smoke');

    if (!smoke.passed) {
      // Retry without --help — some apps don't support it and exit non-zero.
      let retry = smoke;
      if (options.smokeWithHelp !== false) {
        timer.start('smoke-retry');
        retry = await smokeTest(sandbox, anchoredManifest, { forceHelpFlag: false });
        timer.end('smoke-retry');
      }
      if (!retry.passed) {
        await closeSandbox(sandbox, { pause: false });
        return {
          success: false,
          error: `Smoke test failed: ${retry.reason}`,
          manifest,
          draftManifest: gen.yaml,
          smokeTestOutput: retry.stdout + '\n---STDERR---\n' + retry.stderr,
          buildLog: tail(build.buildLog, 2000),
        };
      }
      // Retry succeeded — fall through with the retry's output
      const templateId = await pauseAndReturn(sandbox);
      timer.end('total');
      // Return the ANCHORED manifest so subsequent runApp calls against
      // the templateId cd into the workspace.
      return successResult(anchoredManifest, templateId, retry.stdout, timer, build.buildLog);
    }

    // Phase 7: pause for warm reuse
    const templateId = await pauseAndReturn(sandbox);
    timer.end('total');
    return successResult(anchoredManifest, templateId, smoke.stdout, timer, build.buildLog);
  } catch (err) {
    try {
      await closeSandbox(sandbox, { pause: false });
    } catch {
      // ignore
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      manifest,
      draftManifest: gen.yaml,
    };
  }
}

async function pauseAndReturn(sandbox: {
  sandboxId: string;
  pause: () => Promise<boolean>;
}): Promise<string> {
  await sandbox.pause();
  return sandbox.sandboxId;
}

function successResult(
  manifest: Manifest,
  templateId: string,
  smokeOutput: string,
  _timer: Timer,
  buildLog: string,
): DeployResult {
  return {
    success: true,
    manifest,
    templateId,
    smokeTestOutput: smokeOutput,
    buildLog: tail(buildLog, 2000),
  };
}

function tail(s: string, bytes: number): string {
  if (!s) return '';
  if (s.length <= bytes) return s;
  return '...' + s.slice(-bytes);
}
