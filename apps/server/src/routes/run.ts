// POST /api/run — start a run on an app.
// Also handles POST /api/:slug/run — the slug-based endpoint for self-hosted use.
// Returns { run_id } immediately. The client opens /api/run/:id/stream as SSE
// to receive stdout lines live, and GET /api/run/:id for the final status.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db.js';
import { newRunId } from '../lib/ids.js';
import { dispatchRun, getRun } from '../services/runner.js';
import { validateInputs, ManifestError } from '../services/manifest.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import { checkAppVisibility } from '../lib/auth.js';
import { resolveUserContext } from '../services/session.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const runRouter = new Hono();

type RunAppAccessRow = {
  slug: string;
  visibility: string | null;
  author: string | null;
};

async function loadAuthorizedRunApp(
  c: Context,
  appId: string,
): Promise<{ app: RunAppAccessRow | undefined; blocked: Response | null }> {
  const app = db
    .prepare('SELECT slug, visibility, author FROM apps WHERE id = ?')
    .get(appId) as RunAppAccessRow | undefined;
  if (!app) return { app: undefined, blocked: null };
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, app.visibility || 'public', {
    author: app.author,
    ctx,
  });
  return { app, blocked };
}

runRouter.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    app_slug?: unknown;
    inputs?: unknown;
    action?: unknown;
    thread_id?: unknown;
  };
  if (typeof body.app_slug !== 'string') {
    return c.json({ error: '"app_slug" is required' }, 400);
  }
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(body.app_slug) as AppRecord | undefined;
  if (!row) return c.json({ error: `App not found: ${body.app_slug}` }, 404);
  if (row.status !== 'active') {
    return c.json({ error: `App is ${row.status}, cannot run` }, 409);
  }
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, row.visibility || 'public', {
    author: row.author,
    ctx,
  });
  if (blocked) return blocked;

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(row.manifest) as NormalizedManifest;
  } catch {
    return c.json({ error: 'App manifest is corrupted' }, 500);
  }

  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof body.action === 'string' && body.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]);
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    return c.json({ error: `Action "${actionName}" not found` }, 400);
  }

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(
      actionSpec,
      (body.inputs as Record<string, unknown>) ?? {},
    );
  } catch (err) {
    const e = err as ManifestError;
    return c.json({ error: e.message, field: e.field }, 400);
  }

  // W4M.1: scope the run by the current session so /api/me/runs can filter
  // by user_id / device_id. `ctx` was already resolved above for the
  // visibility check (private apps need the caller's user_id).
  const runId = newRunId();
  const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
  db.prepare(
    `INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id, user_id, device_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    runId,
    row.id,
    threadId,
    actionName,
    JSON.stringify(validated),
    ctx.workspace_id,
    ctx.user_id,
    ctx.device_id,
  );

  // W4-minimal gap close: pass the resolved session context so the runner
  // can look up per-user secrets (user_secrets table). Without this, the
  // runner falls back to the synthetic 'local' workspace and every
  // authenticated user's /api/secrets POST is effectively invisible to
  // their own runs.
  dispatchRun(row, manifest, runId, actionName, validated, undefined, ctx);

  return c.json({ run_id: runId, status: 'pending' });
});

// GET /api/run/:id — latest snapshot.
//
// Used by two flows:
//   1. Live polling fallback from streamRun() while a run is in flight.
//   2. URL-to-run state restore: /p/:slug?run=<id> renders the run
//      read-only for anyone who opens a shared link (2026-04-17).
//
// Visibility rule: if the run is on an auth-required app, the caller must
// present the bearer token (same check the POST /api/run path uses). Runs
// on public apps stay viewable by run-id — they already were, and shared
// run URLs rely on that. App slug is included in the payload so the
// client can guard against opening a run-id that doesn't match the slug
// in the URL.
runRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);
  const { app, blocked } = await loadAuthorizedRunApp(c, row.app_id);
  if (blocked) return blocked;
  return c.json({ ...formatRun(row), app_slug: app?.slug ?? null });
});

// GET /api/run/:id/stream — SSE stream of stdout + status transitions
runRouter.get('/:id/stream', async (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);
  const { blocked } = await loadAuthorizedRunApp(c, row.app_id);
  if (blocked) return blocked;

  return streamSSE(c, async (stream) => {
    const logStream = getOrCreateStream(id);
    let done = false;

    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({
        event,
        data: JSON.stringify(data),
      });
    };

    // Replay history + latest status up front.
    const handle = logStream.subscribe(
      async (line) => {
        if (done) return;
        try {
          await send('log', { stream: line.stream, text: line.text, ts: line.ts });
        } catch {
          // client disconnected
        }
      },
      async () => {
        if (done) return;
        const fresh = getRun(id);
        if (fresh) {
          try {
            await send('status', formatRun(fresh));
          } catch {
            // ignore
          }
        }
        done = true;
      },
    );

    // Send replay history
    for (const line of handle.history) {
      await send('log', { stream: line.stream, text: line.text, ts: line.ts });
    }

    // Initial status
    const fresh = getRun(id);
    if (fresh) await send('status', formatRun(fresh));

    // If already done before subscribe, emit final status and close.
    if (handle.done) {
      handle.unsubscribe();
      return;
    }

    // Wait up to 10 minutes for finish. Status polling is also wired so the
    // client can poll GET /api/run/:id separately.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        done = true;
        handle.unsubscribe();
        resolve();
      }, 10 * 60 * 1000);

      const origUnsub = handle.unsubscribe;
      handle.unsubscribe = () => {
        clearTimeout(timer);
        origUnsub();
        resolve();
      };

      // Closing via stream abort
      stream.onAbort(() => {
        done = true;
        clearTimeout(timer);
        origUnsub();
        resolve();
      });

      // If the stream is already done when we got here, finish immediately.
      if (done) {
        clearTimeout(timer);
        origUnsub();
        resolve();
      }
    });
  });
});

function formatRun(row: {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: string | null;
  outputs: string | null;
  logs: string;
  status: string;
  error: string | null;
  error_type: string | null;
  // Optional so older sqlite snapshots that predate the upstream_status
  // migration still satisfy the type — SELECT * will surface it as
  // undefined and we fall through to null below.
  upstream_status?: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    app_id: row.app_id,
    thread_id: row.thread_id,
    action: row.action,
    inputs: safeParse(row.inputs),
    outputs: safeParse(row.outputs),
    status: row.status,
    error: row.error,
    error_type: row.error_type,
    // Error taxonomy (2026-04-20): the HTTP status the upstream API
    // returned, when one was received. The /p/:slug runner surface uses
    // this to pick between user_input_error / auth_error /
    // upstream_outage without re-parsing the raw error string.
    upstream_status: row.upstream_status ?? null,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
    logs: row.logs,
  };
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- slug-based run router ----------
// POST /api/:slug/run — convenience endpoint for self-hosted instances.
// Accepts { action?, inputs? } body; slug is from the URL path.
export const slugRunRouter = new Hono<{ Variables: { slug: string } }>();

slugRunRouter.post('/', async (c) => {
  const slug = c.req.param('slug');
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!row) return c.json({ error: `App not found: ${slug}` }, 404);
  if (row.status !== 'active') {
    return c.json({ error: `App is ${row.status}, cannot run` }, 409);
  }
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, row.visibility || 'public', {
    author: row.author,
    ctx,
  });
  if (blocked) return blocked;

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(row.manifest) as NormalizedManifest;
  } catch {
    return c.json({ error: 'App manifest is corrupted' }, 500);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    action?: unknown;
    inputs?: unknown;
  };

  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof body.action === 'string' && body.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]);
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    return c.json({ error: `Action "${actionName}" not found` }, 400);
  }

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(
      actionSpec,
      (body.inputs as Record<string, unknown>) ?? {},
    );
  } catch (err) {
    const e = err as ManifestError;
    return c.json({ error: e.message, field: e.field }, 400);
  }

  // W4M.1: scope the run by the current session. `ctx` already resolved
  // for the visibility check above.
  const runId = newRunId();
  db.prepare(
    `INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id, user_id, device_id)
     VALUES (?, ?, NULL, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    runId,
    row.id,
    actionName,
    JSON.stringify(validated),
    ctx.workspace_id,
    ctx.user_id,
    ctx.device_id,
  );

  // W4-minimal gap close: pass the resolved session context so the runner
  // can look up per-user secrets (user_secrets table). Without this, the
  // runner falls back to the synthetic 'local' workspace and every
  // authenticated user's /api/secrets POST is effectively invisible to
  // their own runs.
  dispatchRun(row, manifest, runId, actionName, validated, undefined, ctx);

  return c.json({ run_id: runId, status: 'pending' });
});

