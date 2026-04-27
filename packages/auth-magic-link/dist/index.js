import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
const MAGIC_PREFIX = 'auth_magic_link:token:';
const REVOCATION_PREFIX = 'auth_magic_link:revoked:';
const DEFAULT_WORKSPACE_ID = 'local';
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;
function normalizeEmail(email) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
        throw new Error('MagicLinkAuthAdapter: email is required.');
    }
    return normalized;
}
function requireNonEmpty(value, label) {
    if (!value || value.trim().length === 0) {
        throw new Error(`MagicLinkAuthAdapter: ${label} is required.`);
    }
    return value;
}
function secretName(prefix, id) {
    return `${prefix}${id}`;
}
function tokenId(token) {
    return createHash('sha256').update(token).digest('hex');
}
function parseJsonRecord(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function cookieValue(headers, name) {
    const raw = headers.get('cookie');
    if (!raw)
        return null;
    for (const part of raw.split(';')) {
        const [rawName, ...rest] = part.trim().split('=');
        if (rawName === name)
            return decodeURIComponent(rest.join('='));
    }
    return null;
}
function bearerToken(headers) {
    const raw = headers.get('authorization') || headers.get('Authorization');
    const match = raw?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}
function sessionFromClaims(claims, workspace_id, email) {
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
async function resolveWorkspaceId(storage, user, fallback) {
    const memberships = await storage.listWorkspacesForUser(user.id);
    return memberships[0]?.id || user.workspace_id || fallback || DEFAULT_WORKSPACE_ID;
}
async function findGlobalSecret(storage, name) {
    const rows = await storage.listAdminSecrets(null);
    return rows.find((row) => row.name === name)?.value ?? null;
}
async function isRevoked(storage, sessionId) {
    const raw = await findGlobalSecret(storage, secretName(REVOCATION_PREFIX, sessionId));
    if (!raw)
        return false;
    const record = parseJsonRecord(raw);
    if (!record || record.kind !== 'revoked-session')
        return false;
    if (Date.parse(record.expires_at) <= Date.now()) {
        await storage.deleteAdminSecret(secretName(REVOCATION_PREFIX, sessionId), null);
        return false;
    }
    return true;
}
function userIdForEmail(email) {
    return `magic_${Buffer.from(email).toString('base64url')}`;
}
async function ensureUser(storage, email, name) {
    const existing = await storage.getUserByEmail(email);
    const id = existing?.id || userIdForEmail(email);
    return storage.upsertUser({
        id,
        workspace_id: existing?.workspace_id || DEFAULT_WORKSPACE_ID,
        email,
        name: name ?? existing?.name ?? email,
        auth_provider: 'magic-link',
        auth_subject: email,
    }, ['workspace_id', 'email', 'name', 'auth_provider', 'auth_subject']);
}
function buildMagicLink(baseUrl, token) {
    const url = new URL('/auth/magic-link', baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
}
function escapeHtml(value) {
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
export function createMagicLinkAuthAdapter(opts) {
    const storage = opts.storage;
    const resendApiKey = requireNonEmpty(opts.resendApiKey, 'resendApiKey');
    const fromEmail = requireNonEmpty(opts.fromEmail, 'fromEmail');
    const jwtSecret = requireNonEmpty(opts.jwtSecret, 'jwtSecret');
    const jwtIssuer = opts.jwtIssuer || 'floom';
    const baseUrl = opts.baseUrl || 'http://localhost:3051';
    const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    const magicLinkTtlSeconds = opts.magicLinkTtlSeconds ?? DEFAULT_MAGIC_LINK_TTL_SECONDS;
    const sendEmail = opts.sendEmail ?? true;
    const resend = new Resend(resendApiKey);
    const localDeleteListeners = [];
    async function sendMagicLink(input) {
        const email = normalizeEmail(input.email);
        const user = input.createUser
            ? await ensureUser(storage, email, input.name)
            : await storage.getUserByEmail(email);
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + magicLinkTtlSeconds * 1000);
        if (user) {
            const record = {
                kind: 'magic-link',
                email,
                name: input.name ?? user.name ?? null,
                user_id: user.id,
                expires_at: expiresAt.toISOString(),
                consumed_at: null,
            };
            await storage.upsertAdminSecret(secretName(MAGIC_PREFIX, tokenId(token)), JSON.stringify(record), null);
            if (sendEmail) {
                const link = buildMagicLink(baseUrl, token);
                await resend.emails.send({
                    from: fromEmail,
                    to: email,
                    subject: 'Your Floom sign-in link',
                    html: `<p>Click to sign in: <a href="${escapeHtml(link)}">link</a>. Expires in 15 min.</p>`,
                });
            }
        }
        return {
            status: 'magic-link-sent',
            email,
            ...(opts.exposeTokenForTests && user ? { debug_token: token } : {}),
        };
    }
    async function verifyMagicLink(token) {
        if (!token || token.length < 32)
            return null;
        const key = secretName(MAGIC_PREFIX, tokenId(token));
        const raw = await findGlobalSecret(storage, key);
        if (!raw)
            return null;
        const record = parseJsonRecord(raw);
        if (!record || record.kind !== 'magic-link')
            return null;
        if (record.consumed_at || Date.parse(record.expires_at) <= Date.now()) {
            await storage.deleteAdminSecret(key, null);
            return null;
        }
        const user = (record.user_id ? await storage.getUser(record.user_id) : undefined) ||
            (await storage.getUserByEmail(record.email));
        if (!user) {
            await storage.deleteAdminSecret(key, null);
            return null;
        }
        const updatedUser = await storage.upsertUser({
            id: user.id,
            workspace_id: user.workspace_id || DEFAULT_WORKSPACE_ID,
            email: record.email,
            name: record.name ?? user.name ?? record.email,
            auth_provider: 'magic-link',
            auth_subject: record.email,
        }, ['workspace_id', 'email', 'name', 'auth_provider', 'auth_subject']);
        await storage.deleteAdminSecret(key, null);
        const sessionId = randomUUID();
        const workspaceId = await resolveWorkspaceId(storage, updatedUser, user.workspace_id);
        const session_token = jwt.sign({
            workspace_id: workspaceId,
            email: record.email,
        }, jwtSecret, {
            algorithm: 'HS256',
            expiresIn: sessionTtlSeconds,
            issuer: jwtIssuer,
            subject: user.id,
            jwtid: sessionId,
        });
        const session = sessionFromClaims({
            sub: user.id,
            workspace_id: workspaceId,
            email: record.email,
            jti: sessionId,
            iss: jwtIssuer,
        }, workspaceId, record.email);
        return {
            session,
            token: session_token,
            set_cookie: `floom_session=${encodeURIComponent(session_token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}`,
            user_id: user.id,
            session_token,
        };
    }
    const adapter = {
        async getSession(request) {
            const token = bearerToken(request.headers) || cookieValue(request.headers, 'floom_session');
            if (!token)
                return null;
            try {
                const claims = jwt.verify(token, jwtSecret, {
                    algorithms: ['HS256'],
                    issuer: jwtIssuer,
                });
                if (!claims.sub || !claims.jti)
                    return null;
                if (await isRevoked(storage, claims.jti))
                    return null;
                const user = await storage.getUser(claims.sub);
                if (!user)
                    return null;
                const workspaceId = await resolveWorkspaceId(storage, user, claims.workspace_id);
                return sessionFromClaims(claims, workspaceId, user.email);
            }
            catch {
                return null;
            }
        },
        async signIn(input) {
            return sendMagicLink({ email: input.email, createUser: false });
        },
        async signUp(input) {
            return sendMagicLink({
                email: input.email,
                name: input.name,
                createUser: true,
            });
        },
        verifyMagicLink,
        async signOut(session) {
            if (!session.auth_session_id)
                return;
            const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
            const record = {
                kind: 'revoked-session',
                user_id: session.user_id,
                expires_at: expiresAt.toISOString(),
            };
            await storage.upsertAdminSecret(secretName(REVOCATION_PREFIX, session.auth_session_id), JSON.stringify(record), null);
        },
        onUserDelete(cb) {
            const storageWithListener = storage;
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
    kind: 'auth',
    name: 'magic-link',
    protocolVersion: '^0.2',
    create: createMagicLinkAuthAdapter,
};
