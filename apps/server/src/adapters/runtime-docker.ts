// Default runtime adapter. `FLOOM_RUNTIME=docker` selects this implementation;
// it owns app_type dispatch so the runner only talks to the RuntimeAdapter
// surface.

import type { AppRecord, NormalizedManifest, SessionContext } from '../types.js';
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeResult } from './types.js';
import { runAppContainer } from '../services/docker.js';
import { runProxied } from '../services/proxied-runner.js';
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
    runContext?: RuntimeExecutionContext,
  ): Promise<RuntimeResult> {
    if (app.app_type === 'proxied') {
      const result = await runProxied({
        app,
        manifest,
        action,
        inputs,
        secrets,
        timeoutMs: runContext?.timeoutMs,
      });
      const safeLogs = redactSecrets(result.logs, secrets) as string;
      if (onOutput && safeLogs) onOutput(safeLogs, 'stdout');
      return {
        status:
          result.error_type === 'timeout' && runContext?.timeoutMs ? 'timeout' : result.status,
        outputs: redactSecrets(result.outputs, secrets),
        error: redactSecrets(result.error, secrets) as string | undefined,
        error_type: result.error_type,
        upstream_status: result.upstream_status,
        duration_ms: result.duration_ms,
        logs: safeLogs,
      };
    }

    if (app.app_type !== 'docker') {
      return {
        status: 'error',
        outputs: null,
        error: `Unsupported app_type for docker runtime: ${app.app_type}`,
        error_type: 'floom_internal_error',
        duration_ms: 0,
        logs: '',
      };
    }

    // runAppContainer requires a runId. The live runner creates the run row
    // first and passes its id. Contract tests and direct adapter callers get a
    // transient id that is still unique enough for container names and input
    // staging dirs.
    const runId =
      runContext?.runId || `adhoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const image = app.docker_image ?? undefined;

    const result = await runAppContainer({
      appId: app.id,
      runId,
      action,
      inputs,
      secrets,
      manifest,
      image,
      timeoutMs: runContext?.timeoutMs,
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
