// Trimmed port of the marketplace runner. Loads secrets, dispatches a
// container run, streams output to the log bus, and updates the run record.
import { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from '../db.js';
import { runAppContainer } from './docker.js';
import { runProxied } from './proxied-runner.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import * as userSecrets from './user_secrets.js';
import * as creatorSecrets from './app_creator_secrets.js';
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
  if (patch.upstream_status !== undefined) {
    cols.push('upstream_status = ?');
    values.push(patch.upstream_status);
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
 * run, looking at the last 20 successful runs. We keep the window small so
 * one old slow cold-start doesn't dominate the average forever. If the app
 * has no successful runs (shouldn't happen because this is called after a
 * success) the column is left as-is.
 */
function refreshAppAvgRunMs(runId: string): void {
  try {
    const row = db
      .prepare('SELECT app_id FROM runs WHERE id = ?')
      .get(runId) as { app_id: string } | undefined;
    if (!row) return;
    const avgRow = db
      .prepare(
        `SELECT AVG(duration_ms) AS avg_ms FROM (
           SELECT duration_ms FROM runs
           WHERE app_id = ? AND status = 'success' AND duration_ms IS NOT NULL
           ORDER BY started_at DESC
           LIMIT 20
         )`,
      )
      .get(row.app_id) as { avg_ms: number | null } | undefined;
    const avg = avgRow?.avg_ms;
    if (typeof avg === 'number' && Number.isFinite(avg)) {
      db.prepare('UPDATE apps SET avg_run_ms = ? WHERE id = ?').run(
        Math.round(avg),
        row.app_id,
      );
      // Perf fix (2026-04-20): bust the /api/hub 5s cache so the freshly
      // computed avg_run_ms drives the store sort order on the next
      // directory read. Without this, the test suite's "hub: avg_run_ms
      // populated after runs" assertion sees stale null values for up
      // to 5s after each run completes.
      invalidateHubCache();
    }
  } catch (err) {
    // Avg tracking is best-effort. A missing column (on an old DB),
    // concurrency, or a bad join never blocks the run completion path.
    console.warn(`[runner] failed to refresh avg_run_ms: ${(err as Error).message}`);
  }
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

/**
 * Detect apps that returned `ok: true` from the entrypoint but whose
 * outputs clearly signal a runtime failure. Returns a human-readable
 * error message to promote to the run's top-level `error`, or null if
 * the outputs look like a real success.
 *
 * Two shapes are handled today — both discovered by the per-app quality
 * v3 audit (2026-04-17):
 *   1. `{ error: "...", ...partial payload }` — blast-radius + dep-check
 *      do this when `git clone` fails on a public repo with no creds.
 *   2. `{ raw: { articles_failed: N, articles_successful: 0, ... } }` —
 *      openblog returns this when every article generator call failed
 *      (usually a downstream Gemini key issue).
 *
 * Kept narrow and shape-based on purpose: we do NOT want to flip
 * legitimate apps that return `{ errors: [] }` or similar.
 */
export function detectSilentError(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return null;
  }
  const o = outputs as Record<string, unknown>;

  // Shape 1: top-level `error` field populated with a non-empty string.
  if (typeof o.error === 'string' && o.error.trim().length > 0) {
    return o.error;
  }

  // Shape 2: batch processor (openblog) reports total failure. When every
  // article failed and zero succeeded, the run is a failure even though the
  // entrypoint returned ok:true. We do NOT flip runs where some succeeded —
  // those are honest partial results and the caller can decide what to do.
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
  const globalRows = db
    .prepare('SELECT name, value FROM secrets WHERE app_id IS NULL')
    .all() as { name: string; value: string }[];
  const appRows = db
    .prepare('SELECT name, value FROM secrets WHERE app_id = ?')
    .all(app.id) as { name: string; value: string }[];

  const mergedSecrets: Record<string, string> = {};
  for (const row of globalRows) mergedSecrets[row.name] = row.value;
  for (const row of appRows) mergedSecrets[row.name] = row.value;

  // Per-secret policy split (secrets-policy feature).
  //
  // Every key in `needs` is either a 'user_vault' key (load from the
  // running user's encrypted vault, today's behavior) or a
  // 'creator_override' key (load from the creator-owned value wrapped
  // under the app's workspace DEK). The two bags are disjoint: a
  // creator-override key does NOT fall back to the user vault, which
  // means users don't have to configure keys their creator took
  // ownership of, and their own vault row (if any) is ignored for
  // this app while the override is in effect.
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

    // Load the creator-owned overrides first. `app.workspace_id` is the
    // workspace that authored the app; fall back to the runtime ctx's
    // workspace for apps inserted before the multi-tenant columns were
    // added (those rows now default to 'local' via the migration).
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
    // the running user's responsibility. We deliberately skip keys the
    // creator has taken over so a user's stale vault row does not leak
    // into a run that expects the creator's value.
    if (userVaultKeys.length > 0) {
      try {
        const userLevel = userSecrets.loadForRun(runtimeCtx, userVaultKeys);
        for (const [k, v] of Object.entries(userLevel)) {
          if (v && v.length > 0) mergedSecrets[k] = v;
        }
      } catch (err) {
        // Silent on purpose: a missing FLOOM_MASTER_KEY or a crypto error
        // should not block runs that only use admin-level secrets. The
        // operator will see the error at first /api/secrets POST instead.
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
    // Error taxonomy (2026-04-20): proxied-runner classifies the
    // failure at source (auth_error / user_input_error / upstream_outage
    // / network_unreachable / timeout / missing_secret). We persist its
    // verdict verbatim so the client can render the matching headline
    // without re-parsing the raw error string. Fall back to
    // runtime_error only when the runner couldn't pick a class.
    updateRun(opts.runId, {
      status: result.status,
      outputs: result.outputs,
      error: result.error || null,
      error_type:
        result.status === 'error'
          ? ((result.error_type as ErrorType | undefined) ?? 'runtime_error')
          : null,
      upstream_status: result.upstream_status ?? null,
      logs: result.logs,
      duration_ms: result.duration_ms,
      finished: true,
    });
  } catch (err) {
    // An exception here (as opposed to a returned error result) means
    // runProxied itself crashed — that's a Floom-side bug, not an
    // upstream issue. Classify as floom_internal_error so the runner
    // surface shows the "Something broke inside Floom" headline with
    // a "Report this" link, not the misleading "Can't reach this app".
    const e = err as Error;
    updateRun(opts.runId, {
      status: 'error',
      error: e.message || 'Proxied runner crashed',
      error_type: 'floom_internal_error',
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
      // Some docker apps return `{ ok: true, outputs: { error: "..." } }` when
      // an internal step failed (e.g. git clone with no auth, or a downstream
      // generator returned a non-2xx). Treat those as runtime errors so the UI
      // and `/api/run/<id>` surface a real failure instead of a silent
      // "success" with an error buried in the outputs. Also covers openblog's
      // batch shape where every article failed.
      const silentErr = detectSilentError(parsed.outputs);
      if (silentErr) {
        updateRun(opts.runId, {
          status: 'error',
          outputs: parsed.outputs ?? null,
          error: silentErr,
          error_type: 'runtime_error',
          logs: userLogs,
          duration_ms: result.durationMs,
          finished: true,
        });
        return;
      }
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
      error_type: 'floom_internal_error',
      logs: result.stdout + '\n' + result.stderr,
      duration_ms: result.durationMs,
      finished: true,
    });
  } catch (err) {
    // The runner itself crashed — not an upstream problem, not the
    // user's input. Classify as floom_internal_error so the UI doesn't
    // tell the caller to "try again in a minute" when the fix is on
    // our side.
    const e = err as Error;
    updateRun(opts.runId, {
      status: 'error',
      error: e.message || 'Runner crashed',
      error_type: 'floom_internal_error',
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