// ---------- /api/me/runs : per-user run history ----------
// Returns the caller's run history scoped by (workspace_id, user_id) in
// cloud mode and by (workspace_id, device_id) in OSS mode. Joins `apps`
// so the UI can render the app name + icon without a second fetch.
export const meRouter = new Hono();

meRouter.get('/runs', async (c) => {
  const ctx = await resolveUserContext(c);
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') || 50)));

  // Two filters: authenticated caller scopes by user_id; anonymous caller
  // scopes by device_id. Both also check workspace_id so cross-workspace
  // leaks are impossible.
  const scopeClause = ctx.is_authenticated
    ? 'runs.workspace_id = ? AND runs.user_id = ?'
    : 'runs.workspace_id = ? AND runs.device_id = ?';
  const scopeParam = ctx.is_authenticated ? ctx.user_id : ctx.device_id;

  const rows = db
    .prepare(
      `SELECT runs.id, runs.action, runs.status, runs.duration_ms,
              runs.started_at, runs.finished_at, runs.error, runs.error_type,
              runs.inputs, runs.outputs,
              apps.slug AS app_slug, apps.name AS app_name, apps.icon AS app_icon
         FROM runs
         LEFT JOIN apps ON apps.id = runs.app_id
        WHERE ${scopeClause}
        ORDER BY runs.started_at DESC
        LIMIT ?`,
    )
    .all(ctx.workspace_id, scopeParam, limit) as Array<{
    id: string;
    action: string;
    status: string;
    duration_ms: number | null;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    error_type: string | null;
    inputs: string | null;
    outputs: string | null;
    app_slug: string | null;
    app_name: string | null;
    app_icon: string | null;
  }>;

  return c.json({
    runs: rows.map((r) => {
      // v15.1 /me uses inputs to derive a human-readable thread title
      // without a per-row detail fetch. Parse defensively — older rows
      // may have malformed or missing JSON.
      let inputs: Record<string, unknown> | null = null;
      if (r.inputs) {
        try {
          const parsed = JSON.parse(r.inputs);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            inputs = parsed as Record<string, unknown>;
          }
        } catch {
          // Swallow parse errors: a bad inputs blob shouldn't break the
          // whole /runs list. UI will fall back to "Run #<id>".
        }
      }
      // Fix 3 (2026-04-19): surface `outputs` on the list response so the
      // earlier-runs rail on /p/:slug can render input → output previews
      // without a per-row detail fetch. Outputs can be arbitrary shapes;
      // the UI calls JSON.stringify() + truncates on the client side.
      let outputs: unknown = null;
      if (r.outputs) {
        try {
          outputs = JSON.parse(r.outputs);
        } catch {
          outputs = r.outputs; // surface as raw string so snippet is visible
        }
      }
      return {
        id: r.id,
        action: r.action,
        status: r.status,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
        error: r.error,
        error_type: r.error_type,
        app_slug: r.app_slug,
        app_name: r.app_name,
        app_icon: r.app_icon,
        inputs,
        outputs,
      };
    }),
  });
});

