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
import type { UserWriteColumn, UserWriteInput } from '../adapters/types.js';
import { initiateAccountSoftDelete } from '../services/account-deletion.js';
import {
  renderResetPasswordEmail,
  renderVerificationEmail,
  renderWelcomeEmail,
  sendEmail,
} from './email.js';
import { provisionPersonalWorkspace } from '../services/workspaces.js';

// Better Auth's `Auth` type is generic over its options. Inferring the exact
// concrete type would couple every consumer to the full plugin tuple shape,
// which TypeScript can't easily widen back to `Auth<BetterAuthOptions>`. We
// expose a structural type with the bits Floom actually uses.
export interface FloomAuth {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (args: { headers: Headers }) => Promise<unknown>;
    signInEmail: (args: {
      body: { email: string; password: string; rememberMe?: boolean };
      headers?: Headers;
      returnHeaders?: boolean;
    }) => Promise<unknown>;
    signUpEmail: (args: {
      body: {
        email: string;
        password: string;
        name: string;
        rememberMe?: boolean;
      };
      headers?: Headers;
      returnHeaders?: boolean;
    }) => Promise<unknown>;
    signOut: (args: {
      headers: Headers;
      returnHeaders?: boolean;
    }) => Promise<unknown>;
    deleteUser: (args: {
      body: { password?: string; token?: string; callbackURL?: string };
      headers: Headers;
      returnHeaders?: boolean;
    }) => Promise<unknown>;
  };
}

type UserDeleteListener = (user_id: string) => void | Promise<void>;

const userDeleteListeners: UserDeleteListener[] = [];

async function upsertFloomUser(
  input: UserWriteInput,
  updateColumns: UserWriteColumn[],
): Promise<void> {
  const { adapters } = await import('../adapters/index.js');
  await adapters.storage.upsertUser(input, updateColumns);
}

export function registerAuthUserDeleteListener(cb: UserDeleteListener): void {
  userDeleteListeners.push(cb);
}

