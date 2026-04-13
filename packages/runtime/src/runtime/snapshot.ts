/**
 * Pause/connect snapshot orchestration.
 *
 * This module is a thin, typed helper around the two functions in sandbox.ts
 * that implements the full warm-path lifecycle for a Floom app:
 *
 *   1. connect(templateId) — if the caller has a paused sandbox id from a
 *      previous run, reconnect (auto-resumes the paused state).
 *   2. run command — up to the caller via the executor.
 *   3. pause — freeze state for the next call.
 *
 * We DO NOT use `sandbox.createSnapshot()` anywhere, because H2 Test 4B
 * showed it is 7x slower than pause/connect (4.2s vs 611ms).
 *
 * If a paused sandbox is GC'd or dropped, `connect` throws
 * `SandboxNotFoundError`. The caller is expected to catch and either
 * re-create from a template (if there is one) or rebuild from scratch.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { closeSandbox, openSandbox } from './sandbox.ts';
import { logger } from '../lib/logger.ts';

export interface ResumeResult {
  sandbox: Sandbox;
  resumeMs: number;
}

/**
 * Resume a paused sandbox by id. Returns both the live sandbox and the
 * measured time to resume. Wraps the SDK call with timing + structured
 * logging.
 */
export async function resume(
  sandboxId: string,
  opts: { timeoutMs?: number; envs?: Record<string, string> } = {},
): Promise<ResumeResult> {
  const t0 = Date.now();
  const sandbox = await openSandbox({
    sandboxId,
    timeoutMs: opts.timeoutMs ?? 300_000,
    envs: opts.envs,
  });
  const resumeMs = Date.now() - t0;
  logger.debug('snapshot.resume', { sandboxId, resumeMs });
  return { sandbox, resumeMs };
}

/**
 * Pause the sandbox and return the same id for reconnection.
 */
export async function pauseForReuse(sandbox: Sandbox): Promise<string> {
  const id = await closeSandbox(sandbox, { pause: true });
  if (!id) throw new Error('Failed to pause sandbox');
  return id;
}

export { openSandbox, closeSandbox };
