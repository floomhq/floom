import { runAppContainer } from '../docker.js';
import type { RuntimeAdapter, RuntimeResult } from '../../adapters/types.js';
import type { AppRecord, ErrorType, NormalizedManifest, SessionContext } from '../../types.js';

interface EntrypointResult {
  ok: boolean;
  outputs?: unknown;
  error?: string;
  error_type?: ErrorType;
  logs?: string;
}

function parseEntrypointOutput(stdout: string): EntrypointResult | null {
  const marker = '__FLOOM_RESULT__';
  const idx = stdout.lastIndexOf(marker);
  if (idx !== -1) {
    const jsonPart = stdout.slice(idx + marker.length);
    const nl = jsonPart.indexOf('\n');
    const line = nl === -1 ? jsonPart : jsonPart.slice(0, nl);
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

export function detectSilentError(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return null;
  }
  const o = outputs as Record<string, unknown>;

  if (typeof o.error === 'string' && o.error.trim().length > 0) {
    return o.error;
  }

  const raw = o.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const failed = typeof r.articles_failed === 'number' ? r.articles_failed : 0;
    const ok = typeof r.articles_successful === 'number' ? r.articles_successful : 0;
    if (failed > 0 && ok === 0) {
      const articles = Array.isArray(r.articles) ? r.articles : [];
      const firstErr = articles
        .map((a) =>
          a && typeof a === 'object' && typeof (a as { error?: unknown }).error === 'string'
            ? (a as { error: string }).error
            : null,
        )
        .find((e): e is string => !!e);
      return firstErr
        ? `All ${failed} articles failed. First error: ${firstErr}`
        : `All ${failed} articles failed.`;
    }
  }

  return null;
}

function extractUserLogs(stdout: string): string {
  const marker = '__FLOOM_RESULT__';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return stdout;
  return stdout.slice(0, idx);
}

export class LocalDockerRunner implements RuntimeAdapter {
  async execute(
    app: AppRecord,
    _manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    _ctx: SessionContext,
    run_id: string,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult> {
    try {
      const result = await runAppContainer({
        appId: app.id,
        runId: run_id,
        action: action,
        inputs: inputs,
        secrets: secrets,
        image: app.docker_image ?? undefined,
        onOutput: (chunk, stream) => {
          if (onOutput) {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line) onOutput(line, stream);
            }
          }
        },
      });

      const parsed = parseEntrypointOutput(result.stdout);
      const userLogs =
        extractUserLogs(result.stdout) + (result.stderr ? '\n' + result.stderr : '');

      if (result.timedOut) {
        return {
          status: 'timeout',
          outputs: null,
          error: 'Run timed out',
          error_type: 'timeout',
          logs: userLogs,
          duration_ms: result.durationMs,
        };
      }

      if (result.oomKilled) {
        return {
          status: 'error',
          outputs: null,
          error: 'Container ran out of memory. Increase RUNNER_MEMORY.',
          error_type: 'oom',
          logs: userLogs,
          duration_ms: result.durationMs,
        };
      }

      if (parsed && parsed.ok === true) {
        const silentErr = detectSilentError(parsed.outputs);
        if (silentErr) {
          return {
            status: 'error',
            outputs: parsed.outputs ?? null,
            error: silentErr,
            error_type: 'runtime_error',
            logs: userLogs,
            duration_ms: result.durationMs,
          };
        }
        return {
          status: 'success',
          outputs: parsed.outputs ?? null,
          logs: userLogs,
          duration_ms: result.durationMs,
        };
      }

      if (parsed && parsed.ok === false) {
        return {
          status: 'error',
          outputs: null,
          error: parsed.error || 'Unknown error',
          error_type: parsed.error_type || 'runtime_error',
          logs: (parsed.logs ? parsed.logs + '\n' : '') + userLogs,
          duration_ms: result.durationMs,
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
        logs: result.stdout + '\n' + result.stderr,
        duration_ms: result.durationMs,
      };
    } catch (err) {
      const e = err as Error & { floom_error_class?: string };
      const klass = e.floom_error_class;
      return {
        status: 'error',
        outputs: null,
        error: e.message || 'Runner crashed',
        error_type: (klass === 'app_unavailable' ? 'app_unavailable' : 'floom_internal_error') as ErrorType,
        logs: e.stack || '',
        duration_ms: 0,
      };
    }
  }
}
