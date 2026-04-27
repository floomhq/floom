// W2.3 Composio OAuth integration service.
//
// P.2 research (research/composio-validation.md) picked Composio as the
// primary vendor for the /build "Connect a tool" ramp. This service is a
// thin wrapper around `@composio/core` so a future Nango swap is a
// 2-day replace-the-body job instead of a ripple-out refactor.
//
// Owner model (handles the W2.3-before-W3.1 dependency inversion):
//   - owner_kind='device'  → Composio userId = `device:${device_id}`
//   - owner_kind='user'    → Composio userId = `user:${user_id}`
// The prefix is opaque to Composio; on our side, `rekeyDevice` flips
// device rows to user rows when Better Auth lands (W3.1).
//
// Auth config IDs: each Composio toolkit (gmail, notion, stripe, ...)
// requires a pre-created auth_config in the Composio dashboard. Floom
// reads these from env:
//   COMPOSIO_AUTH_CONFIG_GMAIL=ac_xxx
//   COMPOSIO_AUTH_CONFIG_NOTION=ac_xxx
//   ...
// Missing env for a provider → `CompsioConfigError` (not a 500 crash).
//
// Test injection: when `COMPOSIO_FAKE=1` is set (or `setComposioClient`
// is called explicitly), the service uses an in-memory fake that supports
// the same call shape. This is how the unit tests exercise the full
// path without a live Composio API key.

import { newConnectionId } from '../lib/ids.js';
import type { StorageAdapter } from '../adapters/types.js';
import type {
  ConnectionMetadata,
  ConnectionOwnerKind,
  ConnectionRecord,
  ConnectionStatus,
  SessionContext,
} from '../types.js';

async function storage(): Promise<StorageAdapter> {
  return (await import('../adapters/index.js')).adapters.storage;
}

// ---------- errors ----------

export class ComposioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposioConfigError';
  }
}

export class ComposioClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposioClientError';
  }
}

export class ConnectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionNotFoundError';
  }
}

// ---------- provider → auth config resolution ----------

/**
 * Canonical list of providers Floom surfaces on the /build Connect-a-tool
 * ramp. Additional providers can be connected via env-driven auth configs
 * without touching this list — it's only a documentation anchor for the UI.
 */
export const KNOWN_PROVIDERS = [
  'gmail',
  'notion',
  'stripe',
  'slack',
  'sheets',
  'airtable',
  'shopify',
  'hubspot',
  'calendar',
  'linear',
  'figma',
  'github',
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/**
 * Resolve a Composio auth_config_id for a provider by reading the
 * `COMPOSIO_AUTH_CONFIG_<UPPERCASE_PROVIDER>` env var. Throws
 * ComposioConfigError if unset so the route handler can return a clean
 * 400 with a pointer to SELF_HOST.md.
 */
export function resolveAuthConfigId(provider: string): string {
  if (!provider || typeof provider !== 'string' || provider.length === 0) {
    throw new ComposioConfigError('provider must be a non-empty string');
  }
  const key = `COMPOSIO_AUTH_CONFIG_${provider.toUpperCase()}`;
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new ComposioConfigError(
      `${key} is not set. Create a Composio auth config for ${provider} in the Composio dashboard and set this env var. See docs/connections.md.`,
    );
  }
  return value;
}

// ---------- owner key derivation ----------

/**
 * Build the string Floom passes as Composio's `userId` parameter. The
 * prefix is load-bearing: it lets Floom map Composio's account back to
 * either a device (pre-login) or a real user (post-login) without
 * forcing a Composio-side rename when the user logs in.
 */
export function buildComposioUserId(
  owner_kind: ConnectionOwnerKind,
  owner_id: string,
): string {
  if (owner_kind !== 'device' && owner_kind !== 'user') {
    throw new ComposioConfigError(`invalid owner_kind: ${owner_kind}`);
  }
  if (!owner_id || owner_id.length === 0) {
    throw new ComposioConfigError('owner_id must be non-empty');
  }
  return `${owner_kind}:${owner_id}`;
}

/**
 * Pick the owner tuple for a SessionContext. When the user is
 * authenticated we scope by user_id; otherwise by device_id. This
 * mirrors the W2.1 precedence rule used elsewhere.
 */
