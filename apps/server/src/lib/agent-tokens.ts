import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { db } from '../db.js';
import type { AgentTokenRecord, AgentTokenScope, SessionContext } from '../types.js';

const TOKEN_PREFIX = 'floom_agent_';
const TOKEN_RANDOM_LENGTH = 32;
const PREFIX_RANDOM_LENGTH = 8;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LEGACY_TOKEN_RE = /^floom_(?!agent_)[0-9A-Za-z+/=]{32,128}$/;
const LAST_USED_DEBOUNCE_MS = 60_000;

export interface AgentTokenAuthContext {
  agent_token_id: string;
  user_id: string;
  workspace_id: string;
  scope: AgentTokenScope;
  rate_limit_per_minute: number;
}

const agentTokenContext = new WeakMap<Context, AgentTokenAuthContext>();

export function getPresentedAgentToken(c: Context): string | null {
  const header = c.req.header('authorization') || c.req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  return isAgentTokenString(token) || isLegacyAgentTokenString(token) ? token : null;
}

export function isAgentTokenString(value: string): boolean {
  return new RegExp(`^${TOKEN_PREFIX}[0-9A-Za-z]{${TOKEN_RANDOM_LENGTH}}$`).test(value);
}

function isLegacyAgentTokenString(value: string): boolean {
  return LEGACY_TOKEN_RE.test(value);
}

export function isValidAgentTokenScope(value: unknown): value is AgentTokenScope {
  return value === 'read' || value === 'read-write' || value === 'publish-only';
}

export function hashAgentToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function extractAgentTokenPrefix(rawToken: string): string {
  if (!rawToken.startsWith(TOKEN_PREFIX)) {
    throw new Error('agent token must start with floom_agent_');
  }
  const randomPart = rawToken.slice(TOKEN_PREFIX.length);
  if (randomPart.length < PREFIX_RANDOM_LENGTH) {
    throw new Error('agent token random part is too short');
  }
  return `${TOKEN_PREFIX}${randomPart.slice(0, PREFIX_RANDOM_LENGTH)}`;
}

export function generateAgentToken(): string {
  let suffix = '';
  for (let i = 0; i < TOKEN_RANDOM_LENGTH; i++) {
    suffix += BASE62[randomInt(BASE62.length)];
  }
  return `${TOKEN_PREFIX}${suffix}`;
}

export function newAgentTokenId(): string {
  return `agtok_${randomUUID()}`;
}

export function getAgentTokenContext(c: Context): AgentTokenAuthContext | null {
  return agentTokenContext.get(c) || null;
}

export function setAgentTokenContext(
  c: Context,
  ctx: AgentTokenAuthContext,
): void {
  agentTokenContext.set(c, ctx);
}

export function agentContextToSessionContext(
  auth: AgentTokenAuthContext,
  device_id: string,
): SessionContext {
  return {
    workspace_id: auth.workspace_id,
    user_id: auth.user_id,
    device_id,
    is_authenticated: true,
    auth_user_id: auth.user_id,
    agent_token_id: auth.agent_token_id,
    agent_token_scope: auth.scope,
    agent_token_rate_limit_per_minute: auth.rate_limit_per_minute,
  };
}

export function lookupAgentToken(rawToken: string): AgentTokenRecord | null {
  if (!isAgentTokenString(rawToken) && !isLegacyAgentTokenString(rawToken)) return null;
  const hash = hashAgentToken(rawToken);
  const row = db
    .prepare(
      `SELECT * FROM agent_tokens
        WHERE hash = ?
          AND revoked_at IS NULL
        LIMIT 1`,
    )
    .get(hash) as AgentTokenRecord | undefined;
  return row || null;
}

export function touchAgentTokenLastUsed(row: AgentTokenRecord, now = new Date()): void {
  const previous = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Number.isFinite(previous) && now.getTime() - previous < LAST_USED_DEBOUNCE_MS) {
    return;
  }
  db.prepare(
    `UPDATE agent_tokens
       SET last_used_at = ?
     WHERE id = ?
       AND revoked_at IS NULL
       AND (last_used_at IS NULL OR last_used_at < ?)`,
  ).run(now.toISOString(), row.id, new Date(now.getTime() - LAST_USED_DEBOUNCE_MS).toISOString());
}

/**
 * Returns true when an Authorization header is present and looks like a
 * Floom agent token attempt (starts with `floom_agent_` or `floom_`).
 * Used to detect mis-formatted tokens that should return 401 instead of
 * silently routing to the admin/anon MCP server (item 7 fix).
 */
function looksLikeAgentTokenAttempt(c: Context): boolean {
  const header = c.req.header('authorization') || c.req.header('Authorization');
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  // Any floom_agent_* bearer that doesn't pass the strict format check is a
  // malformed/invalid token — return 401 rather than treating as anonymous.
  return match[1].startsWith('floom_agent_') || match[1].startsWith('floom_');
}

export const agentTokenAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const rawToken = getPresentedAgentToken(c);

  // No Floom token presented — check if there's a mis-formatted floom_agent_*
  // bearer (wrong length, bad chars, etc.). If so, return 401 explicitly so
  // clients know their token is bad rather than silently routing to the admin
  // MCP server (closes item 7 / checklist 7.5).
  if (!rawToken) {
    if (looksLikeAgentTokenAttempt(c)) {
      return c.json(
        {
          error: 'invalid_token',
          code: 'invalid_token',
          hint: 'The token format is invalid. Agent tokens look like floom_agent_<32 alphanumeric chars>. Get a valid token at https://floom.dev/home',
        },
        401,
      );
    }
    return next();
  }

  const row = lookupAgentToken(rawToken);
  if (!row) {
    return c.json(
      {
        error: 'invalid_agent_token',
        code: 'invalid_token',
        hint: 'Token not found or revoked. Mint a new token at https://floom.dev/home',
      },
      401,
    );
  }

  setAgentTokenContext(c, {
    agent_token_id: row.id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    scope: row.scope,
    rate_limit_per_minute: row.rate_limit_per_minute,
  });
  touchAgentTokenLastUsed(row);
  return next();
};
