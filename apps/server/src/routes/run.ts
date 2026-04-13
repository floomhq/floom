// POST /api/run — start a run on an app.
// Also handles POST /api/:slug/run — the slug-based endpoint for self-hosted use.
// Returns { run_id } immediately. The client opens /api/run/:id/stream as SSE
// to receive stdout lines live, and GET /api/run/:id for the final status.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db.js';
import { newRunId } from '../lib/ids.js';
import { dispatchRun, getRun } from '../services/runner.js';
import { validateInputs, ManifestError } from '../services/manifest.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const runRouter = new Hono();

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

  const runId = newRunId();
  const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
  db.prepare(
    `INSERT INTO runs (id, app_id, thread_id, action, inputs, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(runId, row.id, threadId, actionName, JSON.stringify(validated));

  dispatchRun(row, manifest, runId, actionName, validated);

  return c.json({ run_id: runId, status: 'pending' });
});

// GET /api/run/:id — latest snapshot
runRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);
  return c.json(formatRun(row));
});

// GET /api/run/:id/stream — SSE stream of stdout + status transitions
runRouter.get('/:id/stream', (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);

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

  const runId = newRunId();
  db.prepare(
    `INSERT INTO runs (id, app_id, thread_id, action, inputs, status)
     VALUES (?, ?, NULL, ?, ?, 'pending')`,
  ).run(runId, row.id, actionName, JSON.stringify(validated));

  dispatchRun(row, manifest, runId, actionName, validated);

  return c.json({ run_id: runId, status: 'pending' });
});
