// Better Auth identity adapter wrapper.
//
// Wraps the reference `lib/better-auth.ts` module so it satisfies the
// `AuthAdapter` interface declared in `adapters/types.ts`.
//
// `getSession(request)` calls Better Auth's `api.getSession({ headers })`
// directly, same as `resolveUserContext` does today for Hono requests. The
// sign-in/sign-up/sign-out methods are the equivalent programmatic surface for
// callers that don't want to go through the mounted `/auth/*` HTTP handler.
//
// OSS mode: Better Auth is disabled (FLOOM_CLOUD_MODE unset), so
// `getAuth()` returns null. `getSession` returns null in that case — the
// reference `resolveUserContext` synthesizes a local-mode SessionContext
// elsewhere; the adapter doesn't need to replicate that because the
// cloud/OSS branching is a routing-layer concern.

import type { SessionContext } from '../types.js';
import type { AuthAdapter } from './types.js';
import { DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, db } from '../db.js';
import {
  getAuth,
  isCloudMode,
  registerAuthUserDeleteListener,
} from '../lib/better-auth.js';

type BetterAuthSession = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    emailVerified?: boolean;
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

function rememberSessionCookie(
  userId: string | undefined,
  token: string | null | undefined,
  setCookie: string | undefined,
): void {
  if (!setCookie) return;
  if (userId) sessionCookieByUserId.set(userId, setCookie);
  if (token) sessionCookieByToken.set(token, setCookie);
}

function sessionContextFromEmailResult(result: AuthEmailResult): SessionContext {
  if (!result.user?.id || !result.user.email) {
    throw new Error('Better Auth email flow did not return a user.');
  }
  return {
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: result.user.id,
    device_id: 'unknown',
    is_authenticated: true,
    email: result.user.email,
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
  const session = sessionContextFromEmailResult(response);
  const set_cookie = headers?.get('set-cookie') ?? undefined;
  const cookie = firstCookieFromSetCookie(set_cookie);
  rememberSessionCookie(session.user_id, response.token, cookie);
  return {
    session,
    set_cookie,
    token: response.token ?? undefined,
  };
}

export const betterAuthAdapter: AuthAdapter = {
  async getSession(request: Request): Promise<SessionContext | null> {
    if (!isCloudMode()) {
      // OSS mode: one user, one workspace, no auth wall.
      return {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_id: DEFAULT_USER_ID,
        device_id: 'local',
        is_authenticated: false,
      };
    }
    const auth = getAuth();
    if (!auth) return null;
    try {
      const result = (await auth.api.getSession({
        headers: request.headers,
      })) as BetterAuthSession | null;
      if (!result || !result.user) return null;
      // Workspace resolution is a separate concern in the reference
      // server (services/session.ts reads the active_workspace_id cookie
      // or the user's first membership). This adapter returns the
      // minimum viable session — workspace_id defaulted to DEFAULT_WORKSPACE_ID
      // for callers that just need { user_id, is_authenticated }.
      // Full workspace wiring is follow-on work.
      return {
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_id: result.user.id,
        device_id: 'unknown',
        is_authenticated: true,
        email: result.user.email,
      };
    } catch {
      return null;
    }
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
