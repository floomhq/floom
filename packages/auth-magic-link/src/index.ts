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

const MAGIC_PREFIX = 'auth_magic_link:token:';
const REVOCATION_PREFIX = 'auth_magic_link:revoked:';
const DEFAULT_WORKSPACE_ID = 'local';
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;

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

function sessionFromClaims(claims: JwtClaims): SessionContext {
  return {
    workspace_id: claims.workspace_id || DEFAULT_WORKSPACE_ID,
    user_id: claims.sub,
    device_id: 'magic-link',
    is_authenticated: true,
    auth_user_id: claims.sub,
    auth_session_id: claims.jti,
    email: claims.email,
  };
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
  const url = new URL('/auth/magic-link', baseUrl);
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
  const resend = new Resend(resendApiKey);
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

    await storage.upsertUser(
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
    const session_token = jwt.sign(
      {
        workspace_id: user.workspace_id || DEFAULT_WORKSPACE_ID,
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
    const session = sessionFromClaims({
      sub: user.id,
      workspace_id: user.workspace_id || DEFAULT_WORKSPACE_ID,
      email: record.email,
      jti: sessionId,
      iss: jwtIssuer,
    });

    return {
      session,
      token: session_token,
      set_cookie: `floom_session=${encodeURIComponent(
        session_token,
      )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}`,
      user_id: user.id,
      session_token,
    };
  }

  const adapter: AuthAdapter = {
    async getSession(request: Request): Promise<SessionContext | null> {
      const token =
        bearerToken(request.headers) || cookieValue(request.headers, 'floom_session');
      if (!token) return null;
      try {
        const claims = jwt.verify(token, jwtSecret, {
          algorithms: ['HS256'],
          issuer: jwtIssuer,
        }) as JwtClaims;
        if (!claims.sub || !claims.jti) return null;
        if (await isRevoked(storage, claims.jti)) return null;
        return sessionFromClaims(claims);
      } catch {
        return null;
      }
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
