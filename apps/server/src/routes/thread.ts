// Run thread persistence. Threads are keyed by a browser-generated id,
// no user auth: same anon waitlist model as the marketplace.
import { Hono } from 'hono';
import { adapters } from '../adapters/index.js';
import { newThreadId, newTurnId } from '../lib/ids.js';

export const threadRouter = new Hono();

// POST /api/thread — create a new empty thread
threadRouter.post('/', async (c) => {
  const id = newThreadId();
  await adapters.storage.createRunThread({ id, title: null });
  return c.json({ id });
});

// GET /api/thread/:id — fetch thread + ordered turns
threadRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const thread = await adapters.storage.getRunThread(id);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const turns = await adapters.storage.listRunTurns(id);

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

  let thread = await adapters.storage.getRunThread(id);
  if (!thread) {
    // Auto-create thread if missing, so the client can POST straight after
    // generating an id without a round-trip.
    thread = await adapters.storage.createRunThread({ id, title: null });
  }

  const turnId = newTurnId();
  const payloadJson = JSON.stringify(body.payload ?? {});
  const turn = await adapters.storage.appendRunTurn({
    id: turnId,
    thread_id: id,
    kind,
    payload: payloadJson,
  });

  // Auto-title from the first user turn.
  if (turn.turn_index === 0 && kind === 'user' && !thread.title) {
    const text =
      typeof body.payload === 'object' && body.payload !== null
        ? (body.payload as { text?: unknown }).text
        : null;
    if (typeof text === 'string' && text.trim()) {
      const title = text.trim().slice(0, 60);
      await adapters.storage.updateRunThread(id, { title });
    }
  } else {
    await adapters.storage.updateRunThread(id, {});
  }

  return c.json({
    id: turn.id,
    turn_index: turn.turn_index,
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
