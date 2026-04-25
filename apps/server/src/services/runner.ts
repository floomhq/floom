// Trimmed port of the marketplace runner. Loads secrets, dispatches a
// container run, streams output to the log bus, and updates the run record.
import { DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from '../db.js';
import { storage } from './storage.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import { noteAppUnavailable } from '../lib/alerts.js';
import * as userSecrets from './user_secrets.js';
import * as creatorSecrets from './app_creator_secrets.js';
import { LocalDockerRunner } from './runner/local-docker.js';
import { ProxiedRunner } from './runner/proxied.js';
import type { RuntimeAdapter } from '../adapters/types.js';
import type { SecretPolicy } from '../types.js';
import type {
  AppRecord,
  ErrorType,
  NormalizedManifest,
  RunRecord,
  RunStatus,
  SessionContext,
} from '../types.js';

/**
 * Default tenant context used when a dispatchRun caller (legacy route, test)
 * does not pass one. In OSS mode this always resolves to the synthetic local
 * workspace + user, so no caller has to branch on "is multi-tenant on yet".
 */
function defaultContext(device_id?: string): SessionContext {
  return {
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: DEFAULT_USER_ID,
    device_id: device_id || DEFAULT_USER_ID,
    is_authenticated: false,
  };
}

interface UpdateRunArgs {
  status?: RunStatus;
  outputs?: unknown;
  error?: string | null;
  error_type?: ErrorType | null;
  /**
   * HTTP status from the upstream API, for proxied-app errors. Null
   * when no status was received (DNS / timeout / pre-response failure)
   * or for docker-entrypoint runs. Persisted on `runs.upstream_status`
   * so the /p/:slug client can pick the exact taxonomy class.
   */
  upstream_status?: number | null;
  logs?: string;
  duration_ms?: number | null;
  finished?: boolean;
}

export function updateRun(runId: string, patch: UpdateRunArgs): void {
  storage.updateRun(runId, patch);

  // Refresh apps.avg_run_ms whenever a run finishes successfully. Runs at
  // most once per run completion and only when we have a concrete duration.
  // This drives the data-driven sort in GET /api/hub (featured DESC,
  // avg_run_ms ASC, ...) so the store reorders itself as real usage
  // comes in.
  if (patch.finished && patch.status === 'success' && typeof patch.duration_ms === 'number') {
    refreshAppAvgRunMs(runId);
  }
}

/**
 * Recompute the rolling average run time for the app that owns the given
 * run, looking at the last 20 successful runs.
 */
function refreshAppAvgRunMs(runId: string): void {
  try {
    const run = storage.getRun(runId);
    if (!run) return;
    storage.refreshAppAvgRunMs(run.app_id);
    invalidateHubCache();
  } catch (err) {
    console.warn(`[runner] failed to refresh avg_run_ms: ${(err as Error).message}`);
  }
}


/**
 * Fire-and-forget: dispatch a run in the background. Updates the run row as
 * it progresses and feeds the log stream with output chunks.
 *
 * Precedence (lowest → highest):
 *   1. Global admin secrets (secrets table, app_id IS NULL)
 *   2. Per-app admin secrets (secrets table, app_id = this app)
 *   3. Per-secret policy (app_secret_policies + app_creator_secrets, W5):
 *        - policy='creator_override': inject the creator's stored value
 *          (encrypted under the app's workspace DEK).
 *        - policy='user_vault' (default): inject the running user's
 *          value from user_secrets (W2.1), same as before.
 *      Keys with a creator-override value do NOT fall back to the
 *      user vault — the creator has explicitly taken ownership.
 *   4. Per-call MCP _auth override (perCallSecrets)
 *
 * `perCallSecrets` (optional) is an override passed by the MCP layer via the
 * Floom MCP _auth extension. These values are merged into the per-run secrets
 * for this invocation only; they are never persisted to the secrets table.
 *
 * `ctx` (optional) is the tenant context. When omitted we fall back to the
 * synthetic 'local' workspace+user, which is correct for OSS solo mode and
 * any pre-W2.1 call site that hasn't been migrated yet.
 */
export function dispatchRun(
  app: AppRecord,
  manifest: NormalizedManifest,
  runId: string,
  action: string,
  inputs: Record<string, unknown>,
  perCallSecrets?: Record<string, string>,
  ctx?: SessionContext,
): void {
  // Load secrets: merge global (app_id IS NULL) + per-app (app_id = this app).
  const globalRows = storage.listAdminSecrets(null);
  const appRows = storage.listAdminSecrets(app.id);

  const mergedSecrets: Record<string, string> = {};
  for (const row of globalRows) mergedSecrets[row.name] = row.value;
  for (const row of appRows) mergedSecrets[row.name] = row.value;

  // Per-secret policy split (secrets-policy feature).
  //
  const runtimeCtx = ctx || defaultContext();
  const needs = manifest.secrets_needed || [];
  if (needs.length > 0) {
    const policies = new Map<string, SecretPolicy>(
      creatorSecrets
        .listPolicies(app.id)
        .map((p) => [p.key, p.policy as SecretPolicy]),
    );
    const userVaultKeys = needs.filter(
      (k) => (policies.get(k) ?? 'user_vault') === 'user_vault',
    );
    const creatorKeys = needs.filter(
      (k) => policies.get(k) === 'creator_override',
    );

    // Load the creator-owned overrides first.
    if (creatorKeys.length > 0) {
      try {
        const creatorLevel = creatorSecrets.loadCreatorSecretsForRun(
          app.id,
          app.workspace_id || runtimeCtx.workspace_id,
          creatorKeys,
        );
        for (const [k, v] of Object.entries(creatorLevel)) {
          if (v && v.length > 0) mergedSecrets[k] = v;
        }
      } catch (err) {
        console.warn(
          `[runner] failed to load creator-override secrets for ${app.slug}: ${(err as Error).message}`,
        );
      }
    }

    // Load per-user persisted secrets only for the keys that are still
    // the running user's responsibility.
    if (userVaultKeys.length > 0) {
      try {
        const userLevel = userSecrets.loadForRun(runtimeCtx, userVaultKeys);
        for (const [k, v] of Object.entries(userLevel)) {
          if (v && v.length > 0) mergedSecrets[k] = v;
        }
      } catch (err) {
        console.warn(
          `[runner] failed to load per-user secrets for ${app.slug}: ${(err as Error).message}`,
        );
      }
    }
  }

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

  // Resolve the appropriate RuntimeAdapter
  const adapter: RuntimeAdapter = app.app_type === 'proxied' 
    ? new ProxiedRunner() 
    : new LocalDockerRunner();

  // Run the workload and process the result asynchronously
  void (async () => {
    const logStream = getOrCreateStream(runId);
    try {
      const result = await adapter.execute(
        app,
        manifest,
        action,
        inputs,
        secrets,
        runtimeCtx,
        runId,
        (chunk, stream) => logStream.append(chunk, stream)
      );

      updateRun(runId, {
        status: result.status,
        outputs: result.outputs,
        error: result.error || null,
        error_type: result.error_type || null,
        upstream_status: result.upstream_status || null,
        logs: result.logs,
        duration_ms: result.duration_ms,
        finished: true,
      });

      if (result.error_type === 'app_unavailable') {
        noteAppUnavailable(app.slug, result.error || 'app_unavailable');
      }
    } catch (err) {
      // In case the adapter itself threw unexpectedly
      const e = err as Error;
      updateRun(runId, {
        status: 'error',
        error: e.message || 'Runner failed unexpectedly',
        error_type: 'floom_internal_error',
        logs: e.stack || '',
        finished: true,
      });
    } finally {
      logStream.finish();
    }
  })();
}

export function getRun(runId: string): RunRecord | undefined {
  return storage.getRun(runId);
}

/**
 * Zombie-run sweeper (#349).
 *
 * Every run is dispatched fire-and-forget (`void runActionWorker(...)`) from
 * {@link dispatchRun}. If the server process crashes, is OOM-killed, or is
 * redeployed mid-run, the inner `updateRun({..., finished: true})` call
 * never lands and the row stays `status='running'` forever. The /p/:slug
 * surface polls forever, the MCP caller times out client-side, and the run
 * never graduates to `success` or `error`.
 *
 * Two entry points close this gap:
 *
 *  1. `sweepZombieRuns()` — called once on boot. Any row whose
 *     `status='running'` at process start cannot be owned by this process
 *     (we just started). Flip every such row to `error` with a dedicated
 *     message so the client taxonomy can render the right card.
 *
 *  2. `startZombieRunSweeper()` — periodic guard. Any row whose
 *     `status='running'` AND `started_at` is older than the absolute
 *     runner timeout ceiling (RUNNER_TIMEOUT + generous slack) cannot
 *     still be executing. The docker runner's own timeout would have
 *     tripped by now. Flip it the same way.
 *
 * Kept deliberately conservative: the periodic sweeper's cutoff is
 * RUNNER_TIMEOUT + 5 min slack (min 10 min total), so a healthy worker
 * still inside `container.wait()` or streaming logs is never touched.
 * Only genuinely dead runs are reaped.
 */
export function sweepZombieRuns(): number {
  const rows = storage.listRuns({ status: 'running' });
  if (rows.length === 0) return 0;
  const nowMs = Date.now();
  let swept = 0;
  for (const row of rows) {
    const startedMs = Date.parse(row.started_at + 'Z');
    const durationMs = Number.isFinite(startedMs) ? nowMs - startedMs : null;
    updateRun(row.id, {
      status: 'error',
      error:
        'This run was interrupted while it was still processing. Try it again.',
      error_type: 'floom_internal_error',
      duration_ms: durationMs,
      finished: true,
    });
    swept++;
  }
  return swept;
}

/**
 * Periodic sweeper: every `intervalMs`, flip any `running` rows whose
 * `started_at` predates the absolute runner timeout ceiling. The docker
 * runner's own per-container timeout would have killed the container long
 * before this fires, so any row still `running` past that is orphaned.
 *
 * `ceilingMs` defaults to RUNNER_TIMEOUT + 5 min slack, floored at 10 min.
 * Exposed as a parameter so tests can stub shorter windows.
 */
export function startZombieRunSweeper(
  intervalMs = 60_000,
  ceilingMs?: number,
): { stop: () => void } {
  const runnerTimeout = Number(process.env.RUNNER_TIMEOUT || 300_000);
  const ceiling = Math.max(ceilingMs ?? runnerTimeout + 5 * 60_000, 10 * 60_000);
  const timer = setInterval(() => {
    try {
      const cutoffIso = new Date(Date.now() - ceiling)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      const rows = storage.listRuns({ status: 'running', before_started_at: cutoffIso });
      for (const row of rows) {
        const startedMs = Date.parse(row.started_at + 'Z');
        const durationMs = Number.isFinite(startedMs)
          ? Date.now() - startedMs
          : null;
        updateRun(row.id, {
          status: 'error',
          error:
            'This run stopped reporting progress and was reaped. Try it again.',
          error_type: 'floom_internal_error',
          duration_ms: durationMs,
          finished: true,
        });
        console.warn(
          `[runner] zombie sweeper reaped run ${row.id} (started_at=${row.started_at})`,
        );
      }
    } catch (err) {
      console.warn(
        `[runner] zombie sweeper error: ${(err as Error).message}`,
      );
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
