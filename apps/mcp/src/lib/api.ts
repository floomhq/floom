import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCredentials, updateCredentials, type StoredCredentials } from "./credentials.js";

export class WorkerosApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = "WorkerosApiError";
  }
}

export class WorkerosConnectionError extends Error {
  constructor(
    message: string,
    readonly apiBase: string,
  ) {
    super(message);
    this.name = "WorkerosConnectionError";
  }
}

type QueryValue = string | number | boolean | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
};

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${normalizeBase(base)}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchWorkeros(apiBase: string, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkerosConnectionError(
      `Cannot reach Workeros API at ${normalizeBase(apiBase)}: ${message}`,
      normalizeBase(apiBase),
    );
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function responseDetail(parsed: unknown): string {
  const detail =
    parsed && typeof parsed === "object" && "detail" in parsed
      ? (parsed as { detail: unknown }).detail
      : parsed;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

// In-process cache for the short-lived Supabase JWT. Avoids hitting
// /auth/v1/token on every CLI command; a refresh exchange takes ~200ms.
type CachedJwt = { token: string; expires_at_ms: number };
const _jwtCache = new Map<string, CachedJwt>();

async function refreshSupabaseJwt(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const url = `${normalizeBase(supabaseUrl)}/auth/v1/token?grant_type=refresh_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const parsed = (await parseResponse(response)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    msg?: string;
  };
  if (!response.ok || !parsed.access_token) {
    const detail = parsed.error_description || parsed.msg || JSON.stringify(parsed);
    throw new WorkerosApiError(
      `Supabase token refresh failed (HTTP ${response.status}): ${detail}`,
      response.status,
      parsed,
    );
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token || refreshToken,
    expires_in: parsed.expires_in || 3600,
  };
}

async function getCloudJwt(creds: StoredCredentials): Promise<string> {
  if (!creds.refresh_token || !creds.supabase_url || !creds.supabase_anon_key) {
    throw new Error(
      "Hosted credentials incomplete (missing refresh_token / supabase_url / supabase_anon_key). Run floom login --cloud again.",
    );
  }
  const cacheKey = `${creds.supabase_url}|${creds.refresh_token.slice(-12)}`;
  const cached = _jwtCache.get(cacheKey);
  const now = Date.now();
  // Refresh 60s before expiry to absorb clock skew.
  if (cached && cached.expires_at_ms - 60_000 > now) {
    return cached.token;
  }
  const refreshed = await refreshSupabaseJwt(
    creds.supabase_url,
    creds.supabase_anon_key,
    creds.refresh_token,
  );
  _jwtCache.set(cacheKey, {
    token: refreshed.access_token,
    expires_at_ms: now + refreshed.expires_in * 1000,
  });
  // Supabase rotates refresh tokens by default; persist the new one so the
  // next CLI invocation doesn't replay a stale token.
  if (refreshed.refresh_token !== creds.refresh_token) {
    try {
      await updateCredentials({ refresh_token: refreshed.refresh_token });
    } catch {
      // Best-effort; the in-memory cache covers this process even if write fails.
    }
  }
  return refreshed.access_token;
}

export class WorkerosApiClient {
  constructor(
    readonly apiBase: string,
    readonly credentials?: StoredCredentials,
  ) {}

  // In hosted mode the workeros engine is mounted under /api on the cloud
  // FastAPI app, so engine paths like "/workers" become "/api/workers".
  // Paths the cloud owns directly (/auth/*, /api/workspaces, /healthz)
  // already start with /api or /auth and are NOT rewritten.
  private resolvePath(path: string): string {
    if (this.credentials?.mode !== "cloud") return path;
    if (path.startsWith("/api/")) return path;
    if (path.startsWith("/auth/")) return path;
    if (path === "/healthz") return path;
    return `/api${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async authHeaders(): Promise<Record<string, string>> {
    if (!this.credentials) {
      throw new Error("Not logged in. Run floom login first.");
    }
    if (this.credentials.mode === "cloud") {
      if (this.credentials.api_token) {
        const headers: Record<string, string> = {
          "x-floom-token": this.credentials.api_token,
        };
        if (this.credentials.workspace_id) {
          headers["x-workeros-workspace"] = this.credentials.workspace_id;
        }
        return headers;
      }
      const jwt = await getCloudJwt(this.credentials);
      const headers: Record<string, string> = {
        authorization: `Bearer ${jwt}`,
      };
      if (this.credentials.workspace_id) {
        headers["x-workeros-workspace"] = this.credentials.workspace_id;
      }
      return headers;
    }
    if (!this.credentials.api_secret) {
      throw new Error("Not logged in. Run floom login first.");
    }
    const headers: Record<string, string> = { "x-floom-secret": this.credentials.api_secret };
    if (this.credentials.workspace_id) {
      headers["x-workeros-workspace"] = this.credentials.workspace_id;
    }
    return headers;
  }

  async requestJson(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const auth = options.auth ?? true;
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, text/event-stream",
      ...(options.headers || {}),
    };
    if (auth) {
      Object.assign(headers, await this.authHeaders());
    }
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetchWorkeros(this.apiBase, buildUrl(this.apiBase, this.resolvePath(path), options.query), {
      method,
      headers,
      body,
    });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      const detail = responseDetail(parsed);
      throw new WorkerosApiError(
        `API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
        response.status,
        parsed,
        response.headers,
      );
    }
    return parsed;
  }

  async requestBuffer(method: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const auth = options.auth ?? true;
    const headers: Record<string, string> = {
      accept: "*/*",
      ...(options.headers || {}),
    };
    if (auth) {
      Object.assign(headers, await this.authHeaders());
    }
    const response = await fetchWorkeros(this.apiBase, buildUrl(this.apiBase, this.resolvePath(path), options.query), {
      method,
      headers,
    });
    if (!response.ok) {
      const parsed = await parseResponse(response);
      const detail = responseDetail(parsed);
      throw new WorkerosApiError(
        `API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
        response.status,
        parsed,
        response.headers,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async uploadFile(inputName: string, filePath: string): Promise<string> {
    if (!this.credentials) {
      throw new Error("Not logged in. Run floom login first.");
    }
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append("file", new File([bytes], basename(filePath)));
    const response = await fetchWorkeros(this.apiBase, buildUrl(this.apiBase, this.resolvePath("/uploads")), {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(await this.authHeaders()),
      },
      body: form,
    });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      const detail = responseDetail(parsed);
      throw new WorkerosApiError(
        `Upload for input ${inputName} failed with HTTP ${response.status}: ${detail}`,
        response.status,
        parsed,
        response.headers,
      );
    }
    const uploadId = parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
    if (!uploadId || typeof uploadId !== "string") {
      throw new Error(`Upload for input ${inputName} returned no upload id`);
    }
    return uploadId;
  }
}

export async function createAuthenticatedClient(): Promise<{
  client: WorkerosApiClient;
  credentials: StoredCredentials;
}> {
  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error("Not logged in. Run floom login first.");
  }
  return {
    client: new WorkerosApiClient(credentials.api_base, credentials),
    credentials,
  };
}

export function createPublicClient(
  base = process.env.WORKEROS_API_BASE || "https://localhost:8000",
): WorkerosApiClient {
  return new WorkerosApiClient(normalizeBase(base));
}

// Used by `floom login [--cloud]` to talk to the API base before any
// credentials have been saved. WORKEROS_CLOUD=1 also flips to cloud.
export function resolveLoginApiBase(opts: { cloud?: boolean } = {}): string {
  const explicit = process.env.WORKEROS_API_BASE || process.env.FLOOM_API_BASE;
  if (explicit) return normalizeBase(explicit);
  const cloud =
    opts.cloud === true ||
    (process.env.WORKEROS_CLOUD || "").trim() === "1" ||
    (process.env.WORKEROS_CLOUD || "").trim().toLowerCase() === "true";
  return cloud ? "https://api.workeros.example.com" : "https://localhost:8000";
}
