import { runProxied } from '../proxied-runner.js';
import type { RuntimeAdapter, RuntimeResult } from '../../adapters/types.js';
import type { AppRecord, ErrorType, NormalizedManifest, SessionContext } from '../../types.js';

export class ProxiedRunner implements RuntimeAdapter {
  async execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    _ctx: SessionContext,
    _run_id: string,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult> {
    try {
      const result = await runProxied({
        app: app,
        manifest: manifest,
        action: action,
        inputs: inputs,
        secrets: secrets,
      });

      // runProxied doesn't support a streaming callback directly in its current
      // implementation because the stream is consumed entirely and accumulated into `logs`.
      // It does append to a string array `logs`. In the future, we can update runProxied
      // to call req.onOutput() directly.
      if (onOutput) {
        for (const line of result.logs.split('\n')) {
          if (line) onOutput(line, 'stdout');
        }
      }

      return {
        status: result.status as 'success' | 'error',
        outputs: result.outputs ?? null,
        error: result.error || undefined,
        error_type: result.status === 'error' ? (result.error_type as ErrorType | undefined ?? 'runtime_error') : undefined,
        upstream_status: result.upstream_status ?? undefined,
        logs: result.logs,
        duration_ms: result.duration_ms,
      };
    } catch (err) {
      const e = err as Error;
      return {
        status: 'error',
        outputs: null,
        error: e.message || 'Proxied runner crashed',
        error_type: 'floom_internal_error',
        logs: e.stack || '',
        duration_ms: 0,
      };
    }
  }
}
