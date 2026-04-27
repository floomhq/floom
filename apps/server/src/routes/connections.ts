// W2.3 /api/connections routes.
//
// Exposes the Composio-backed OAuth ramp used by the /build
// Connect-a-tool tile grid:
//
//   POST   /api/connections/initiate   { provider, callback_url? }
//   POST   /api/connections/finish     { connection_id }
//   GET    /api/connections            ?status=active
//   DELETE /api/connections/:provider
//
// All routes resolve a SessionContext in middleware (via
// `resolveUserContext`) so every query is scoped to the current workspace
// + owner. Pre-auth the owner is a device cookie; post-auth it's a real
// user id. The `rekeyDevice` transaction (services/session.ts) rewrites
// device rows to user rows on first login.
//
// Error envelope: `{error, code, details?}`. No raw stack traces.

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveUserContext } from '../services/session.js';
import {
  ComposioClientError,
  ComposioConfigError,
  ConnectionNotFoundError,
  finishConnection,
  initiateConnection,
  listConnections,
  revokeConnection,
} from '../services/composio.js';
import type { ConnectionRecord, ConnectionStatus } from '../types.js';

export const connectionsRouter = new Hono();

const InitiateBody = z.object({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'provider must be lowercase-slug'),
  callback_url: z.string().url().optional(),
});

const FinishBody = z.object({
  connection_id: z.string().min(1).max(256),
});

const ListQuery = z.object({
  status: z.enum(['pending', 'active', 'revoked', 'expired']).optional(),
});

/**
 * Serialize a DB record for the client. We strip nothing today (no
 * secrets live on this row) but we decode `metadata_json` so the UI
 * doesn't have to parse JSON again.
 */
function serialize(rec: ConnectionRecord): Record<string, unknown> {
  let metadata: Record<string, unknown> | null = null;
  if (rec.metadata_json) {
    try {
      metadata = JSON.parse(rec.metadata_json);
    } catch {
      metadata = null;
    }
  }
  return {
    id: rec.id,
    provider: rec.provider,
    owner_kind: rec.owner_kind,
    status: rec.status,
    composio_connection_id: rec.composio_connection_id,
    metadata,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}

/**
 * POST /api/connections/initiate
 * Body: { provider: string, callback_url?: string }
 * Response: { auth_url, connection_id, provider, expires_at }
 *
 * Kicks off a new OAuth connection. The caller receives an `auth_url`
 * that it should open in a popup/redirect. Once the user completes the
 * consent flow, the caller POSTs /api/connections/finish with the
 * `connection_id`.
 */
connectionsRouter.post('/initiate', async (c) => {
  const ctx = await resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = InitiateBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const result = await initiateConnection(
      ctx,
      parsed.data.provider,
      parsed.data.callback_url,
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof ComposioConfigError) {
      return c.json(
        { error: err.message, code: 'composio_config_missing' },
        400,
      );
    }
    if (err instanceof ComposioClientError) {
      return c.json(
        { error: err.message, code: 'composio_initiate_failed' },
        502,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'unexpected_error' },
      500,
    );
  }
});

/**
 * POST /api/connections/finish
 * Body: { connection_id: string }
 * Response: serialized connection
 *
 * Polls Composio for the current status of the connection and persists
 * the result. Caller typically POSTs this once after the OAuth popup
 * closes, or polls GET /api/connections until the row shows up `active`.
 */
connectionsRouter.post('/finish', async (c) => {
  const ctx = await resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = FinishBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const rec = await finishConnection(ctx, parsed.data.connection_id);
    return c.json({ connection: serialize(rec) });
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) {
      return c.json(
        { error: err.message, code: 'connection_not_found' },
        404,
      );
    }
    if (err instanceof ComposioConfigError) {
      return c.json(
        { error: err.message, code: 'composio_config_missing' },
        400,
      );
    }
    if (err instanceof ComposioClientError) {
      return c.json(
        { error: err.message, code: 'composio_finish_failed' },
        502,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'unexpected_error' },
      500,
    );
  }
});

/**
 * GET /api/connections
 * Query: ?status=active
 * Response: { connections: [...] }
 *
 * Lists all connections owned by the caller for the current tenant.
 * Device-scoped callers see only their device rows; logged-in users
 * see only their user rows. Nothing cross-tenant is ever returned.
 */
connectionsRouter.get('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const rawStatus = c.req.query('status');
  const parsed = ListQuery.safeParse({ status: rawStatus || undefined });
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid status filter',
        code: 'invalid_query',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const opts: { status?: ConnectionStatus } = {};
    if (parsed.data.status) opts.status = parsed.data.status;
    const rows = await listConnections(ctx, opts);
    return c.json({ connections: rows.map(serialize) });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'connections_list_failed' },
      500,
    );
  }
});

/**
 * DELETE /api/connections/:provider
 * Response: { ok, connection: serialized | null }
 *
 * Revokes the caller's connection for a given provider. Calls Composio
 * to tear down the upstream account, then flips the local row to
 * `revoked`. Idempotent: if the row was already revoked we return it;
 * if the row doesn't exist we return 404.
 */
connectionsRouter.delete('/:provider', async (c) => {
  const ctx = await resolveUserContext(c);
  const provider = c.req.param('provider') || '';
  if (!/^[a-z0-9_-]{1,64}$/.test(provider)) {
    return c.json(
      { error: 'provider must be lowercase slug', code: 'invalid_provider' },
      400,
    );
  }
  try {
    const rec = await revokeConnection(ctx, provider);
    if (!rec) {
      return c.json(
        { error: `no ${provider} connection for caller`, code: 'connection_not_found' },
        404,
      );
    }
    return c.json({ ok: true, connection: serialize(rec) });
  } catch (err) {
    if (err instanceof ComposioConfigError) {
      return c.json(
        { error: err.message, code: 'composio_config_missing' },
        400,
      );
    }
    if (err instanceof ComposioClientError) {
      return c.json(
        { error: err.message, code: 'composio_revoke_failed' },
        502,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'unexpected_error' },
      500,
    );
  }
});