export function contextOwner(ctx: SessionContext): {
  owner_kind: ConnectionOwnerKind;
  owner_id: string;
} {
  if (ctx.is_authenticated) {
    return { owner_kind: 'user', owner_id: ctx.user_id };
  }
  return { owner_kind: 'device', owner_id: ctx.device_id };
}

// ---------- Composio client abstraction ----------
//
// The actual @composio/core Composio instance has a fairly chunky ctor
// (takes a provider, a client, etc.) that we don't want to drag into
// every test. Instead we define a minimal interface here and plug
// either the real SDK or a fake into it.

export interface InitiateOptions {
  callbackUrl?: string;
}

export interface ComposioConnectionRequest {
  id: string;
  status?: ConnectionStatus | string;
  redirectUrl?: string | null;
}

export interface ComposioRetrievedAccount {
  id: string;
  status: ConnectionStatus | string;
  toolkit?: { slug?: string } | null;
  data?: Record<string, unknown>;
}

export interface ComposioDeleteResponse {
  success?: boolean;
  id?: string;
}

export interface ComposioExecuteResponse {
  data?: unknown;
  successful?: boolean;
  error?: string | null;
}

export interface ComposioClient {
  connectedAccounts: {
    initiate(
      userId: string,
      authConfigId: string,
      options?: InitiateOptions,
    ): Promise<ComposioConnectionRequest>;
    get(id: string): Promise<ComposioRetrievedAccount>;
    delete(id: string): Promise<ComposioDeleteResponse>;
  };
  tools: {
    execute(
      slug: string,
      body: { userId: string; arguments?: Record<string, unknown> },
    ): Promise<ComposioExecuteResponse>;
  };
}

let clientInstance: ComposioClient | null = null;

/**
 * Test hook: inject a custom client. Exported so unit tests can swap in
 * an in-memory fake. Production code never calls this; it calls
 * `getComposioClient()` which lazily constructs the real SDK on first use.
 */
export function setComposioClient(client: ComposioClient | null): void {
  clientInstance = client;
}

/**
 * Return the active Composio client. Constructs the real `@composio/core`
 * client on first use and caches it. Throws ComposioConfigError if no
 * API key is configured.
 *
 * The real SDK is imported dynamically so CI + tests that never touch
 * Composio don't pay the cost of loading the full package.
 */
