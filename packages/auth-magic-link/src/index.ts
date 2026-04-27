import type {
  AuthAdapter,
  AuthMagicLinkSentResult,
  AuthSessionResult,
  SessionContext,
  StorageAdapter,
  UserRecord,
} from '@floom/adapter-types';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';

export interface MagicLinkAuthAdapterOptions {
  resendApiKey: string;
  fromEmail: string;
  jwtSecret: string;
  jwtIssuer?: string;
  storage: StorageAdapter;
  baseUrl?: string;
  sessionTtlSeconds?: number;
  magicLinkTtlSeconds?: number;
  sendEmail?: boolean;
  exposeTokenForTests?: boolean;
  resendClient?: MagicLinkEmailClient;
}

interface MagicLinkTokenRecord {
  kind: 'magic-link';
  email: string;
  name: string | null;
  user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

interface RevokedSessionRecord {
  kind: 'revoked-session';
  user_id: string;
  expires_at: string;
}

interface JwtClaims {
  sub: string;
  workspace_id: string;
  email?: string;
  jti: string;
  iss?: string;
  exp?: number;
  iat?: number;
}

type StorageWithUserDeleteListener = StorageAdapter & {
  onUserDelete?: (cb: (user_id: string) => void | Promise<void>) => void;
};

interface MagicLinkEmailClient {
  emails: {
    send(input: {
      from: string;
      to: string;
      subject: string;
      html: string;
    }): Promise<unknown> | unknown;
  };
}

interface HttpContext {
  req: {
    raw: Request;
    json(): Promise<unknown>;
    query(name: string): string | undefined;
  };
  json(data: unknown, status?: number): Response;
}

interface HttpApp {
  get(path: string, handler: (c: HttpContext) => Response | Promise<Response>): unknown;
  post(path: string, handler: (c: HttpContext) => Response | Promise<Response>): unknown;
}

const MAGIC_PREFIX = 'auth_magic_link:token:';
const REVOCATION_PREFIX = 'auth_magic_link:revoked:';
const DEFAULT_WORKSPACE_ID = 'local';
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;
const SESSION_COOKIE_NAME = 'fsid';
const MAGIC_LINK_REQUEST_INTERVAL_MS = 60_000;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new Error('MagicLinkAuthAdapter: email is required.');
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`MagicLinkAuthAdapter: ${label} is required.`);
  }
  return value;
}

function secretName(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseJsonRecord<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function cookieValue(headers: Headers, name: string): string | null {
  const raw = headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rest.join('='));
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',', 1)[0]?.trim() || 'unknown';
  return headers.get('cf-connecting-ip') || headers.get('x-real-ip') || 'unknown';
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(
    token,
  )}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function sessionFromClaims(
  claims: JwtClaims,
  workspace_id: string,
  email?: string | null,
): SessionContext {
  return {
    workspace_id,
    user_id: claims.sub,
    device_id: 'magic-link',
    is_authenticated: true,
    auth_user_id: claims.sub,
    auth_session_id: claims.jti,
    email: email || claims.email,
  };
}

async function resolveWorkspaceId(
  storage: StorageAdapter,
  user: UserRecord,
  fallback?: string | null,
): Promise<string> {
  const memberships = await storage.listWorkspacesForUser(user.id);
  return memberships[0]?.id || user.workspace_id || fallback || DEFAULT_WORKSPACE_ID;
}

async function findGlobalSecret(
  storage: StorageAdapter,
  name: string,
): Promise<string | null> {
  const rows = await storage.listAdminSecrets(null);
  return rows.find((row) => row.name === name)?.value ?? null;
}

async function isRevoked(
  storage: StorageAdapter,
  sessionId: string,
): Promise<boolean> {
  const raw = await findGlobalSecret(storage, secretName(REVOCATION_PREFIX, sessionId));
  if (!raw) return false;
  const record = parseJsonRecord<RevokedSessionRecord>(raw);
  if (!record || record.kind !== 'revoked-session') return false;
  if (Date.parse(record.expires_at) <= Date.now()) {
    await storage.deleteAdminSecret(secretName(REVOCATION_PREFIX, sessionId), null);
    return false;
  }
  return true;
}

function userIdForEmail(email: string): string {
  return `magic_${Buffer.from(email).toString('base64url')}`;
}

async function ensureUser(
  storage: StorageAdapter,
  email: string,
  name: string | undefined,
): Promise<UserRecord> {
  const existing = await storage.getUserByEmail(email);
  const id = existing?.id || userIdForEmail(email);
  return storage.upsertUser(
    {
      id,
      workspace_id: existing?.workspace_id || DEFAULT_WORKSPACE_ID,
      email,
      name: name ?? existing?.name ?? email,
      auth_provider: 'magic-link',
      auth_subject: email,
    },
    ['workspace_id', 'email', 'name', 'auth_provider', 'auth_subject'],
  );
}