export async function notifyAuthUserDeleteListeners(user_id: string): Promise<void> {
  for (const listener of userDeleteListeners) {
    try {
      await listener(user_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] onUserDelete listener failed for user', user_id, err);
    }
  }
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
 * Build the list of origins Better Auth trusts for cookie-bearing requests.
 * Also used as the allow-list of per-request `baseURL` overrides for
 * issue #392 — only origins in this list are allowed to mint email
 * links, so an attacker can't sneak a link pointing at evil.com through
 * a crafted `Origin` header.
 */
function listTrustedOrigins(): string[] {
  const isDev = process.env.NODE_ENV !== 'production';
  return [
    'https://floom.dev',
    'https://preview.floom.dev',
    'https://app.floom.dev',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
    ...(isDev ? ['http://localhost:5173'] : []),
  ];
}

/**
 * Lazy singleton holder. Built on first access (after env vars are loaded).
 * Tests that flip FLOOM_CLOUD_MODE mid-run can call `_resetAuthForTests()`
 * to clear the cache.
 */
let cachedAuth: FloomAuth | null | undefined;

/**
 * Issue #392: per-origin Better Auth instances.
 *
 * Historical note: an earlier per-origin Better Auth cache lived here to
 * solve the same problem. It's been replaced by Better Auth's native
 * dynamic baseURL (`baseURL: { allowedHosts, fallback, protocol }`) in
 * `buildAuthOptions`, which resolves the request's origin per call and
 * mints email links pointing at the host the user signed up from — no
 * per-origin instance cache needed.
 */

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
function buildAuthOptions(_overrideBaseURL?: string): any {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'FLOOM_CLOUD_MODE=true requires BETTER_AUTH_SECRET to be at least 32 chars long. ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  const staticBaseURL =
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 3051}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socialProviders: Record<string, any> = {};
  if (process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      // Update the user's name and avatar from GitHub on EVERY login,
      // not just on first sign-up. This is the official Better Auth flag
      // that triggers internalAdapter.updateUser() inside handleOAuthUserInfo.
      overrideUserInfoOnSignIn: true,
      mapProfile: async (profile: any) => ({
        name: profile.name || profile.login,
        email: profile.email,
        image: profile.avatar_url || profile.image || null,
      }),
    };
  }
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      overrideUserInfoOnSignIn: true,
      mapProfile: async (profile: any) => ({
        name: profile.name || profile.displayName,
        email: profile.email,
        image: profile.picture || profile.image || null,
      }),
    };
  }

  // 2026-04-20: trust the vite dev server origin only when we're not
  // running in production. In prod the baseURL is the public origin and
  // there is no vite dev server; allowing localhost:5173 unconditionally
  // was a minor security smell (CSRF surface).
  //
  // 2026-04-20 (round 2): Better Auth rejects cookie-bearing POSTs when
  // the request Origin doesn't match baseURL OR any trustedOrigin — it
  // returns 403 INVALID_ORIGIN. Our prod cluster serves the same container
  // on both floom.dev (canonical) AND preview.floom.dev (staging); the
  // baseURL points at floom.dev, so sign-out from preview.floom.dev was
  // 403ing and the session cookie never cleared. Always trust the three
  // Floom production hosts so cookie-bearing auth POSTs work from any of
  // them regardless of which one the BETTER_AUTH_URL env var points at.
  const isDev = process.env.NODE_ENV !== 'production';
  const port = process.env.PORT || 3051;
  const allowedAuthHosts = Array.from(
    new Set(
      [
        'floom.dev',
        'preview.floom.dev',
        'app.floom.dev',
        `localhost:${port}`,
        `127.0.0.1:${port}`,
        ...(isDev ? ['localhost:5173', '127.0.0.1:5173'] : []),
      ].filter(Boolean),
    ),
  );
  const trustedOrigins = listTrustedOrigins();

  return {
    appName: 'Floom',
    secret,
    // Dynamic baseURL resolves social callback URLs from the incoming host
    // instead of pinning everything to BETTER_AUTH_URL. This keeps floom.dev
    // and preview.floom.dev on the correct host even when the same container
    // serves both.
    baseURL: {
      allowedHosts: allowedAuthHosts,
      fallback: staticBaseURL,
      protocol: 'auto',
    },
    trustedOrigins,
    // Better Auth owns its own /auth/* prefix when mounted via Hono. The
    // `basePath` here matches the mount point in apps/server/src/index.ts.
    basePath: '/auth',
    // Pass the existing better-sqlite3 instance directly; Better Auth's
    // Kysely adapter detects the SqliteDatabase shape. Tables are created
    // on boot by `runAuthMigrations()`, not lazily on first query.
    database: db,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      // SMTP via Resend (2026-04-20). Outside the Resend-required production
      // signal, when RESEND_API_KEY is unset the handler in ./email.ts falls
      // back to stdout: Better Auth won't crash, the reset URL just appears
      // in the server log instead of the user's inbox. `url` is built by
      // Better Auth from
      // `${baseURL}/auth/reset-password/${token}?callbackURL=...`; it
      // redirects through the built-in verification endpoint to the
      // frontend's /reset-password page, which is the canonical pattern
      // from the Better Auth docs.
      sendResetPassword: async ({
        user,
        url,
      }: {
        user: { email: string; name?: string | null };
        url: string;
        token: string;
      }): Promise<void> => {
        const { subject, html, text } = renderResetPasswordEmail({
          name: user.name ?? null,
          resetUrl: url,
        });
        const res = await sendEmail({ to: user.email, subject, html, text });
        if (!res.ok) {
          // Log and swallow: Better Auth returns a generic success to the
          // client regardless (anti-enumeration), so failing here would
          // only muddy the server log without improving UX.
          // eslint-disable-next-line no-console
          console.error(
            `[auth] sendResetPassword delivery failed for ${user.email}: ${res.reason}`,
          );
        }
      },
      resetPasswordTokenExpiresIn: 60 * 60, // 1 hour — matches email copy
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string; name?: string | null };
        url: string;
        token: string;
      }): Promise<void> => {
        const { subject, html, text } = renderVerificationEmail({
          name: user.name ?? null,
          verifyUrl: url,
        });
        const res = await sendEmail({ to: user.email, subject, html, text });
        if (!res.ok) {
          console.error(
            `[auth] sendVerificationEmail delivery failed for ${user.email}: ${res.reason}`,
          );
        }
      },
      afterEmailVerification: async (user: {
        id: string;
        email: string;
        name?: string | null;
      }): Promise<void> => {
        try {
          const publicUrl =
            process.env.PUBLIC_URL ||
            process.env.BETTER_AUTH_URL ||
            'https://floom.dev';
          const { subject, html, text } = renderWelcomeEmail({
            name: user.name ?? null,
            publicUrl,
          });
          await sendEmail({ to: user.email, subject, html, text });
        } catch (err) {
          console.error(`[auth] welcome email failed for ${user.email}:`, err);
        }
      },
    },
    // 30-day sessions with sliding renewal on activity, per spec.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    // Cookie hardening (pentest MED #382, INFO #386):
    //   - `defaultCookieAttributes.sameSite: 'strict'` applies to every
    //     Better Auth cookie, including the `session_token` we care about
    //     most. Strict mode means the session cookie is never sent on a
    //     cross-site top-level navigation, neutralising the login-CSRF
    //     variant the pentest flagged (attacker-initiated link follows
    //     that ride an existing session).
    //   - The OAuth state cookies (`state`, `oauth_state`) must remain
    //     `SameSite=Lax`. The Google/GitHub callback is a cross-site 302
    //     top-level navigation; with `Strict` the browser would drop the
    //     state cookie and Better Auth would reject the callback with a
    //     state-mismatch error, breaking OAuth sign-in entirely. We
    //     override those two cookies via `advanced.cookies.<name>.attributes`
    //     which takes precedence over `defaultCookieAttributes` (per-cookie
    //     attributes spread last in better-auth/src/cookies/index.ts).
    //   - `cookiePrefix: 'floom'` so our session cookie name doesn't
    //     collide with the W2.1 device cookie.
    //   - Pentest INFO #386 — the default name `floom.session_token`
    //     paired with a signed `<payload>.<signature>` body makes the
    //     auth backend recognisable (first-glance fingerprint of Better
    //     Auth or any HMAC-cookie library). Override the session cookie
    //     name to the opaque `__Secure-fsid` (Secure-prefix enforces
    //     HTTPS + Path=/; the value shape still carries a signature
    //     segment but the name no longer advertises the library). The
    //     matching guarantees — SameSite=Strict, HttpOnly, Secure — are
    //     unchanged; only the name is swapped. `BETTER_AUTH_SECRET` is
    //     asserted to be ≥32 chars above so the signature portion is
    //     HMAC'd with real entropy. The OAuth/state/session_data/etc.
    //     cookies keep their defaults because they're short-lived and
    //     their names don't add fingerprinting surface worth the churn.
    advanced: {
      cookiePrefix: 'floom',
      defaultCookieAttributes: {
        sameSite: 'strict',
        // Pentest MED #382 — Secure must be set unconditionally. Browsers
        // (Chrome, Firefox, Safari) exempt `localhost` and `127.0.0.1` from
        // the HTTPS requirement even with `Secure`, so local dev still
        // works. Any non-localhost host should already be HTTPS; a
        // plaintext-over-HTTP deploy is a misconfiguration we don't want
        // to silently paper over by stripping `Secure` off the session
        // cookie. Tunnels (ngrok, cloudflared) are HTTPS, so this is safe.
        // OAuth state cookies (see `cookies` block below) override sameSite
        // to `lax` so the cross-site provider callback still carries them.
        secure: true,
        httpOnly: true,
      },
      cookies: {
        // Opaque session cookie name (pentest INFO #386).
        session_token: { name: 'fsid' },
        // OAuth state cookies must remain `lax` so the provider-to-Floom
        // 302 callback still carries them. See rationale above.
        state: { attributes: { sameSite: 'lax' } },
        oauth_state: { attributes: { sameSite: 'lax' } },
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
        // Programmatic-user keys: the user generates a key in /me/api-keys,
        // sends it as `Authorization: Bearer <key>` (or `x-api-key: <key>`),
        // and Better Auth resolves the user automatically. Used for headless
        // integrations — Claude Code skill, CLI, scripts, MCP clients.
        //
        // `enableSessionForAPIKeys: true` makes `auth.api.getSession({ headers })`
        // mock a session from a valid API key, which is how `resolveUserContext`
        // picks up bearer-key callers without a separate code path.
        //
        // `customAPIKeyGetter` honours both `Authorization: Bearer <key>` (what
        // the `X-User-Api-Key` header would be confused with otherwise) and the
        // default `x-api-key` header. We strip the `Bearer ` prefix explicitly
        // so the stored hash matches the raw key. A plain `authorization` value
        // without the Bearer prefix is left alone, which is defensive against
        // older scripts.
        apiKeyHeaders: ['x-api-key'],
        requireName: true,
        maximumNameLength: 64,
        defaultPrefix: 'floom_',
        // Store first 8 chars (incl. prefix) so the UI can render `floom_ab…`
        // identifiers next to each row without ever exposing the full key.
        startingCharactersConfig: { shouldStore: true, charactersLength: 8 },
        enableSessionForAPIKeys: true,
        customAPIKeyGetter: (ctx) => {
          const headers = ctx.headers;
          if (!headers) return null;
          // 1. Explicit x-api-key — default plugin behaviour.
          const xKey = headers.get('x-api-key');
          if (xKey && xKey.length > 0) return xKey;
          // 2. Authorization: Bearer <key> — the shape documented to users.
          // We intentionally ignore `FLOOM_AUTH_TOKEN` collisions: a request
          // whose bearer is the self-host admin token will fail the API-key
          // lookup here (it's not in the apikey table) and fall through to
          // the session-cookie / FLOOM_AUTH_TOKEN check unchanged.
          const auth = headers.get('authorization') || headers.get('Authorization');
          if (!auth) return null;
          const m = /^Bearer\s+(.+)$/i.exec(auth);
          if (m && m[1] && m[1].startsWith('floom_')) return m[1];
          return null;
        },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 100 },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Fires after a new user row is committed (email+password signup
          // or social OAuth). Sends a minimal welcome email. Best-effort:
          // a delivery failure MUST NOT roll back the user, so we swallow
          // errors and only log. Also a no-op in stdout-fallback mode —
          // the sendEmail helper handles that transparently.
          after: async (user: {
            id: string;
            email: string;
            name?: string | null;
          }): Promise<void> => {
            // W3.1 cleanup: provision the Floom-side user row and a default
            // workspace immediately on creation. This ensures following
            // requests (or hooks like welcome email) can rely on the user
            // record existing in the Floom tables.
            try {
              // Priority 1: Mirror user into Floom's users table.
              // auth_provider 'better-auth' identifies these as cloud-managed accounts.
              await upsertFloomUser(
                {
                  id: user.id,
                  email: user.email,
                  name: user.name || null,
                  auth_provider: 'better-auth',
                  auth_subject: user.id,
                },
                ['email', 'name'],
              );

              // Priority 2: Provision the personal workspace.
              // provisionPersonalWorkspace is idempotent: if the user somehow
              // already has a workspace membership, it just returns it.
              provisionPersonalWorkspace(user.id, user.email, user.name);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[auth] critical: failed to provision user/workspace for ${user.email}:`,
                err,
              );
              // We don't throw here — we want the user to land on the UI where
              // session.ts resolveUserContext has a second-chance bootstrap.
            }

            try {
              const isDev = process.env.NODE_ENV !== 'production';
              const publicUrl =
                process.env.FLOOM_APP_URL ||
                process.env.PUBLIC_URL ||
                (isDev ? 'http://localhost:5173' : 'https://floom.dev');

              const { subject, html, text } = renderWelcomeEmail({
                name: user.name ?? null,
                publicUrl,
              });
              await sendEmail({ to: user.email, subject, html, text });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[auth] welcome email failed for ${user.email}:`,
                err,
              );
            }
          },
        },
      },
    },
    user: {
      // W4-minimal gap close: enable the POST /auth/delete-user endpoint so
      // /me/settings can delete an account without operator intervention.
      // `password` kwarg on the body verifies the caller owns the credentials.
      deleteUser: {
        enabled: true,
        // ADR-012: the full server shadows /auth/delete-user and routes it
        // through the account soft-delete service. This hook is a final
        // guard for direct auth.handler callers; throwing prevents Better
        // Auth from hard-deleting the credential row after the tombstone is
        // written.
        beforeDelete: async (
          user: { id: string; email?: string | null },
        ): Promise<void> => {
          if (!user?.id || !user.email) return;
          initiateAccountSoftDelete(user.id, user.email);
          await notifyAuthUserDeleteListeners(user.id);
          throw new Error('account_soft_delete_intercepted');
        },
      },
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
  const built = betterAuth(buildAuthOptions()) as unknown as FloomAuth;
  const originalDeleteUser = built.api.deleteUser.bind(built.api);
  built.api.deleteUser = async (args) => {
    try {
      return await originalDeleteUser(args);
    } catch (err) {
      if (err instanceof Error && err.message === 'account_soft_delete_intercepted') {
        return { ok: true };
      }
      throw err;
    }
  };
  // Cast through `unknown` to widen the deeply-generic Better Auth return
  // type to the structural FloomAuth interface above. The shape is verified
  // by the integration test that round-trips a getSession call.
  cachedAuth = built;
  return cachedAuth;
}