export async function getComposioClient(): Promise<ComposioClient> {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new ComposioConfigError(
      'COMPOSIO_API_KEY is not set. Get a free key from https://composio.dev and set this env var. See docs/connections.md.',
    );
  }

  // Dynamic import so the heavy SDK only loads when actually needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ComposioCtor: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('@composio/core')) as any;
    ComposioCtor = mod.Composio;
  } catch (err) {
    throw new ComposioConfigError(
      `@composio/core is not installed. Run 'pnpm install' at the repo root. (${(err as Error).message})`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = new ComposioCtor({ apiKey });

  // Thin adapter: keep our interface stable even as Composio evolves.
  clientInstance = {
    connectedAccounts: {
      async initiate(userId, authConfigId, options) {
        const req = await sdk.connectedAccounts.initiate(userId, authConfigId, {
          callbackUrl: options?.callbackUrl,
        });
        return {
          id: req.id,
          status: req.status,
          redirectUrl: req.redirectUrl ?? null,
        };
      },
      async get(id) {
        const acc = await sdk.connectedAccounts.get(id);
        return {
          id: acc.id,
          status: acc.status,
          toolkit: acc.toolkit
            ? { slug: acc.toolkit.slug }
            : null,
          data: acc.data,
        };
      },
      async delete(id) {
        const res = await sdk.connectedAccounts.delete(id);
        return { success: res?.success ?? true, id };
      },
    },
    tools: {
      async execute(slug, body) {
        const res = await sdk.tools.execute(slug, {
          userId: body.userId,
          arguments: body.arguments || {},
        });
        return {
          data: res?.data,
          successful: res?.successful ?? true,
          error: res?.error ?? null,
        };
      },
    },
  };
  return clientInstance;
}

// ---------- DB helpers ----------

async function upsertConnection(
  ctx: SessionContext,
  provider: string,
  composio_connection_id: string,
  composio_account_id: string,
  status: ConnectionStatus,
  metadata: ConnectionMetadata | null,
): Promise<ConnectionRecord> {
  const { owner_kind, owner_id } = contextOwner(ctx);
  const metadata_json = metadata ? JSON.stringify(metadata) : null;
  const id = newConnectionId();

  return (await storage()).upsertConnection({
    id,
    workspace_id: ctx.workspace_id,
    owner_kind,
    owner_id,
    provider,
    composio_connection_id,
    composio_account_id,
    status,
    metadata_json,
  });
}

// ---------- public API ----------

export interface InitiateConnectionResult {
  auth_url: string;
  connection_id: string;
  provider: string;
  expires_at: string;
}

/**
 * Kick off a new OAuth connection flow for the given provider. Creates a
 * local `connections` row in `pending` state, calls Composio to get a
 * redirect URL, returns it to the caller (which either redirects the user
 * or opens a popup). The flow completes via `finishConnection`.
 *
 * Throws ComposioConfigError if the provider has no auth config env var
 * or the SDK is unavailable.
 */
export async function initiateConnection(
  ctx: SessionContext,
  provider: string,
  callbackUrl?: string,
): Promise<InitiateConnectionResult> {
  const authConfigId = resolveAuthConfigId(provider);
  const client = await getComposioClient();
  const { owner_kind, owner_id } = contextOwner(ctx);
  const composioUserId = buildComposioUserId(owner_kind, owner_id);

  let req: ComposioConnectionRequest;
  try {
    req = await client.connectedAccounts.initiate(
      composioUserId,
      authConfigId,
      { callbackUrl },
    );
  } catch (err) {
    throw new ComposioClientError(
      `Composio initiate failed for ${provider}: ${(err as Error).message}`,
    );
  }
  if (!req.id) {
    throw new ComposioClientError(
      `Composio returned a connection request without an id for ${provider}`,
    );
  }
  if (!req.redirectUrl) {
    throw new ComposioClientError(
      `Composio returned a connection request without a redirectUrl for ${provider}`,
    );
  }

  await upsertConnection(
    ctx,
    provider,
    req.id,
    composioUserId,
    'pending',
    null,
  );

  // Composio's public docs don't expose the exact redirect TTL, so we
  // advertise a conservative 15-minute window which matches their default
  // OAuth state TTL. The client uses this purely as a UI hint.
  const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    auth_url: req.redirectUrl,
    connection_id: req.id,
    provider,
    expires_at,
  };
}

/**
 * Poll Composio for the current status of a connection request and
 * persist the result. Called either by a POST from the /build UI after
 * the OAuth popup closes, or by the client polling until status flips
 * to `active`.
 *
 * Returns the current ConnectionRecord. Throws ConnectionNotFoundError
 * if the Composio side can't find the id.
 */
export async function finishConnection(
  ctx: SessionContext,
  composio_connection_id: string,
): Promise<ConnectionRecord> {
  if (!composio_connection_id || composio_connection_id.length === 0) {
    throw new ComposioClientError('composio_connection_id is required');
  }

  // Look up the local row first. The caller must own this connection,
  // otherwise we refuse to touch it — Composio would happily return the
  // data but Floom must not let user A "finish" user B's connection.
  const { owner_kind, owner_id } = contextOwner(ctx);
  const row = await (await storage()).getConnectionByOwnerComposioId({
      workspace_id: ctx.workspace_id,
      owner_kind,
      owner_id,
      composio_connection_id,
    });
  if (!row) {
    throw new ConnectionNotFoundError(
      `no connection ${composio_connection_id} owned by ${owner_kind}:${owner_id}`,
    );
  }
  const provider = row.provider;
  const composio_account_id = row.composio_account_id;

  const client = await getComposioClient();
  let acc: ComposioRetrievedAccount;
  try {
    acc = await client.connectedAccounts.get(composio_connection_id);
  } catch (err) {
    throw new ComposioClientError(
      `Composio get failed for ${composio_connection_id}: ${(err as Error).message}`,
    );
  }

  const status = normalizeStatus(acc.status);
  const metadata: ConnectionMetadata = {};
  if (acc.data && typeof acc.data === 'object') {
    if (typeof (acc.data as Record<string, unknown>).email === 'string') {
      metadata.account_email = String((acc.data as Record<string, unknown>).email);
    }
  }

  return upsertConnection(
    ctx,
    provider,
    composio_connection_id,
    composio_account_id,
    status,
    metadata,
  );
}

