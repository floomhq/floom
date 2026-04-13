/**
 * Thin wrapper around the e2b Sandbox class that adds the three things
 * the Floom runtime needs and the raw SDK does not:
 *
 *   1. A consistent "open" helper that either creates a fresh sandbox or
 *      reconnects to an existing (possibly paused) one, based on whether
 *      a sandboxId was provided.
 *   2. A `pauseOrKill` helper that pauses when the caller wants the warm
 *      path, and kills otherwise, catching errors so a post-run failure
 *      never overshadows the real error.
 *   3. Injection of Floom manifest metadata (memoryMb, workdir, etc.) onto
 *      the sandbox metadata so list/inspect calls can see what an app is.
 *
 * Grounding:
 *   - H2 Test 4A/4B: pause + connect is 611ms median, createSnapshot+spawn
 *     is 4.2s, so we use pause everywhere and createSnapshot nowhere.
 *   - Suite D: SandboxNotFoundException when reconnecting to a dropped
 *     sandbox. We bubble up so the caller can rebuild from scratch.
 */
import { Sandbox } from '@e2b/code-interpreter';
import type { Manifest } from './types.ts';
import { logger } from '../lib/logger.ts';

export interface OpenOptions {
  /**
   * If provided, attempts `Sandbox.connect(sandboxId)` (auto-resume). If
   * undefined, `Sandbox.create()` with the requested template is used.
   */
  sandboxId?: string;
  /**
   * Template name/ID to use for cold-path creates. Default 'base' (the e2b
   * stock Python/Node image). If the manifest has a pre-baked templateId, the
   * caller should pass that here.
   */
  template?: string;
  /**
   * Sandbox lifetime in ms. Default 300000 (5 min). Bump to 600000 for
   * build-heavy paths. Max 1h on Hobby tier.
   */
  timeoutMs?: number;
  /** Initial env vars set on the sandbox. */
  envs?: Record<string, string>;
  /** Arbitrary metadata (all values must be strings per e2b's API). */
  metadata?: Record<string, string>;
}

export async function openSandbox(opts: OpenOptions): Promise<Sandbox> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error('E2B_API_KEY is not set in the environment');
  }

  const connectionOpts = {
    apiKey,
    timeoutMs: opts.timeoutMs ?? 300_000,
    envs: opts.envs ?? {},
    metadata: opts.metadata ?? {},
  };

  if (opts.sandboxId) {
    logger.debug('sandbox.connect', { sandboxId: opts.sandboxId });
    // If the sandbox is paused, connect auto-resumes it. If the sandbox was
    // killed or GC'd, this throws SandboxNotFoundError and we let the caller
    // handle it (typically by falling back to a fresh create).
    return Sandbox.connect(opts.sandboxId, connectionOpts);
  }

  const template = opts.template ?? 'base';
  logger.debug('sandbox.create', { template });
  // `Sandbox.create('base')` uses the default image; `Sandbox.create(id)`
  // uses a pre-baked snapshot. Same code path per H2 section 1.
  if (template === 'base') {
    return Sandbox.create(connectionOpts);
  }
  return Sandbox.create(template, connectionOpts);
}

export interface CloseOptions {
  /** Pause (warm path, returns id for reuse) or kill (cold path, frees all). */
  pause: boolean;
}

export async function closeSandbox(
  sandbox: Sandbox,
  opts: CloseOptions,
): Promise<string | undefined> {
  try {
    if (opts.pause) {
      // pause() returns a boolean (success) per the SDK types; the sandbox
      // id survives on `sandbox.sandboxId` and is what you pass to connect.
      await sandbox.pause();
      logger.debug('sandbox.pause', { sandboxId: sandbox.sandboxId });
      return sandbox.sandboxId;
    }
    await sandbox.kill();
    logger.debug('sandbox.kill', { sandboxId: sandbox.sandboxId });
    return undefined;
  } catch (err) {
    // Never throw from close — it would mask the real error the caller is
    // trying to report. Just log.
    logger.warn('sandbox.close failed', {
      sandboxId: sandbox.sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Build a metadata bag from a manifest, filtering to string values.
 * e2b's sandbox metadata must be `Record<string, string>`.
 */
export function manifestMetadata(manifest: Manifest): Record<string, string> {
  const md: Record<string, string> = {
    'floom.name': manifest.name,
    'floom.runtime': manifest.runtime,
  };
  if (manifest.memoryMb) md['floom.memoryMb'] = String(manifest.memoryMb);
  if (manifest.workdir) md['floom.workdir'] = manifest.workdir;
  if (manifest.category) md['floom.category'] = manifest.category;
  return md;
}