// GET /api/me/runs/:id — scoped fetch of a single run. Returns 404 if the
// run exists but is owned by someone else, so probing run ids can't leak
// another user's outputs.
meRouter.get('/runs/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id');

  const scopeClause = ctx.is_authenticated
    ? 'runs.workspace_id = ? AND runs.user_id = ?'
    : 'runs.workspace_id = ? AND runs.device_id = ?';
  const scopeParam = ctx.is_authenticated ? ctx.user_id : ctx.device_id;

  const row = db
    .prepare(
      `SELECT runs.*, apps.slug AS app_slug, apps.name AS app_name, apps.icon AS app_icon
         FROM runs LEFT JOIN apps ON apps.id = runs.app_id
        WHERE runs.id = ? AND ${scopeClause}
        LIMIT 1`,
    )
    .get(id, ctx.workspace_id, scopeParam) as
    | {
        id: string;
        app_id: string;
        thread_id: string | null;
        action: string;
        inputs: string | null;
        outputs: string | null;
        logs: string;
        status: string;
        error: string | null;
        error_type: string | null;
        upstream_status: number | null;
        duration_ms: number | null;
        started_at: string;
        finished_at: string | null;
        app_slug: string | null;
        app_name: string | null;
        app_icon: string | null;
      }
    | undefined;

  if (!row) return c.json({ error: 'Run not found' }, 404);

  return c.json({
    id: row.id,
    app_id: row.app_id,
    app_slug: row.app_slug,
    app_name: row.app_name,
    app_icon: row.app_icon,
    thread_id: row.thread_id,
    action: row.action,
    inputs: safeParse(row.inputs),
    outputs: safeParse(row.outputs),
    status: row.status,
    error: row.error,
    error_type: row.error_type,
    upstream_status: row.upstream_status ?? null,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
    logs: row.logs,
  });
});
