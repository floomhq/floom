import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { isCloudMode } from '../lib/better-auth.js';
import { resolveUserContext } from '../services/session.js';
import {
  AccountDeleteError,
  initiateAccountSoftDelete,
  undoAccountSoftDelete,
} from '../services/account-deletion.js';

export const accountDeleteRouter = new Hono();

const DeleteBody = z.object({
  confirm_email: z.string().email(),
});

function errorResponse(c: Context, err: unknown) {
  if (err instanceof AccountDeleteError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400 | 401 | 404 | 409 | 410 | 422);
  }
  throw err;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

accountDeleteRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  if (!isCloudMode() || !ctx.is_authenticated || !ctx.user_id) {
    return c.json({ error: 'Authentication required. Sign in and retry.', code: 'auth_required' }, 401);
  }

  const parsed = DeleteBody.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      422,
    );
  }

  try {
    const result = initiateAccountSoftDelete(ctx.user_id, parsed.data.confirm_email);
    return c.json({ ok: true, delete_at: result.delete_at });
  } catch (err) {
    return errorResponse(c, err);
  }
});

accountDeleteRouter.post('/undo', async (c) => {
  const parsed = DeleteBody.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      422,
    );
  }

  try {
    const user = undoAccountSoftDelete(parsed.data.confirm_email);
    return c.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        deleted_at: user.deleted_at,
        delete_at: user.delete_at,
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
