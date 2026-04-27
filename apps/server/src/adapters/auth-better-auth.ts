// Better Auth identity adapter wrapper.
//
// Wraps the reference `lib/better-auth.ts` module so it satisfies the
// `AuthAdapter` interface declared in `adapters/types.ts`.
//
// `getSession(request)` owns the full server-side SessionContext resolution:
// agent-token bearer auth, OSS local fallback, Better Auth validation, user
// mirroring, workspace resolution, and device rekeying.

import type { SessionContext } from '../types.js';
import type { AuthAdapter, UserWriteColumn, UserWriteInput } from './types.js';
import type { Hono } from 'hono';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_USER_ID,
  db,
  isSeededAdminEmail,
} from '../db.js';
import {
  getAuth,
  getAuthForRequest,
  isCloudMode,
  registerAuthUserDeleteListener,
} from '../lib/better-auth.js';
import { sanitizeAuthResponse } from '../lib/auth-response.js';
import { padToFloor, shouldPadAuthTiming } from '../lib/auth-response-guard.js';
import {
  applyProgressiveSigninDelayFromContext,
  parseEmailForSigninProgressiveDelay,
  recordSigninEmailProgressiveDelayOutcome,
} from '../lib/signin-progressive-delay.js';
import {
  agentContextToSessionContext,
  extractAgentTokenPrefix,
  hashAgentToken,
  isAgentTokenString,
  touchAgentTokenLastUsed,
} from '../lib/agent-tokens.js';
import {
  getActiveWorkspaceId,
  isDeployEnabled,
  provisionPersonalWorkspace,
} from '../services/workspaces.js';
import { linkPendingEmailInvites } from '../services/sharing.js';
import {
  AccountDeleteError,
  getUserDeletionStateByEmail,
  getUserDeletionState,
  initiateAccountSoftDelete,
  isDeleteExpired,
  permanentDeleteAccount,
  permanentlyDeleteExpiredAccountForEmail,
  revokeAccountSessions,
  softDeletedSignInBody,
} from '../services/account-deletion.js';
import { rekeyDevice } from '../services/device-rekey.js';

type BetterAuthSession = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    emailVerified?: boolean;
    image?: string | null;
  };
  session: { id: string };
};

type AuthApiResult<T> =
  | T
  | {
      response?: T;
      headers?: Headers | null;
    };

type AuthEmailResult = {
  token?: string | null;
  user?: {
    id: string;
    email: string;
  };
};

const sessionCookieByToken = new Map<string, string>();
const sessionCookieByUserId = new Map<string, string>();
const DEVICE_COOKIE_NAME = 'floom_device';

function authCallHeaders(cookie?: string): Headers {
  const origin = process.env.BETTER_AUTH_URL || 'http://localhost:3051';
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return 'localhost:3051';
    }
  })();
  const headers = new Headers({
    host,
    origin,
  });
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

function unwrapAuthResult<T>(result: AuthApiResult<T>): {
  response: T;
  headers: Headers | null;
} {
  if (
    result &&
    typeof result === 'object' &&
    'response' in result &&
    'headers' in result
  ) {
    return {
      response: result.response as T,
      headers: result.headers ?? null,
    };
  }
  return { response: result as T, headers: null };
}

function firstCookieFromSetCookie(setCookie: string | null | undefined): string | undefined {
  if (!setCookie) return undefined;
  const first = setCookie.split(';', 1)[0]?.trim();
  return first || undefined;
}