/**
 * Normalize an origin string (or return null) for the per-origin auth
 * cache. Strips any trailing path/query, lowercases the host, and
 * rejects anything that isn't an http/https URL.
 */
function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve the origin a given request claims to come from. Prefers the
 * explicit `Origin` header (set by browsers on same-site navigations +
 * XHR), then `Referer` (set on email-link navigations), then falls back
 * to synthesizing an origin from the `Host` header + request protocol —
 * which is what we see when a user clicks a verify link from their
 * inbox (no Origin, no Referer, just a GET with a Host).
 *
 * Exported so tests can stress the preference order.
 */
export function resolveRequestOrigin(req: Request): string | null {
  const origin = normalizeOrigin(req.headers.get('origin'));
  if (origin) return origin;
  const referer = normalizeOrigin(req.headers.get('referer'));
  if (referer) return referer;
  const host = req.headers.get('host');
  if (host) {
    const proto =
      req.headers.get('x-forwarded-proto') ||
      (req.url.startsWith('https://') ? 'https' : 'http');
    return normalizeOrigin(`${proto}://${host}`);
  }
  try {
    return normalizeOrigin(new URL(req.url).origin);
  } catch {
    return null;
  }
}

/**
 * Issue #392: return the Better Auth instance for a given request.
 *
 * Superseded by the dynamic `baseURL: { allowedHosts, fallback, protocol }`
 * config on the singleton itself (see `buildAuthOptions` + commit
 * `56ce0e0` — "derive social callback host from request"). Better Auth
 * now resolves the per-request origin natively, so a single shared
 * instance mints email links pointing at the correct host.
 *
 * This function is kept as a compatibility shim for `index.ts` and tests
 * that already route through `getAuthForRequest(req)` — it just hands
 * back the singleton. `_req` is intentionally unused.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getAuthForRequest(_req: Request): FloomAuth | null {
  return getAuth();
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

export function purgeUnverifiedAuthSessions(): number {
  if (!isCloudMode()) return 0;
  const result = db
    .prepare(
      `DELETE FROM "session"
        WHERE "userId" IN (
          SELECT "id" FROM "user" WHERE COALESCE("emailVerified", 0) = 0
        )`,
    )
    .run();
  return Number(result.changes || 0);
}

/**
 * Reset the cached singleton. Tests only.
 */
export function _resetAuthForTests(): void {
  cachedAuth = undefined;
}
