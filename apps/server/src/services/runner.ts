// Trimmed port of the marketplace runner. Loads secrets, dispatches a
// container run, streams output to the log bus, and updates the run record.
import { db } from '../db.js';
import { runAppContainer } from './docker.js';
import { runProxied } from './proxied-runner.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import type {
  AppRecord,
  ErrorType,
  NormalizedManifest,
  RunRecord,
  RunStatus,
} from '../types.js';

interface UpdateRunArgs {
  status?: RunStatus;
  outputs?: unknown;
  error?: string | null;
  error_type?: ErrorType | null;
  logs?: string;
  duration_ms?: number | null;
  finished?: boolean;
}

export function updateRun(runId: string, patch: UpdateRunArgs): void {
  const cols: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    cols.push('status = ?');
    values.push(patch.status);
  }
  if (patch.outputs !== undefined) {
    cols.push('outputs = ?');
    values.push(JSON.stringify(patch.outputs));
  }
  if (patch.error !== undefined) {
    cols.push('error = ?');
    values.push(patch.error);
  }
  if (patch.error_type !== undefined) {
    cols.push('error_type = ?');
    values.push(patch.error_type);
  }
  if (patch.logs !== undefined) {
    cols.push('logs = ?');
    values.push(patch.logs);
  }
  if (patch.duration_ms !== undefined) {
    cols.push('duration_ms = ?');
    values.push(patch.duration_ms);
  }
  if (patch.finished) {
    cols.push("finished_at = datetime('now')");
  }
  if (cols.length === 0) return;
  values.push(runId);
  db.prepare(`UPDATE runs SET ${cols.join(', ')} WHERE id = ?`).run(...values);
}

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

function extractUserLogs(stdout: string): string {
  const marker = '__FLOOM_RESULT__';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return stdout;
  return stdout.slice(0, idx);
}

/**
 * Fire-and-forget: dispatch a run in the background. Updates the run row as
 * it progresses and feeds the log stream with output chunks.
 *
 * `perCallSecrets` (optional) is an override passed by the MCP layer via the
 * Floom MCP _auth extension. These values are merged into the per-run secrets
 * for this invocation only; they are never persisted to the secrets table.
 */
export function dispatchRun(
  app: AppRecord,
  manifest: NormalizedManifest,
  runId: string,
  action: string,
  inputs: Record<string, unknown>,
  perCallSecrets?: Record<string, string>,
): void {
  // Load secrets: merge global (app_id IS NULL) + per-app (app_id = this app).
  const globalRows = db
    .prepare('SELECT name, value FROM secrets WHERE app_id IS NULL')
    .all() as { name: string; value: string }[];
  const appRows = db
    .prepare('SELECT name, value FROM secrets WHERE app_id = ?')
    .all(app.id) as { name: string; value: string }[];

  const mergedSecrets: Record<string, string> = {};
  for (const row of globalRows) mergedSecrets[row.name] = row.value;
  for (const row of appRows) mergedSecrets[row.name] = row.value;
  // Per-call secrets (from MCP _auth meta param) win over persisted secrets.
  if (perCallSecrets) {
    for (const [k, v] of Object.entries(perCallSecrets)) {
      if (v && v.length > 0) mergedSecrets[k] = v;
    }
  }

  const secrets: Record<string, string> = {};
  for (const name of manifest.secrets_needed || []) {
    if (mergedSecrets[name]) secrets[name] = mergedSecrets[name];
  }

  updateRun(runId, { status: 'running' });

  if (app.app_type === 'proxied') {
    void runProxiedWorker({ app, manifest, runId, action, inputs, secrets });
  } else {
    void runActionWorker({
      appId: app.id,
      runId,
      action,
      inputs,
      secrets,
      image: app.docker_image ?? undefined,
    });
  }
}

async function runProxiedWorker(opts: {
  app: AppRecord;
  manifest: NormalizedManifest;
  runId: string;
  action: string;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
}): Promise<void> {
  const logStream = getOrCreateStream(opts.runId);
  try {
    const result = await runProxied({
      app: opts.app,
      manifest: opts.manifest,
      action: opts.action,
      inputs: opts.inputs,
      secrets: opts.secrets,
    });
    for (const line of result.logs.split('\n')) {
      if (line) logStream.append(line, 'stdout');
    }
    updateRun(opts.runId, {
      status: result.status,
      outputs: result.outputs,
      error: result.error || null,
      error_type: result.status === 'error' ? 'runtime_error' : null,
      logs: result.logs,
      duration_ms: result.duration_ms,
      finished: true,
    });
  } catch (err) {
    const e = err as Error;
    updateRun(opts.runId, {
      status: 'error',
      error: e.message || 'Proxied runner crashed',
      error_type: 'runtime_error',
      logs: e.stack || '',
      finished: true,
    });
  } finally {
    logStream.finish();
  }
}

async function runActionWorker(opts: {
  appId: string;
  runId: string;
  action: string;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
  image?: string;
}): Promise<void> {
  const logStream = getOrCreateStream(opts.runId);

  try {
    const result = await runAppContainer({
      appId: opts.appId,
      runId: opts.runId,
      action: opts.action,
      inputs: opts.inputs,
      secrets: opts.secrets,
      image: opts.image,
      onOutput: (chunk, stream) => {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line) logStream.append(line, stream);
        }
      },
    });

    const parsed = parseEntrypointOutput(result.stdout);
    const userLogs =
      extractUserLogs(result.stdout) + (result.stderr ? '\n' + result.stderr : '');

    if (result.timedOut) {
      updateRun(opts.runId, {
        status: 'timeout',
        error: 'Run timed out',
        error_type: 'timeout',
        logs: userLogs,
        duration_ms: result.durationMs,
        finished: true,
      });
      return;
    }

    if (result.oomKilled) {
      updateRun(opts.runId, {
        status: 'error',
        error: 'Container ran out of memory. Increase RUNNER_MEMORY.',
        error_type: 'oom',
        logs: userLogs,
        duration_ms: result.durationMs,
        finished: true,
      });
      return;
    }

    if (parsed && parsed.ok === true) {
      updateRun(opts.runId, {
        status: 'success',
        outputs: parsed.outputs ?? null,
        logs: userLogs,
        duration_ms: result.durationMs,
        finished: true,
      });
      return;
    }

    if (parsed && parsed.ok === false) {
      updateRun(opts.runId, {
        status: 'error',
        error: parsed.error || 'Unknown error',
        error_type: parsed.error_type || 'runtime_error',
        logs: (parsed.logs ? parsed.logs + '\n' : '') + userLogs,
        duration_ms: result.durationMs,
        finished: true,
      });
      return;
    }

    updateRun(opts.runId, {
      status: 'error',
      error:
        result.exitCode === 0
          ? 'Container exited cleanly but emitted no result'
          : `Container exited with code ${result.exitCode}`,
      error_type: 'runtime_error',
      logs: result.stdout + '\n' + result.stderr,
      duration_ms: result.durationMs,
      finished: true,
    });
  } catch (err) {
    const e = err as Error;
    updateRun(opts.runId, {
      status: 'error',
      error: e.message || 'Runner crashed',
      error_type: 'runtime_error',
      logs: e.stack || '',
      finished: true,
    });
  } finally {
    logStream.finish();
  }
}

export function getRun(runId: string): RunRecord | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRecord | undefined;
}
