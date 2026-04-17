// W3.1 Better Auth integration.
//
// Wraps `better-auth@1.6.3` with the configuration Floom uses in Cloud mode
// (multi-user, magic link, GitHub + Google OAuth, email+password, API keys,
// organizations).
//
// CRITICAL: Better Auth is ONLY initialized when `FLOOM_CLOUD_MODE=true`. In
// OSS mode (the v0.3.2 default) this module exports `null` for `auth` so
// nothing in the better-auth plugin chain runs and the synthetic 'local'
// workspace + user keep working exactly as before. A typecheck for
// `auth === null` is the single branch that decides whether the
// resolveUserContext middleware reads cookies from Better Auth or returns
// the local-mode constants.
//
// Per P.1 research (better-auth-comparison.md), the deferred plugins are:
//   - SAML (W5.1)
//   - Okta / Entra (W5.1)
//   - 2FA (W5.1)
//   - Passkeys (deferred)
//   - Magic link (disabled 2026-04-17: UI removed in PR #5; disabling the
//     Better Auth plugin closes the backend endpoint so /auth/sign-in/magic-link
//     returns 404 instead of silently accepting POSTs from anyone who knows
//     the path)
// W3.1 ships with: GitHub OAuth, Google OAuth, email+password, API keys,
// organizations.
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { organization } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { db } from '../db.js';

// Better Auth's `Auth` type is generic over its options. Inferring the exact
// concrete type would couple every consumer to the full plugin tuple shape,
// which TypeScript can't easily widen back to `Auth<BetterAuthOptions>`. We
// expose a structural type with the bits Floom actually uses (handler +
// api.getSession). Callers that need additional methods can cast.
export interface FloomAuth {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (args: { headers: Headers }) => Promise<unknown>;
  };
}

/**
 * Returns true when Floom should boot Better Auth and bind every request
 * to a real authenticated user. In OSS mode (the default) this is false
 * and `getAuth()` returns null.
 */
