// Docker runtime adapter wrapper.
//
// Thin shim that lets the existing `services/docker.ts runAppContainer`
// function satisfy the `RuntimeAdapter` interface declared in
// `adapters/types.ts`. Behavior is unchanged: a call to
// `dockerRuntimeAdapter.execute(...)` is functionally equivalent to the
// call path inside `services/runner.ts runActionWorker` (minus the
// DB-write side effects, which stay in the runner).
//
// This wrapper exists so the adapter factory (adapters/factory.ts) has
// something concrete to hand back for the default `FLOOM_RUNTIME=docker`
// configuration. The live run-dispatch path still goes through
// `dispatchRun` in services/runner.ts; migrating that call site to use
// `adapters.runtime.execute` is follow-on work.

import type { AppRecord, NormalizedManifest, SessionContext } from '../types.js';
import type { RuntimeAdapter, RuntimeResult } from './types.js';
import { runAppContainer } from '../services/docker.js';
import { parseEntrypointOutput, extractUserLogs, detectSilentError } from '../services/runner.js';

function redactSecrets(value: unknown, secrets: Record<string, string>): unknown {
  const needles = Object.values(secrets).filter((v) => v.length > 0);
  if (needles.length === 0) return value;
  if (typeof value === 'string') {
    let redacted = value;
    for (const secret of needles) {
      redacted = redacted.split(secret).join('[redacted]');
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactSecrets(nested, secrets),
      ]),
    );
  }
  return value;
}

export const dockerRuntimeAdapter: RuntimeAdapter = {
  async execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    _ctx: SessionContext,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult> {
    // runAppContainer requires a runId. The live runner creates the run row
    // first and passes its id; here we synthesise a transient id because the
    // adapter contract doesn't carry one. The container name it ends up in is
    // still unique per call. The run id is only used for the container name
    // and the file-input staging dir, so a transient value is safe.
    const transientRunId = `adhoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const image = app.docker_image ?? undefined;

    const result = await runAppContainer({
      appId: app.id,
      runId: transientRunId,
      action,
      inputs,
      secrets,
      manifest,
      image,
      onOutput,
    });

    const userLogs =
      extractUserLogs(result.stdout) + (result.stderr ? '\n' + result.stderr : '');
    const safeUserLogs = redactSecrets(userLogs, secrets) as string;

    if (result.timedOut) {
      return {
        status: 'timeout',
        outputs: null,
        error: 'Run timed out',
        error_type: 'timeout',
        duration_ms: result.durationMs,
        logs: safeUserLogs,
      };
    }

    if (result.oomKilled) {
      return {
        status: 'error',
        outputs: null,
        error: 'Container ran out of memory. Increase RUNNER_MEMORY.',
        error_type: 'oom',
        duration_ms: result.durationMs,
        logs: safeUserLogs,
      };
    }

    const parsed = parseEntrypointOutput(result.stdout);
    if (parsed && parsed.ok === true) {
      const safeOutputs = redactSecrets(parsed.outputs, secrets);
      const silent = detectSilentError(safeOutputs);
      if (silent) {
        return {
          status: 'error',
          outputs: safeOutputs ?? null,
          error: silent,
          error_type: 'runtime_error',
          duration_ms: result.durationMs,
          logs: safeUserLogs,
        };
      }
      return {
        status: 'success',
        outputs: safeOutputs ?? null,
        duration_ms: result.durationMs,
        logs: safeUserLogs,
      };
    }
    if (parsed && parsed.ok === false) {
      return {
        status: 'error',
        outputs: null,
        error: (redactSecrets(parsed.error, secrets) as string | undefined) || 'Unknown error',
        error_type: parsed.error_type || 'runtime_error',
        duration_ms: result.durationMs,
        logs: redactSecrets(
          (parsed.logs ? parsed.logs + '\n' : '') + userLogs,
          secrets,
        ) as string,
      };
    }
    return {
      status: 'error',
      outputs: null,
      error:
        result.exitCode === 0
          ? 'Container exited cleanly but emitted no result'
          : `Container exited with code ${result.exitCode}`,
      error_type: 'floom_internal_error',
      duration_ms: result.durationMs,
      logs: redactSecrets(result.stdout + '\n' + result.stderr, secrets) as string,
    };
  },
};
