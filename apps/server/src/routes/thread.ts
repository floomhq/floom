// Run thread persistence. Threads are keyed by a browser-generated id,
// no user auth: same anon waitlist model as the marketplace.
import { Hono } from 'hono';
import { db } from '../db.js';
import { newThreadId, newTurnId } from '../lib/ids.js';
import type { RunThreadRecord, RunTurnRecord } from '../types.js';

export const threadRouter = new Hono();

// POST /api/thread — create a new empty thread
threadRouter.post('/', (c) => {
  const id = newThreadId();
  db.prepare('INSERT INTO run_threads (id, title) VALUES (?, NULL)').run(id);
  return c.json({ id });
});

// GET /api/thread/:id — fetch thread + ordered turns
threadRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const thread = db
    .prepare('SELECT * FROM run_threads WHERE id = ?')
    .get(id) as RunThreadRecord | undefined;
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const turns = db
    .prepare('SELECT * FROM run_turns WHERE thread_id = ? ORDER BY turn_index ASC')
    .all(id) as RunTurnRecord[];

  return c.json({
    id: thread.id,
    title: thread.title,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    turns: turns.map((t) => ({
      id: t.id,
      turn_index: t.turn_index,
      kind: t.kind,
      payload: safeParse(t.payload),
      created_at: t.created_at,
    })),
  });
});

// POST /api/thread/:id/turn — append a turn
threadRouter.post('/:id/turn', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: unknown;
    payload?: unknown;
  };
  const kind = body.kind;
  if (kind !== 'user' && kind !== 'assistant') {
    return c.json({ error: 'kind must be "user" or "assistant"' }, 400);
  }

  let thread = db
    .prepare('SELECT * FROM run_threads WHERE id = ?')
    .get(id) as RunThreadRecord | undefined;
  if (!thread) {
    // Auto-create thread if missing, so the client can POST straight after
    // generating an id without a round-trip.
    db.prepare('INSERT INTO run_threads (id, title) VALUES (?, NULL)').run(id);
    thread = db.prepare('SELECT * FROM run_threads WHERE id = ?').get(id) as RunThreadRecord;
  }

  const lastTurn = db
    .prepare('SELECT MAX(turn_index) as max_idx FROM run_turns WHERE thread_id = ?')
    .get(id) as { max_idx: number | null };
  const nextIdx = (lastTurn.max_idx ?? -1) + 1;

  const turnId = newTurnId();
  const payloadJson = JSON.stringify(body.payload ?? {});
  db.prepare(
    `INSERT INTO run_turns (id, thread_id, turn_index, kind, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(turnId, id, nextIdx, kind, payloadJson);

  // Auto-title from the first user turn.
  if (nextIdx === 0 && kind === 'user' && !thread.title) {
    const text =
      typeof body.payload === 'object' && body.payload !== null
        ? (body.payload as { text?: unknown }).text
        : null;
    if (typeof text === 'string' && text.trim()) {
      const title = text.trim().slice(0, 60);
      db.prepare(
        `UPDATE run_threads SET title = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(title, id);
    }
  } else {
    db.prepare(`UPDATE run_threads SET updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  return c.json({
    id: turnId,
    turn_index: nextIdx,
    kind,
    payload: safeParse(payloadJson),
  });
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