export function isCloudMode(): boolean {
  const v = (process.env.FLOOM_CLOUD_MODE || '').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Lazy singleton holder. Built on first access (after env vars are loaded).
 * Tests that flip FLOOM_CLOUD_MODE mid-run can call `_resetAuthForTests()`
 * to clear the cache.
 */
let cachedAuth: FloomAuth | null | undefined;

/**
 * Build the Better Auth options object from env. Shared by `getAuth()` (which
 * wraps it in `betterAuth(...)`) and `runAuthMigrations()` (which passes it
 * straight to `getMigrations(...)`). Idempotent and side-effect-free.
 *
 * Required env vars in cloud mode:
 *   - BETTER_AUTH_SECRET (32+ bytes hex/base64, used for cookie signing)
 *   - BETTER_AUTH_URL    (the public origin, e.g. https://cloud.floom.dev)
 *
 * Optional:
 *   - GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET
 *   - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
 */
// Typed as `Parameters<typeof betterAuth>[0]` so the return type is always
// structurally assignable to what `betterAuth(...)` expects. Kept local so
// callers don't import Better Auth's generic BetterAuthOptions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAuthOptions(): any {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'FLOOM_CLOUD_MODE=true requires BETTER_AUTH_SECRET to be at least 16 chars long. ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  const baseURL =
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 3051}`;

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
    };
  }
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    };
  }

  return {
    appName: 'Floom',
    secret,
    baseURL,
    // Better Auth owns its own /auth/* prefix when mounted via Hono. The
    // `basePath` here matches the mount point in apps/server/src/index.ts.
    basePath: '/auth',
    // Pass the existing better-sqlite3 instance directly; Better Auth's
    // Kysely adapter detects the SqliteDatabase shape. Tables are created
    // on boot by `runAuthMigrations()`, not lazily on first query.
    database: db,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    // 30-day sessions with sliding renewal on activity, per spec.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    // HttpOnly + Secure (in cloud) + SameSite=Lax. Better Auth defaults to
    // HttpOnly+SameSite=Lax already; we just pin the session cookie name to
    // a Floom-prefixed value so it doesn't collide with the W2.1 device cookie.
    advanced: {
      cookiePrefix: 'floom',
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: true,
        httpOnly: true,
      },
    },
    socialProviders,
    plugins: [
      // Magic link plugin intentionally omitted — disabled 2026-04-17.
      // UI was removed in PR #5; leaving the plugin registered kept the
      // /auth/sign-in/magic-link endpoint alive for anyone who knew the
      // path. Email+password and OAuth remain as the supported sign-in
      // methods.
      organization({
        // Floom's "workspace" is Better Auth's "organization". We expose it
        // under the workspace name in our public API while using the org
        // tables under the hood.
        allowUserToCreateOrganization: true,
        organizationLimit: 100,
        membershipLimit: 1000,
        creatorRole: 'admin',
        // Three roles per spec: admin (full control), editor (CRUD apps +
        // memory), viewer (read-only).
        // Better Auth defaults are fine; we extend with a viewer role at
        // runtime via `createAccessControl` if the operator needs it. For
        // W3.1 we keep the defaults (owner, admin, member) and map them in
        // services/workspaces.ts to (admin, editor, viewer) externally.
      }),
      apiKey({
        // Programmatic-user keys: the user generates a key in the dashboard,
        // sends it as `Authorization: Bearer <key>`, and Better Auth resolves
        // the user automatically. Used for headless integrations with MCP.
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 100 },
      }),
    ],
    user: {
      // W4-minimal gap close: enable the POST /auth/delete-user endpoint so
      // /me/settings can delete an account without operator intervention.
      // `password` kwarg on the body verifies the caller owns the credentials.
      deleteUser: { enabled: true },
    },
  };
}

/**
 * Build the Better Auth instance from env. Returns null when cloud mode is
 * disabled. Idempotent — the second call returns the cached instance.
 */
export function getAuth(): FloomAuth | null {
  if (cachedAuth !== undefined) return cachedAuth;
  if (!isCloudMode()) {
    cachedAuth = null;
    return null;
  }
  const built = betterAuth(buildAuthOptions());
  // Cast through `unknown` to widen the deeply-generic Better Auth return
  // type to the structural FloomAuth interface above. The shape is verified
  // by the integration test that round-trips a getSession call.
  cachedAuth = built as unknown as FloomAuth;
  return cachedAuth;
}

/**
 * Idempotent boot-time migration runner. In cloud mode, resolves the Better
 * Auth schema from the same options `getAuth()` uses, and creates any
 * missing tables (`user`, `session`, `account`, `verification`, organization
 * tables, api-key tables, ...). Safe to call on every boot — Better Auth's
 * `getMigrations` diffs the current table state against the target schema
 * and only emits CREATE TABLE / ALTER TABLE statements for missing rows.
 *
 * In OSS mode this is a no-op.
 *
 * Throws on migration failure so the server fails fast instead of booting
 * with a half-initialized auth DB.
 */
export async function runAuthMigrations(): Promise<{
  applied: number;
  tables: string[];
}> {
  if (!isCloudMode()) return { applied: 0, tables: [] };
  const options = buildAuthOptions();
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(options);
  const newTables = toBeCreated.map((t: { table: string }) => t.table);
  const changedTables = toBeAdded.map((t: { table: string }) => t.table);
  const total = newTables.length + changedTables.length;
  if (total === 0) return { applied: 0, tables: [] };
  await runMigrations();
  // eslint-disable-next-line no-console
  console.log(
    `[auth] migrations applied: ${newTables.length} new table(s) [${newTables.join(', ') || '-'}], ` +
      `${changedTables.length} altered table(s) [${changedTables.join(', ') || '-'}]`,
  );
  return { applied: total, tables: [...newTables, ...changedTables] };
}

/**
 * Reset the cached singleton. Tests only.
 */
export function _resetAuthForTests(): void {
  cachedAuth = undefined;
}
