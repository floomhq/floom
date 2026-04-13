/**
 * Build step: run the manifest's `build` command inside a sandbox that
 * already has the source cloned at /workspace. Streams stdout via the
 * optional callback. Returns the build log + timing.
 *
 * This is a thin wrapper around runShell that knows about the `workdir`
 * field on the manifest (so the build runs in the right subdirectory for
 * monorepos).
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { runShell } from '../runtime/executor.ts';
import type { Manifest } from '../runtime/types.ts';
import { WORKSPACE_PATH } from './clone.ts';

export interface BuildStepResult {
  exitCode: number;
  buildMs: number;
  buildLog: string;
}

export async function runBuildStep(
  sandbox: Sandbox,
  manifest: Manifest,
  onStream?: (chunk: string) => void,
): Promise<BuildStepResult> {
  if (!manifest.build) {
    return { exitCode: 0, buildMs: 0, buildLog: '(no build command)' };
  }

  const cwd = manifest.workdir
    ? `cd ${WORKSPACE_PATH}/${manifest.workdir} && `
    : `cd ${WORKSPACE_PATH} && `;
  const fullCmd = `${cwd}${manifest.build}`;

  const t0 = Date.now();
  let buildLog = '';
  const result = await runShell(sandbox, fullCmd, {
    timeoutMs: 600_000, // 10 min: Suite A's slowest install was 22.5s, leave headroom
    onStream: (chunk: string) => {
      buildLog += chunk;
      if (onStream) onStream(chunk);
    },
  });

  return {
    exitCode: result.exitCode,
    buildMs: Date.now() - t0,
    buildLog,
  };
}