function cookieValue(headers: Headers, name: string): string | null {
  const raw = headers.get('cookie') || headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name && rest.length > 0) {
      const value = decodeURIComponent(rest.join('=')).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function bearerToken(headers: Headers): string | null {
  const raw = headers.get('authorization') || headers.get('Authorization');
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function authPath(basePath: string, suffix: string): string {
  return `${normalizeBasePath(basePath)}${suffix}`;
}

function isSignupPath(pathname: string, basePath: string): boolean {
  const signUpBase = authPath(basePath, '/sign-up');
  const signupBase = authPath(basePath, '/signup');
  return (
    pathname === signUpBase ||
    pathname.startsWith(`${signUpBase}/`) ||
    pathname === signupBase ||
    pathname.startsWith(`${signupBase}/`)
  );
}

function rememberSessionCookie(
  userId: string | undefined,
  token: string | null | undefined,
  setCookie: string | undefined,
): void {
  if (!setCookie) return;
  if (userId) sessionCookieByUserId.set(userId, setCookie);
  if (token) sessionCookieByToken.set(token, setCookie);
}

function userInsertKeys(input: UserWriteInput): Array<keyof UserWriteInput> {
  return (Object.keys(input) as Array<keyof UserWriteInput>).filter(
    (key) => input[key] !== undefined,
  );
}

function upsertFloomUser(
  input: UserWriteInput,
  updateColumns: UserWriteColumn[],
): void {
  const keys = userInsertKeys(input);
  const keySet = new Set(keys);
  for (const column of updateColumns) {
    if (!keySet.has(column)) {
      throw new Error(`Cannot upsert users.${String(column)} from an omitted value`);
    }
  }
  const placeholders = keys.map(() => '?').join(', ');
  const updates = updateColumns
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  db.prepare(
    `INSERT INTO users (${keys.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
  ).run(...keys.map((key) => input[key]));
}

function ossSession(device_id: string): SessionContext {
  return {
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: DEFAULT_USER_ID,
    device_id,
    is_authenticated: false,
  };
}

function agentSessionFromRequest(request: Request, device_id: string): SessionContext | null {
  const token = bearerToken(request.headers);
  if (!token || !isAgentTokenString(token)) return null;
  const hash = hashAgentToken(token);
  const row = db
    .prepare(
      `SELECT * FROM agent_tokens
        WHERE hash = ?
          AND revoked_at IS NULL
        LIMIT 1`,
    )
    .get(hash) as
    | {
        id: string;
        prefix: string;
        workspace_id: string;
        user_id: string;
        scope: 'read' | 'read-write' | 'publish-only';
        rate_limit_per_minute: number;
        last_used_at: string | null;
        revoked_at: string | null;
        created_at: string;
        hash: string;
        label: string;
      }
    | undefined;
  if (!row || row.prefix !== extractAgentTokenPrefix(token)) return null;
  touchAgentTokenLastUsed(row);
  return agentContextToSessionContext(
    {
      agent_token_id: row.id,
      user_id: row.user_id,
      workspace_id: row.workspace_id,
      scope: row.scope,
      rate_limit_per_minute: row.rate_limit_per_minute,
    },
    device_id,
  );
}

async function sessionContextFromEmailResult(
  result: AuthEmailResult,
): Promise<SessionContext> {
  if (!result.user?.id || !result.user.email) {
    throw new Error('Better Auth email flow did not return a user.');
  }
  const workspaceId = resolveWorkspaceForAuthUser(
    result.user.id,
    result.user.email,
    null,
  );
  return {
    workspace_id: workspaceId,
    user_id: result.user.id,
    device_id: 'unknown',
    is_authenticated: true,
    auth_user_id: result.user.id,
    email: result.user.email,
  };
}

function resolveWorkspaceForAuthUser(
  userId: string,
  email: string,
  name?: string | null,
): string {
  let activeWorkspaceId = getActiveWorkspaceId(userId);
  if (!activeWorkspaceId) {
    activeWorkspaceId = provisionPersonalWorkspace(userId, email, name);
  }
  return activeWorkspaceId;
}

function mirrorAuthUser(session: BetterAuthSession): void {
  const userId = session.user.id;
  const isSeededAdmin = isSeededAdminEmail(session.user.email);
  upsertFloomUser(
    {
      id: userId,
      email: session.user.email,
      name: session.user.name || null,
      image: session.user.image || null,
      auth_provider: 'better-auth',
      auth_subject: userId,
      ...(isSeededAdmin ? { is_admin: 1 as const } : {}),
    },
    isSeededAdmin
      ? ['email', 'name', 'image', 'is_admin']
      : ['email', 'name', 'image'],
  );
}

async function resolveBetterAuthSession(
  auth: NonNullable<ReturnType<typeof getAuth>>,
  headers: Headers,
  device_id: string,
): Promise<SessionContext | null> {
  let session: BetterAuthSession | null = null;
  try {
    const result = (await auth.api.getSession({ headers })) as BetterAuthSession | null;
    if (result?.user) session = result;
  } catch {
    session = null;
  }

  if (!session?.user) return null;
  if (session.user.emailVerified === false) return null;

  const userId = session.user.id;
  mirrorAuthUser(session);

  const deletionState = getUserDeletionState(userId);
  if (deletionState?.deleted_at) {
    if (isDeleteExpired(deletionState)) {
      permanentDeleteAccount(userId);
    } else {
      revokeAccountSessions(userId);
    }
    return null;
  }

  await linkPendingEmailInvites(userId, session.user.email);
  const activeWorkspaceId = resolveWorkspaceForAuthUser(
    userId,
    session.user.email,
    session.user.name,
  );

  try {
    rekeyDevice(device_id, userId, activeWorkspaceId);
  } catch {
    // Rekey is opportunistic; auth success remains authoritative.
  }

  return {
    workspace_id: activeWorkspaceId,
    user_id: userId,
    device_id,
    is_authenticated: true,
    auth_user_id: userId,
    auth_session_id: session.session?.id,
    email: session.user.email,
  };
}

function requirePassword(password: string | undefined, method: string): string {
  if (!password) {
    throw new Error(`AuthAdapter.${method} requires a password for better-auth.`);
  }
  return password;
}

async function signInWithBetterAuth(input: {
  email: string;
  password?: string;
}): Promise<{
  session: SessionContext;
  set_cookie?: string;
  token?: string;
}> {
  const auth = getAuth();
  if (!auth) {
    return {
      session: {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_id: DEFAULT_USER_ID,
        device_id: 'local',
        is_authenticated: false,
        email: input.email,
      },
    };
  }
  const password = requirePassword(input.password, 'signIn');
  const { response, headers } = unwrapAuthResult<AuthEmailResult>(
    (await auth.api.signInEmail({
      body: {
        email: input.email,
        password,
        rememberMe: true,
      },
      headers: authCallHeaders(),
      returnHeaders: true,
    })) as AuthApiResult<AuthEmailResult>,
  );
  const set_cookie = headers?.get('set-cookie') ?? undefined;
  const cookie = firstCookieFromSetCookie(set_cookie);
  const session =
    cookie
      ? (await resolveBetterAuthSession(auth, authCallHeaders(cookie), 'unknown')) ??
        (await sessionContextFromEmailResult(response))
      : await sessionContextFromEmailResult(response);
  rememberSessionCookie(session.user_id, response.token, cookie);
  return {
    session,
    set_cookie,
    token: response.token ?? undefined,
  };
}

export const betterAuthAdapter: AuthAdapter = {
  async getSession(request: Request): Promise<SessionContext | null> {
    const device_id = cookieValue(request.headers, DEVICE_COOKIE_NAME) || 'unknown';
    const agentSession = agentSessionFromRequest(request, device_id);
    if (agentSession) return agentSession;

    if (!isCloudMode()) {
      return ossSession(device_id);
    }

    const auth = getAuth();
    if (!auth) return null;
    return resolveBetterAuthSession(auth, request.headers, device_id);
  },

  async mountHttp(app: unknown, basePath: string): Promise<void> {
    if (!isCloudMode()) return;
    const auth = getAuth();
    if (!auth) return;

    const hono = app as Hono;
    const wildcardPath = authPath(basePath, '/*');

    hono.get(authPath(basePath, '/error'), (c) => {
      const error = c.req.query('error') || 'unknown';
      const isDev = process.env.NODE_ENV !== 'production';
      const frontendOrigin =
        process.env.FLOOM_APP_URL ||
        (isDev ? 'http://localhost:5173' : '');
      if (frontendOrigin) {
        return c.redirect(
          `${frontendOrigin}/login?error=${encodeURIComponent(error)}`,
        );
      }
      return c.json({ error: 'auth_failed', code: error }, 400);
    });

    hono.get(authPath(basePath, '/session'), async (c) => {
      const session = await betterAuthAdapter.getSession(c.req.raw);
      return c.json(session);
    });

    hono.use(wildcardPath, async (c, next) => {
      const method = c.req.method;
      const pathname = new URL(c.req.url).pathname;
      if (method === 'POST' && isSignupPath(pathname, basePath) && !isDeployEnabled()) {
        return c.json({ error: 'sign-up disabled — join the waitlist' }, 403);
      }
      return next();
    });

    hono.post(authPath(basePath, '/delete-user'), async (c) => {
      const authForRequest = getAuthForRequest(c.req.raw);
      if (!authForRequest) {
        return new Response('Auth not configured', { status: 503 });
      }
      const session = (await authForRequest.api.getSession({
        headers: c.req.raw.headers,
      })) as { user?: { id: string; email: string } } | null;
      if (!session?.user?.id || !session.user.email) {
        return c.json(
          { error: 'Authentication required. Sign in and retry.', code: 'auth_required' },
          401,
        );
      }
      let confirmEmail = session.user.email;
      try {
        const body = (await c.req.json()) as { confirm_email?: unknown };
        if (typeof body.confirm_email === 'string') confirmEmail = body.confirm_email;
      } catch {
        confirmEmail = session.user.email;
      }
      try {
        const result = initiateAccountSoftDelete(session.user.id, confirmEmail);
        return c.json({
          success: true,
          message: 'User deleted',
          delete_at: result.delete_at,
        });
      } catch (err) {
        if (err instanceof AccountDeleteError) {
          return c.json(
            { error: err.message, code: err.code },
            err.status as 400 | 401 | 404 | 409 | 410 | 422,
          );
        }
        throw err;
      }
    });

    hono.on(
      ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
      wildcardPath,
      async (c) => {
        const authForRequest = getAuthForRequest(c.req.raw);
        if (!authForRequest) {
          return new Response('Auth not configured', { status: 503 });
        }
        const pathname = new URL(c.req.url).pathname;
        const method = c.req.method;
        let reqForAuth = c.req.raw;
        let signinEmailForDelay: string | null = null;
        let pendingDeleteSignin = null as ReturnType<typeof getUserDeletionStateByEmail> | null;
        if (method === 'POST' && pathname === authPath(basePath, '/sign-in/email')) {
          const bodyText = await c.req.raw.clone().text();
          const parsedEmail = parseEmailForSigninProgressiveDelay(bodyText);
          if (parsedEmail) {
            signinEmailForDelay = parsedEmail;
            await applyProgressiveSigninDelayFromContext(c, parsedEmail);
            const deletionState = getUserDeletionStateByEmail(parsedEmail);
            if (deletionState?.deleted_at) {
              if (isDeleteExpired(deletionState)) {
                const earlyStartedAtMs = Date.now();
                permanentlyDeleteExpiredAccountForEmail(parsedEmail);
                const expired = new Response(
                  JSON.stringify({
                    error: 'Invalid email or password.',
                    code: 'invalid_credentials',
                  }),
                  { status: 401, headers: { 'content-type': 'application/json' } },
                );
                await recordSigninEmailProgressiveDelayOutcome(c, parsedEmail, expired);
                const padTiming = shouldPadAuthTiming(pathname);
                if (padTiming) await padToFloor(earlyStartedAtMs);
                return expired;
              }
              pendingDeleteSignin = deletionState;
            }
            reqForAuth = new Request(c.req.raw.url, {
              method: c.req.raw.method,
              headers: c.req.raw.headers,
              body: bodyText,
            });
          }
        }
        const padTiming = shouldPadAuthTiming(pathname);
        const startedAtMs = padTiming ? Date.now() : 0;
        const raw = await authForRequest.handler(reqForAuth);
        let res = await sanitizeAuthResponse(reqForAuth, raw);
        if (pendingDeleteSignin && res.status >= 200 && res.status < 300) {
          revokeAccountSessions(pendingDeleteSignin.id);
          res = new Response(JSON.stringify(softDeletedSignInBody(pendingDeleteSignin)), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (signinEmailForDelay) {
          await recordSigninEmailProgressiveDelayOutcome(c, signinEmailForDelay, res);
        }
        if (padTiming) {
          await padToFloor(startedAtMs);
        }
        return res;
      },
    );
  },

  async signIn(input): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }> {
    return signInWithBetterAuth(input);
  },

  async signUp(input): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }> {
    const auth = getAuth();
    if (!auth) {
      return {
        session: {
          workspace_id: DEFAULT_WORKSPACE_ID,
          user_id: DEFAULT_USER_ID,
          device_id: 'local',
          is_authenticated: false,
          email: input.email,
        },
      };
    }
    const password = requirePassword(input.password, 'signUp');
    const normalizedEmail = input.email.toLowerCase();
    const existingUser = db
      .prepare(`SELECT "id" FROM "user" WHERE "email" = ?`)
      .get(normalizedEmail);
    if (existingUser) {
      throw new Error('AuthAdapter.signUp failed: user already exists.');
    }
    await auth.api.signUpEmail({
      body: {
        email: input.email,
        password,
        name: input.name || input.email,
        rememberMe: true,
      },
      headers: authCallHeaders(),
      returnHeaders: true,
    });
    // The live HTTP flow keeps email verification required and does not
    // auto-sign-in. The programmatic adapter needs an immediately usable
    // session, so only the freshly-created adapter user is marked verified
    // before routing through Better Auth's normal sign-in endpoint.
    const updated = db
      .prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE "email" = ?`)
      .run(normalizedEmail);
    if (Number(updated.changes || 0) !== 1) {
      throw new Error('AuthAdapter.signUp failed: user row was not created.');
    }
    return signInWithBetterAuth(input);
  },

  async signOut(session: SessionContext): Promise<void> {
    const auth = getAuth();
    if (!auth) return;
    const cookie = sessionCookieByUserId.get(session.user_id);
    if (!cookie) return;
    try {
      await auth.api.signOut({
        headers: authCallHeaders(cookie),
        returnHeaders: true,
      });
    } finally {
      sessionCookieByUserId.delete(session.user_id);
      for (const [token, storedCookie] of sessionCookieByToken.entries()) {
        if (storedCookie === cookie) sessionCookieByToken.delete(token);
      }
    }
  },

  onUserDelete(cb: (user_id: string) => void | Promise<void>): void {
    registerAuthUserDeleteListener(cb);
  },
};
