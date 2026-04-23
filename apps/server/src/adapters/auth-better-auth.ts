// Better Auth identity adapter wrapper.
//
// Wraps the reference `lib/better-auth.ts` module so it satisfies the
// `AuthAdapter` interface declared in `adapters/types.ts`.
//
// IMPORTANT scope note for this PR:
//   - `getSession(request)` is fully wired: it calls Better Auth's
//     `api.getSession({ headers })` directly, same as `resolveUserContext`
//     does today for Hono requests.
//   - `signIn` / `signUp` / `signOut` / `onUserDelete` are NOT wired in
//     this PR. The reference server already handles sign-in, sign-up, and
//     sign-out via Better Auth's HTTP handler mounted at `/auth/*` — code
//     callers never invoke them directly. Migrating the live handler to
//     go through this adapter is follow-on work; until then these methods
//     throw a clear "not yet wired" error so anyone who calls them at
//     runtime sees exactly what to do.
//
// OSS mode: Better Auth is disabled (FLOOM_CLOUD_MODE unset), so
// `getAuth()` returns null. `getSession` returns null in that case — the
// reference `resolveUserContext` synthesizes a local-mode SessionContext
// elsewhere; the adapter doesn't need to replicate that because the
// cloud/OSS branching is a routing-layer concern.

import type { SessionContext } from '../types.js';
import type { AuthAdapter } from './types.js';
import { DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } from '../db.js';
import { getAuth, isCloudMode } from '../lib/better-auth.js';

type BetterAuthSession = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    emailVerified?: boolean;
  };
  session: { id: string };
};

const deleteListeners: Array<(user_id: string) => void | Promise<void>> = [];

function notYetWired(method: string): Error {
  return new Error(
    `AuthAdapter.${method} is not yet wired on the Better Auth adapter. ` +
      "The reference server handles sign-in, sign-up, and sign-out via Better Auth's " +
      'HTTP handler mounted at /auth/*. Migrating those paths to go through ' +
      'the adapter is follow-on work (see protocol-v0.2 branch).',
  );
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

  async signIn(_input): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }> {
    throw notYetWired('signIn');
  },

  async signUp(_input): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }> {
    throw notYetWired('signUp');
  },

  async signOut(_session: SessionContext): Promise<void> {
    throw notYetWired('signOut');
  },

  onUserDelete(cb: (user_id: string) => void | Promise<void>): void {
    deleteListeners.push(cb);
  },
};
