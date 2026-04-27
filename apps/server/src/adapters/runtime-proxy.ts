// HTTP proxy runtime adapter. `FLOOM_RUNTIME=proxy` selects this implementation
// for deployments where every app execution is forwarded to an HTTP endpoint.

import type { AppRecord, NormalizedManifest, SessionContext } from '../types.js';
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeResult } from './types.js';
import { runProxied } from '../services/proxied-runner.js';

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

export const proxyRuntimeAdapter: RuntimeAdapter = {
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
  },
};
