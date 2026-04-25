import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import {
  extractAgentTokenPrefix,
  generateAgentToken,
  hashAgentToken,
  isValidAgentTokenScope,
  newAgentTokenId,
} from '../lib/agent-tokens.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import { resolveUserContext } from '../services/session.js';
import * as workspaces from '../services/workspaces.js';
import type { AgentTokenRecord, AgentTokenScope, SessionContext } from '../types.js';

export const agentKeysRouter = new Hono();

const AgentTokenScopeEnum = z.enum(['read', 'read-write', 'publish-only']);

const CreateAgentKeyBody = z.object({
  label: z.string().trim().min(1).max(80),
  scope: AgentTokenScopeEnum,
  workspace_id: z.string().trim().min(1).max(128).optional(),
  rate_limit_per_minute: z.number().int().min(1).max(10_000).optional(),
});

function requireUserSessionForAgentKeyMutation(
  c: Context,
  ctx: SessionContext,
): Response | null {
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  if (ctx.agent_token_id) {
    return c.json(
      {
        error: 'Agent-token management requires a user session.',
        code: 'session_required',
      },
      401,
    );
  }
  return null;
}

function normalizeRateLimit(value: number | undefined): number {
  return value ?? 60;
}

function assertWorkspaceAccess(
  c: Context,
  ctx: SessionContext,
  workspace_id: string,
): Response | null {
  try {
    workspaces.getById(ctx, workspace_id);
    return null;
  } catch {
    return c.json(
      {
        error: 'Workspace not found or not accessible',
        code: 'workspace_not_found',
      },
      404,
    );
  }
}

function publicAgentToken(row: AgentTokenRecord): Record<string, unknown> {
  return {
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    scope: row.scope,
    workspace_id: row.workspace_id,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked: row.revoked_at !== null,
  };
}

agentKeysRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireUserSessionForAgentKeyMutation(c, ctx);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreateAgentKeyBody.safeParse(body);
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

  const scope = parsed.data.scope as AgentTokenScope;
  if (!isValidAgentTokenScope(scope)) {
    return c.json({ error: 'Invalid scope', code: 'invalid_scope' }, 400);
  }

  const workspace_id = parsed.data.workspace_id || ctx.workspace_id;
  const workspaceGate = assertWorkspaceAccess(c, ctx, workspace_id);
  if (workspaceGate) return workspaceGate;

  const rawToken = generateAgentToken();
  const createdAt = new Date().toISOString();
  const row: AgentTokenRecord = {
    id: newAgentTokenId(),
    prefix: extractAgentTokenPrefix(rawToken),
    hash: hashAgentToken(rawToken),
    label: parsed.data.label,
    scope,
    workspace_id,
    user_id: ctx.user_id,
    created_at: createdAt,
    last_used_at: null,
    revoked_at: null,
    rate_limit_per_minute: normalizeRateLimit(parsed.data.rate_limit_per_minute),
  };

  db.prepare(
    `INSERT INTO agent_tokens
       (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
        last_used_at, revoked_at, rate_limit_per_minute)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.prefix,
    row.hash,
    row.label,
    row.scope,
    row.workspace_id,
    row.user_id,
    row.created_at,
    row.last_used_at,
    row.revoked_at,
    row.rate_limit_per_minute,
  );

  return c.json(
    {
      id: row.id,
      prefix: row.prefix,
      label: row.label,
      scope: row.scope,
      workspace_id: row.workspace_id,
      raw_token: rawToken,
    },
    201,
  );
});

agentKeysRouter.get('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireUserSessionForAgentKeyMutation(c, ctx);
  if (gate) return gate;

  const rows = db
    .prepare(
      `SELECT * FROM agent_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(ctx.user_id) as AgentTokenRecord[];
  return c.json(rows.map(publicAgentToken));
});

agentKeysRouter.post('/:id/revoke', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireUserSessionForAgentKeyMutation(c, ctx);
  if (gate) return gate;

  const id = c.req.param('id');
  db.prepare(
    `UPDATE agent_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ?
       AND user_id = ?`,
  ).run(new Date().toISOString(), id, ctx.user_id);
  return new Response(null, { status: 204 });
});
