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
// W3.1 ships with: magic link, GitHub OAuth, Google OAuth, email+password,
// API keys, organizations.
import { betterAuth } from 'better-auth';
import { magicLink, organization } from 'better-auth/plugins';
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
 * Build the Better Auth instance from env. Returns null when cloud mode is
 * disabled. Idempotent — the second call returns the cached instance.
 *
 * Required env vars in cloud mode:
 *   - BETTER_AUTH_SECRET (32+ bytes hex/base64, used for cookie signing)
 *   - BETTER_AUTH_URL    (the public origin, e.g. https://cloud.floom.dev)
 *
 * Optional:
 *   - GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET
 *   - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
 *   - FLOOM_MAGIC_LINK_EMAIL_FROM (defaults to noreply@floom.dev)
 */
export function getAuth(): FloomAuth | null {
  if (cachedAuth !== undefined) return cachedAuth;
  if (!isCloudMode()) {
    cachedAuth = null;
    return null;
  }

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

  // Pulled into a local so closures in the magic-link sendMagicLink
  // callback see the resolved value at config time, not later.
  const magicLinkFrom =
    process.env.FLOOM_MAGIC_LINK_EMAIL_FROM || 'noreply@floom.dev';

  const built = betterAuth({
    appName: 'Floom',
    secret,
    baseURL,
    // Better Auth owns its own /auth/* prefix when mounted via Hono. The
    // `basePath` here matches the mount point in apps/server/src/index.ts.
    basePath: '/auth',
    // Pass the existing better-sqlite3 instance directly; Better Auth's
    // adapter detects the SqliteDatabase shape and creates its tables on
    // first boot in cloud mode.
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
      magicLink({
        // The actual delivery is owned by the Cloud control plane (an SES /
        // Resend / SendGrid integration) — in OSS Cloud builds this hook is
        // wired by the operator. We log the link to stdout so a self-hoster
        // can copy-paste it during development without needing an SMTP
        // server. Production overrides this hook via a custom sendMagicLink
        // implementation in the Cloud monorepo.
        async sendMagicLink({ email, url, token }) {
          // eslint-disable-next-line no-console
          console.log(
            `[auth] magic link for ${email} from ${magicLinkFrom}: ${url} (token=${token.slice(0, 8)}...)`,
          );
        },
      }),
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
  });
  // Cast through `unknown` to widen the deeply-generic Better Auth return
  // type to the structural FloomAuth interface above. The shape is verified
  // by the integration test that round-trips a getSession call.
  cachedAuth = built as unknown as FloomAuth;
  return cachedAuth;
}

/**
 * Reset the cached singleton. Tests only.
 */
export function _resetAuthForTests(): void {
  cachedAuth = undefined;
}