function buildMagicLink(baseUrl: string, token: string): string {
  const url = new URL('/auth/magic-link/verify', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function createMagicLinkAuthAdapter(
  opts: MagicLinkAuthAdapterOptions,
): AuthAdapter {
  const storage = opts.storage;
  const resendApiKey = requireNonEmpty(opts.resendApiKey, 'resendApiKey');
  const fromEmail = requireNonEmpty(opts.fromEmail, 'fromEmail');
  const jwtSecret = requireNonEmpty(opts.jwtSecret, 'jwtSecret');
  const jwtIssuer = opts.jwtIssuer || 'floom';
  const baseUrl = opts.baseUrl || 'http://localhost:3051';
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const magicLinkTtlSeconds =
    opts.magicLinkTtlSeconds ?? DEFAULT_MAGIC_LINK_TTL_SECONDS;
  const sendEmail = opts.sendEmail ?? true;
  const resend = opts.resendClient ?? new Resend(resendApiKey);
  const requestLimitUntilByKey = new Map<string, number>();
  const localDeleteListeners: Array<(user_id: string) => void | Promise<void>> = [];

  async function sendMagicLink(input: {
    email: string;
    name?: string;
    createUser: boolean;
  }): Promise<AuthMagicLinkSentResult> {
    const email = normalizeEmail(input.email);
    const user = input.createUser
      ? await ensureUser(storage, email, input.name)
      : await storage.getUserByEmail(email);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + magicLinkTtlSeconds * 1000);

    if (user) {
      const record: MagicLinkTokenRecord = {
        kind: 'magic-link',
        email,
        name: input.name ?? user.name ?? null,
        user_id: user.id,
        expires_at: expiresAt.toISOString(),
        consumed_at: null,
      };
      await storage.upsertAdminSecret(
        secretName(MAGIC_PREFIX, tokenId(token)),
        JSON.stringify(record),
        null,
      );

      if (sendEmail) {
        const link = buildMagicLink(baseUrl, token);
        await resend.emails.send({
          from: fromEmail,
          to: email,
          subject: 'Your Floom sign-in link',
          html: `<p>Click to sign in: <a href="${escapeHtml(
            link,
          )}">link</a>. Expires in 15 min.</p>`,
        });
      }
    }

    return {
      status: 'magic-link-sent',
      email,
      ...(opts.exposeTokenForTests && user ? { debug_token: token } : {}),
    };
  }

  async function verifyMagicLink(token: string): Promise<AuthSessionResult | null> {
    if (!token || token.length < 32) return null;
    const key = secretName(MAGIC_PREFIX, tokenId(token));
    const raw = await findGlobalSecret(storage, key);
    if (!raw) return null;
    const record = parseJsonRecord<MagicLinkTokenRecord>(raw);
    if (!record || record.kind !== 'magic-link') return null;
    if (record.consumed_at || Date.parse(record.expires_at) <= Date.now()) {
      await storage.deleteAdminSecret(key, null);
      return null;
    }

    const user =
      (record.user_id ? await storage.getUser(record.user_id) : undefined) ||
      (await storage.getUserByEmail(record.email));
    if (!user) {
      await storage.deleteAdminSecret(key, null);
      return null;
    }

    const updatedUser = await storage.upsertUser(
      {
        id: user.id,
        workspace_id: user.workspace_id || DEFAULT_WORKSPACE_ID,
        email: record.email,
        name: record.name ?? user.name ?? record.email,
        auth_provider: 'magic-link',
        auth_subject: record.email,
      },
      ['workspace_id', 'email', 'name', 'auth_provider', 'auth_subject'],
    );
    await storage.deleteAdminSecret(key, null);

    const sessionId = randomUUID();
    const workspaceId = await resolveWorkspaceId(storage, updatedUser, user.workspace_id);
    const session_token = jwt.sign(
      {
        workspace_id: workspaceId,
        email: record.email,
      },
      jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: sessionTtlSeconds,
        issuer: jwtIssuer,
        subject: user.id,
        jwtid: sessionId,
      },
    );
    const session = sessionFromClaims(
      {
        sub: user.id,
        workspace_id: workspaceId,
        email: record.email,
        jti: sessionId,
        iss: jwtIssuer,
      },
      workspaceId,
      record.email,
    );

    return {
      session,
      token: session_token,
      set_cookie: sessionCookie(session_token, sessionTtlSeconds),
      user_id: user.id,
      session_token,
    };
  }

  function isRequestLimited(email: string, request: Request): boolean {
    const key = `${email}\0${clientIp(request.headers)}`;
    const now = Date.now();
    const until = requestLimitUntilByKey.get(key) || 0;
    if (until > now) return true;
    requestLimitUntilByKey.set(key, now + MAGIC_LINK_REQUEST_INTERVAL_MS);
    return false;
  }

  function unsupported(flow: string): Response {
    return new Response(
      JSON.stringify({
        error: 'unsupported_auth_flow',
        message: `${flow} is not supported by @floomhq/auth-magic-link. Use /auth/magic-link/request.`,
      }),
      {
        status: 501,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const adapter: AuthAdapter = {
    async getSession(request: Request): Promise<SessionContext | null> {
      const token =
        bearerToken(request.headers) || cookieValue(request.headers, SESSION_COOKIE_NAME);
      if (!token) return null;
      try {
        const claims = jwt.verify(token, jwtSecret, {
          algorithms: ['HS256'],
          issuer: jwtIssuer,
        }) as JwtClaims;
        if (!claims.sub || !claims.jti) return null;
        if (await isRevoked(storage, claims.jti)) return null;
        const user = await storage.getUser(claims.sub);
        if (!user) return null;
        const workspaceId = await resolveWorkspaceId(
          storage,
          user,
          claims.workspace_id,
        );
        return sessionFromClaims(claims, workspaceId, user.email);
      } catch {
        return null;
      }
    },

    async mountHttp(app: unknown, basePath: string): Promise<void> {
      const http = app as HttpApp;

      http.post(authPath(basePath, '/magic-link/request'), async (c) => {
        let email: string;
        let name: string | undefined;
        try {
          const body = await c.req.json();
          if (!isObjectRecord(body) || typeof body.email !== 'string') {
            return c.json({ error: 'email_required' }, 400);
          }
          email = normalizeEmail(body.email);
          name = typeof body.name === 'string' ? body.name : undefined;
        } catch (err) {
          if (err instanceof Error && err.message.includes('email is required')) {
            return c.json({ error: 'email_required' }, 400);
          }
          return c.json({ error: 'invalid_json' }, 400);
        }

        if (!isRequestLimited(email, c.req.raw)) {
          await sendMagicLink({ email, name, createUser: true });
        }
        return c.json({ status: 'accepted' }, 202);
      });

      const verify = async (c: HttpContext): Promise<Response> => {
        const token =
          c.req.query('token') ||
          new URL(c.req.raw.url).searchParams.get('token') ||
          '';
        const result = await verifyMagicLink(token);
        if (!result?.set_cookie) {
          return c.json({ error: 'invalid_magic_link' }, 400);
        }
        const redirectTo = process.env.PUBLIC_URL || baseUrl;
        return new Response(null, {
          status: 302,
          headers: {
            location: redirectTo,
            'set-cookie': result.set_cookie,
          },
        });
      };

      http.get(authPath(basePath, '/magic-link/verify'), verify);
      http.get(authPath(basePath, '/magic-link'), verify);

      http.post(authPath(basePath, '/sign-in/email'), async () =>
        unsupported('Email/password sign-in'),
      );
      http.post(authPath(basePath, '/sign-up/email'), async () =>
        unsupported('Email/password sign-up'),
      );
      http.post(authPath(basePath, '/delete-user'), async () =>
        unsupported('Password-based user deletion'),
      );

      const sessionHandler = async (c: HttpContext): Promise<Response> => {
        const session = await adapter.getSession(c.req.raw);
        return c.json(session);
      };
      http.get(authPath(basePath, '/session'), sessionHandler);
      http.get(authPath(basePath, '/get-session'), sessionHandler);

      http.post(authPath(basePath, '/sign-out'), async (c) => {
        const session = await adapter.getSession(c.req.raw);
        if (session) await adapter.signOut(session);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': expiredSessionCookie(),
          },
        });
      });
    },

    async signIn(input): Promise<AuthMagicLinkSentResult> {
      return sendMagicLink({ email: input.email, createUser: false });
    },

    async signUp(input): Promise<AuthMagicLinkSentResult> {
      return sendMagicLink({
        email: input.email,
        name: input.name,
        createUser: true,
      });
    },

    verifyMagicLink,

    async signOut(session: SessionContext): Promise<void> {
      if (!session.auth_session_id) return;
      const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
      const record: RevokedSessionRecord = {
        kind: 'revoked-session',
        user_id: session.user_id,
        expires_at: expiresAt.toISOString(),
      };
      await storage.upsertAdminSecret(
        secretName(REVOCATION_PREFIX, session.auth_session_id),
        JSON.stringify(record),
        null,
      );
    },

    onUserDelete(cb: (user_id: string) => void | Promise<void>): void {
      const storageWithListener = storage as StorageWithUserDeleteListener;
      if (typeof storageWithListener.onUserDelete === 'function') {
        storageWithListener.onUserDelete(cb);
        return;
      }
      localDeleteListeners.push(cb);
    },
  };

  void localDeleteListeners;
  return adapter;
}

export default {
  kind: 'auth' as const,
  name: 'magic-link',
  protocolVersion: '^0.2',
  create: createMagicLinkAuthAdapter,
};