/**
 * Normalize a Composio status string to our enum. Composio uses
 * `ACTIVE`, `INITIATED`, `EXPIRED`, `FAILED`, etc.; we collapse them to
 * the four states we care about.
 */
function normalizeStatus(raw: unknown): ConnectionStatus {
  if (typeof raw !== 'string') return 'pending';
  const up = raw.toUpperCase();
  if (up === 'ACTIVE') return 'active';
  if (up === 'EXPIRED') return 'expired';
  if (up === 'FAILED' || up === 'REVOKED' || up === 'DELETED') return 'revoked';
  return 'pending';
}

/**
 * List connections owned by the caller. Only returns rows for the
 * current tenant (workspace) + owner (device or user).
 *
 * Optionally filter by status — defaults to returning every status.
 */
export async function listConnections(
  ctx: SessionContext,
  opts?: { status?: ConnectionStatus },
): Promise<ConnectionRecord[]> {
  const { owner_kind, owner_id } = contextOwner(ctx);
  return (await storage()).listConnections({
    workspace_id: ctx.workspace_id,
    owner_kind,
    owner_id,
    status: opts?.status,
  });
}

/**
 * Fetch a single connection for the caller by provider.
 */
export async function getConnection(
  ctx: SessionContext,
  provider: string,
): Promise<ConnectionRecord | null> {
  const { owner_kind, owner_id } = contextOwner(ctx);
  const row = await (await storage()).getConnectionByOwnerProvider({
    workspace_id: ctx.workspace_id,
    owner_kind,
    owner_id,
    provider,
  });
  if (!row) return null;
  return row;
}

/**
 * Revoke a connection. Calls Composio's `delete` API, then flips the
 * local row to `revoked`. Returns the updated record, or null if no
 * such connection exists for the caller.
 *
 * Idempotent: if the Composio side is already gone, we still flip the
 * local row. If the local row is already revoked, we just return it.
 */
export async function revokeConnection(
  ctx: SessionContext,
  provider: string,
): Promise<ConnectionRecord | null> {
  const existing = await getConnection(ctx, provider);
  if (!existing) return null;
  if (existing.status === 'revoked') return existing;

  const client = await getComposioClient();
  try {
    await client.connectedAccounts.delete(existing.composio_connection_id);
  } catch (err) {
    // Composio returns 404 if the account was already removed server-side.
    // We swallow that and still revoke locally so the UI matches reality.
    const msg = (err as Error).message || '';
    if (!/not ?found|404/i.test(msg)) {
      throw new ComposioClientError(
        `Composio delete failed for ${provider}: ${msg}`,
      );
    }
  }

  const updated = await (await storage()).updateConnection(existing.id, {
    status: 'revoked',
  });
  return updated || { ...existing, status: 'revoked' };
}

/**
 * Execute a Composio tool action on behalf of the caller. Looks up the
 * connection for the provider, builds the Composio `userId` from the
 * caller context (matching the one we passed at `initiate` time), and
 * dispatches the call.
 *
 * Throws ConnectionNotFoundError if the caller has not connected this
 * provider yet.
 *
 * `action` is the Composio tool slug (e.g. `GMAIL_SEND_EMAIL`).
 */
export async function executeAction(
  ctx: SessionContext,
  provider: string,
  action: string,
  params: Record<string, unknown>,
): Promise<ComposioExecuteResponse> {
  const conn = await getConnection(ctx, provider);
  if (!conn || conn.status !== 'active') {
    throw new ConnectionNotFoundError(
      `no active ${provider} connection for this caller`,
    );
  }

  const client = await getComposioClient();
  try {
    return await client.tools.execute(action, {
      userId: conn.composio_account_id,
      arguments: params,
    });
  } catch (err) {
    throw new ComposioClientError(
      `Composio execute failed for ${action}: ${(err as Error).message}`,
    );
  }
}
