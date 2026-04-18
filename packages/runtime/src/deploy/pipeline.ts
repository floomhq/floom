/**
 * `deployFromGithub` — the top-level orchestrator.
 *
 * Shape: repo URL in, DeployResult out. Behind the scenes it runs:
 *   1. Fetch repo metadata via GitHub API (no clone yet).
 *   2. Auto-detect runtime + generate a manifest with @floom/manifest.
 *   3. Hand off to the configured RuntimeProvider:
 *        provider.clone -> provider.build -> provider.run -> provider.smokeTest
 *   4. On success: return DeployResult with artifactId + manifest + commit.
 *      On failure: destroySnapshot and return DeployResult with the error +
 *      (when detect succeeded) the draft manifest for UX retries.
 *
 * Server wiring (`POST /api/deploy-github`) + the `/build` UI tile live in
 * apps/server and apps/web respectively and drive this function.
 */
import { generateManifest } from '@floom/manifest';

import { logger } from '../lib/logger.ts';
import type { DeployResult } from '../runtime/types.ts';
import { fetchSnapshotFromApi, parseRepoUrl } from './clone.ts';
import type { RuntimeProvider } from '../provider/types.ts';

export interface DeployOptions {
  /** Runtime provider to use (ax41-docker in MVP). */
  provider: RuntimeProvider;
  /** Branch, tag, or commit SHA. Defaults to repo's default branch. */
  ref?: string;
  /** GitHub token for private repos. */
  githubToken?: string;
  /** Streams build-log chunks to caller (SSE-friendly). */
  onLog?: (chunk: string) => void;
  /**
   * Manifest overrides merged on top of the auto-detected result. Used when
   * the user edited the draft manifest and is retrying with their fix.
   */
  manifestOverride?: Parameters<typeof generateManifest>[1];
}

export async function deployFromGithub(
  repoUrl: string,
  opts: DeployOptions,
): Promise<DeployResult> {
  const { provider, ref, githubToken, onLog, manifestOverride } = opts;
  const startedAt = Date.now();

  // Phase 1: parse URL.
  let repoRef;
  try {
    repoRef = parseRepoUrl(repoUrl);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Phase 2: fetch repo metadata for auto-detect.
  let snapshotMeta;
  try {
    snapshotMeta = await fetchSnapshotFromApi(repoUrl, { ref, githubToken });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('deploy.fetch-failed', { repoUrl, error: msg });
    return {
      success: false,
      error: `Could not fetch ${repoRef.owner}/${repoRef.name} from GitHub: ${msg}`,
    };
  }

  // Phase 3: auto-detect + manifest generation.
  const gen = generateManifest(snapshotMeta, manifestOverride);
  if (!gen.manifest) {
    return {
      success: false,
      error: `Auto-detect could not produce a runnable manifest for ${repoRef.owner}/${repoRef.name}`,
      draftManifest: gen.yaml,
    };
  }
  const manifest = gen.manifest;
  logger.info('deploy.detect-ok', {
    manifest: manifest.name,
    fixes: gen.detect.fixesApplied,
    warnings: gen.detect.warnings,
  });

  // Phase 4: provider.clone — clone into provider-owned working directory.
  let snapshot;
  try {
    snapshot = await provider.clone({ url: repoUrl, ref, githubToken });
  } catch (err) {
    return {
      success: false,
      error: `Clone failed: ${err instanceof Error ? err.message : String(err)}`,
      manifest,
      draftManifest: gen.yaml,
    };
  }

  // From here on, any failure destroys the snapshot before returning so we
  // don't leak clone directories.
  try {
    // Phase 5: provider.build — turn snapshot into runnable artifact.
    const artifact = await provider.build(snapshot, { manifest, onLog });

    // Phase 6: provider.run — start an instance. Empty env for smoke test:
    // the goal is "does the server come up?", not "does every code path work".
    const instance = await provider.run({ artifact, env: {} });

    try {
      // Phase 7: smoke test — health probe against the running instance.
      const smoke = await provider.smokeTest(instance);

      if (!smoke.passed) {
        return {
          success: false,
          error: smoke.lastError
            ? `Smoke test failed: ${smoke.lastError}`
            : `Smoke test failed (last status ${smoke.lastStatus ?? 'n/a'} after ${smoke.attempts} attempts)`,
          manifest,
          draftManifest: gen.yaml,
          provider: provider.name,
        };
      }

      logger.info('deploy.ok', {
        manifest: manifest.name,
        provider: provider.name,
        commitSha: snapshot.commitSha,
        totalMs: Date.now() - startedAt,
      });

      return {
        success: true,
        manifest,
        artifactId: artifact.id,
        provider: provider.name,
        commitSha: snapshot.commitSha,
      };
    } finally {
      // Always stop the smoke-test instance. The artifact lives on in the
      // provider's registry for later re-runs.
      await instance.stop().catch((err) => {
        logger.warn('deploy.instance-stop-failed', {
          instanceId: instance.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('deploy.failed', { repoUrl, error: msg });
    return {
      success: false,
      error: msg,
      manifest,
      draftManifest: gen.yaml,
      provider: provider.name,
    };
  } finally {
    await provider.destroySnapshot(snapshot).catch((err) => {
      logger.warn('deploy.destroy-snapshot-failed', {
        snapshotId: snapshot.snapshotId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
