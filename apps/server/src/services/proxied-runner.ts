// Proxied runner: forward HTTP requests to an external API with secret injection.
// Used when app.app_type === 'proxied' (i.e. app registered via OpenAPI spec URL).
import type {
  AppRecord,
  AuthConfig,
  AuthType,
  NormalizedManifest,
  ActionSpec,
} from '../types.js';
import {
  isFileEnvelope,
  decodeEnvelope,
  type FileEnvelope,
} from '../lib/file-inputs.js';

// Inputs whose names start with these prefixes route to HTTP headers / cookies
// instead of to path / query / body. The prefixes are added by openapi-ingest's
// operationToAction so that e.g. an `Authorization` header input doesn't
// collide with a body field called `authorization`.
const HEADER_PREFIX = 'header_';
const COOKIE_PREFIX = 'cookie_';

export interface ProxiedRunInput {
  app: AppRecord;
  manifest: NormalizedManifest;
  action: string;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
  timeoutMs?: number;
}

export type ProxiedErrorType =
  | 'user_input_error'
  | 'auth_error'
  | 'upstream_outage'
  | 'network_unreachable'
  | 'timeout'
  | 'missing_secret'
  | 'floom_internal_error'
  | 'runtime_error'
  // Creator-config bug (e.g. upstream returns 401/403 but the manifest
  // declares no `secrets_needed`). Different from `auth_error` because
  // the user cannot fix it — routing it to `auth_error` would show the
  // "Open Secrets" dead-end (see web/components/runner/OutputPanel.tsx).
  | 'app_unavailable';

export interface ProxiedRunResult {
  status: 'success' | 'error';
  outputs: unknown;
  error?: string;
  /**
   * HTTP status returned by the upstream API, when one was received.
   * Absent for pre-response failures (DNS / TCP / TLS / timeout before
   * headers) and for MissingSecretsError. The client runner surface uses
   * this to pick the exact error-taxonomy class, and the persisted
   * `runs.upstream_status` column carries it back on GET /api/run/:id.
   */
  upstream_status?: number;
  /**
   * Taxonomy class the runner is confident about at the source. Lets the
   * control-plane persist a precise `runs.error_type` instead of the
   * generic 'runtime_error' catch-all — the /p/:slug runner then picks
   * the matching headline without re-parsing the raw error string.
   */
  error_type?: ProxiedErrorType;
  duration_ms: number;
  logs: string;
}

export class MissingSecretsError extends Error {
  required: string[];
  help?: string;
  constructor(required: string[], help?: string) {
    super(`Missing required secrets: ${required.join(', ')}`);
    this.name = 'MissingSecretsError';
    this.required = required;
    this.help = help;
  }
}

// ---------- helpers ----------

/**
 * Given the cached OpenAPI spec and the action name, find the matching
 * operation (path + method) so we can build the correct URL.
 */
interface OperationInfo {
  method: string;
  path: string;
  paramNames: {
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie' | 'body';
  }[];
  requestBody?: {
    content?: Record<string, unknown>;
    required?: boolean;
  };
}

function findOperation(
  spec: Record<string, unknown>,
  actionName: string,
): OperationInfo | null {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths || {};
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of methods) {
      const op = pathItem[method] as
        | {
            operationId?: string;
            parameters?: Array<{ name: string; in: string }>;
            requestBody?: { content?: Record<string, unknown>; required?: boolean };
          }
        | undefined;
      if (!op) continue;

      // Reconstruct the name the same way openapi-ingest.ts does
      const candidateName = op.operationId
        ? op.operationId.replace(/[^a-zA-Z0-9_]/g, '_')
        : `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

      if (candidateName !== actionName) continue;

      const paramNames: OperationInfo['paramNames'] = [];
      for (const param of op.parameters || []) {
        if (
          param.in === 'path' ||
          param.in === 'query' ||
          param.in === 'header' ||
          param.in === 'cookie'
        ) {
          paramNames.push({
            name: param.name,
            in: param.in as 'path' | 'query' | 'header' | 'cookie',
          });
        }
      }
      if (op.requestBody) {
        paramNames.push({ name: 'body', in: 'body' });
      }

      return { method, path, paramNames, requestBody: op.requestBody };
    }
  }
  return null;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  inputs: Record<string, unknown>,
  pathParams: string[],
  queryParams: string[],
): string {
  // Substitute path parameters (e.g. /pet/{petId})
  let resolvedPath = path;
  for (const name of pathParams) {
    resolvedPath = resolvedPath.replace(
      `{${name}}`,
      encodeURIComponent(String(inputs[name] ?? '')),
    );
  }

  // Preserve the base URL's path prefix. `new URL(rel, base)` resolves against
  // `base`, but a rel starting with `/` REPLACES the base pathname. So
  //   new URL('/pet/findByStatus', 'https://petstore3.swagger.io/api/v3')
  //   → 'https://petstore3.swagger.io/pet/findByStatus'  (wrong, /api/v3 gone)
  // We concatenate the base pathname + relative path explicitly, then
  // construct a URL against the origin so the searchParams helpers work.
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, ''); // strip trailing slashes
  const relPath = resolvedPath.startsWith('/')
    ? resolvedPath
    : '/' + resolvedPath;
  const joinedPath = (basePath + relPath).replace(/\/{2,}/g, '/');

  const url = new URL(joinedPath, base.origin);
  // Preserve any query params already on the base URL (rare, but valid).
  for (const [k, v] of base.searchParams.entries()) {
    url.searchParams.set(k, v);
  }
  for (const name of queryParams) {
    if (inputs[name] !== undefined && inputs[name] !== null && inputs[name] !== '') {
      url.searchParams.set(name, String(inputs[name]));
    }
  }
  return url.toString();
}

// ---------- OAuth2 token cache ----------
// Client-credentials tokens are cached in-memory for the life of the process.
// Keyed by "<token_url>::<client_id>". Each entry has { token, expires_at }.
const oauth2TokenCache = new Map<string, { token: string; expires_at: number }>();

  const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'connection',
  'content-length',
]);

async function fetchOAuth2ClientCredentialsToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scopes?: string,
): Promise<string> {
  const cacheKey = `${tokenUrl}::${clientId}`;
  const cached = oauth2TokenCache.get(cacheKey);
  // Reuse cached token if at least 60s left before expiry.
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.token;
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  if (scopes) form.set('scope', scopes);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errorText = await res.text();
    const redactedText = errorText.substring(0, 256).replace(clientSecret, '[redacted]');
    throw new Error(
      `OAuth2 token endpoint returned HTTP ${res.status}: ${redactedText}${errorText.length > 256 ? '...' : ''}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error(
      `OAuth2 token endpoint response missing access_token: ${JSON.stringify(json)}`,
    );
  }
  const expires_at = Date.now() + (json.expires_in ?? 3600) * 1000;
  oauth2TokenCache.set(cacheKey, { token: json.access_token, expires_at });
  return json.access_token;
}

async function buildAuthHeaders(
  authType: AuthType | null,
  secrets: Record<string, string>,
  authConfig: AuthConfig | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  if (authType === 'bearer') {
    // Prefer an explicit *_TOKEN / *_API_KEY / *_BEARER secret; otherwise
    // fall back to the first non-empty secret value.
    const preferred = Object.entries(secrets).find(
      ([k, v]) =>
        !!v &&
        (k.toLowerCase().includes('token') ||
          k.toLowerCase().includes('api_key') ||
          k.toLowerCase().includes('bearer')),
    );
    const tokenValue = preferred
      ? preferred[1]
      : Object.values(secrets).find((v) => v && v.length > 0);
    if (tokenValue) {
      headers['Authorization'] = `Bearer ${tokenValue}`;
    }
  } else if (authType === 'apikey') {
    const keyValue = Object.values(secrets).find((v) => v && v.length > 0);
    const headerName = authConfig?.apikey_header || 'X-API-Key';
    if (keyValue) {
      headers[headerName] = keyValue;
    }
  } else if (authType === 'basic') {
    // Expect FLOOM_BASIC_USER + FLOOM_BASIC_PASSWORD (or any pair where
    // secret names contain 'user' and 'pass').
    const userEntry = Object.entries(secrets).find(
      ([k, v]) => !!v && /user/i.test(k),
    );
    const passEntry = Object.entries(secrets).find(
      ([k, v]) => !!v && /pass/i.test(k),
    );
    if (userEntry && passEntry) {
      const token = Buffer.from(`${userEntry[1]}:${passEntry[1]}`).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    }
  } else if (authType === 'oauth2_client_credentials') {
    if (!authConfig?.oauth2_token_url) {
      throw new Error(
        'oauth2_client_credentials auth requires oauth2_token_url in apps.yaml',
      );
    }
    const clientIdEntry = Object.entries(secrets).find(
      ([k, v]) => !!v && /client_id|clientid/i.test(k),
    );
    const clientSecretEntry = Object.entries(secrets).find(
      ([k, v]) => !!v && /client_secret|clientsecret/i.test(k),
    );
    if (!clientIdEntry || !clientSecretEntry) {
      throw new Error(
        'oauth2_client_credentials auth requires two secrets: one whose name contains "client_id" and one "client_secret"',
      );
    }
    const token = await fetchOAuth2ClientCredentialsToken(
      authConfig.oauth2_token_url,
      clientIdEntry[1],
      clientSecretEntry[1],
      authConfig.oauth2_scopes,
    );
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

// ---------- main export ----------

export async function runProxied(input: ProxiedRunInput): Promise<ProxiedRunResult> {
  const start = Date.now();
  const logs: string[] = [];

  try {
    const { app, manifest, action, inputs, secrets } = input;

    if (!app.base_url) {
      throw new Error(`App ${app.slug} has no base_url configured`);
    }

    const actionSpec: ActionSpec | undefined = manifest.actions[action];
    if (!actionSpec) {
      throw new Error(`Action "${action}" not found in manifest for ${app.slug}`);
    }

    // Parse the cached spec to find the matching operation
    let spec: Record<string, unknown> = {};
    if (app.openapi_spec_cached) {
      try {
        spec = JSON.parse(app.openapi_spec_cached) as Record<string, unknown>;
      } catch {
        logs.push('[warn] Could not parse cached OpenAPI spec; using generic request');
      }
    }

    // Validate required secrets BEFORE making the request so the caller
    // (web UI / MCP / HTTP) can surface a clear missing_secrets error.
    //
    // Prefer the action's own `secrets_needed` when present: the OpenAPI
    // ingest pipeline populates it from each operation's effective
    // `security` (operation-level overrides global). Falling back to the
    // manifest-level list is only needed for v1 manifests and for apps
    // ingested before this field existed. This is the fix for
    // INGEST-SECRETS-GLOBAL — the old blanket check blocked public
    // operations like petstore's findPetsByStatus just because some OTHER
    // operation (getInventory) strictly required api_key.
    const requiredSecrets =
      actionSpec.secrets_needed !== undefined
        ? actionSpec.secrets_needed
        : manifest.secrets_needed || [];
    const missing = requiredSecrets.filter((name) => !secrets[name]);
    if (missing.length > 0) {
      throw new MissingSecretsError(
        missing,
        `This action needs ${missing.join(
          ', ',
        )}. Set via docker -e, apps.yaml, or _auth meta param (MCP).`,
      );
    }

    const opInfo = findOperation(spec, action);
    logs.push(`[proxied] ${app.slug}/${action} → ${opInfo ? `${opInfo.method.toUpperCase()} ${opInfo.path}` : 'POST /'}`);

    let method = 'GET';
    let url: string;
    const extraHeaders: Record<string, string> = {};
    const cookieParts: string[] = [];
    let body: string | FormData | undefined;
    let bodyContentType: string | undefined = 'application/json';

    if (opInfo) {
      const pathParamNames = opInfo.paramNames
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      const queryParamNames = opInfo.paramNames
        .filter((p) => p.in === 'query')
        .map((p) => p.name);

      method = opInfo.method.toUpperCase();
      url = buildUrl(app.base_url, opInfo.path, inputs, pathParamNames, queryParamNames);

      // Extract header_* and cookie_* inputs → HTTP headers / Cookie header.
      for (const [k, v] of Object.entries(inputs)) {
        if (v === undefined || v === null || v === '') continue;
        if (k.startsWith(HEADER_PREFIX)) {
          const headerName = k.slice(HEADER_PREFIX.length).replace(/_/g, '-');
          if (FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
            console.warn(`[proxied] blocking reserved header injection via input: ${headerName}`);
            continue;
          }
          extraHeaders[headerName] = String(v);
        } else if (k.startsWith(COOKIE_PREFIX)) {
          const cookieName = k.slice(COOKIE_PREFIX.length);
          cookieParts.push(
            `${cookieName}=${encodeURIComponent(String(v))}`,
          );
        }
      }

      // Build body for POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        // Detect multipart from the cached spec's requestBody.content
        const content = opInfo.requestBody?.content;
        const isMultipart =
          !!content &&
          typeof content === 'object' &&
          'multipart/form-data' in content &&
          !('application/json' in content);

        const paramSet = new Set([...pathParamNames, ...queryParamNames]);
        const bodyFieldInputs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(inputs)) {
          if (
            !paramSet.has(k) &&
            !k.startsWith(HEADER_PREFIX) &&
            !k.startsWith(COOKIE_PREFIX) &&
            v !== undefined &&
            v !== null &&
            v !== ''
          ) {
            bodyFieldInputs[k] = v;
          }
        }

        if (isMultipart) {
          // Multipart form body. File fields can arrive as:
          //   1. A FileEnvelope — the shape produced by
          //      apps/web/src/api/serialize-inputs.ts. This is the one
          //      path both runtimes share. Decode and wrap in a Blob.
          //   2. A Blob/File — direct object (legacy, used by
          //      test harnesses that skip the client serializer).
          //   3. A base64 data URL — pre-envelope legacy path; kept for
          //      compatibility until we're confident no caller still
          //      produces it.
          // Non-file fields pass through as form fields.
          const form = new FormData();
          for (const [k, v] of Object.entries(bodyFieldInputs)) {
            if (k === 'body') continue; // generic textarea fallback, skip
            if (isFileEnvelope(v)) {
              // Shared path — same envelope that Docker materializes.
              const envelope = v as FileEnvelope;
              const bin = decodeEnvelope(k, envelope);
              form.append(
                k,
                new Blob([bin], { type: envelope.mime_type }),
                envelope.name,
              );
            } else if (v instanceof Blob) {
              form.append(k, v);
            } else if (
              typeof v === 'string' &&
              v.startsWith('data:') &&
              v.includes('base64,')
            ) {
              // data URL: data:image/png;base64,AAAA...
              const [meta, b64] = v.split('base64,');
              const mime = meta.slice(5).replace(/;$/, '') || 'application/octet-stream';
              const bin = Buffer.from(b64, 'base64');
              form.append(k, new Blob([bin], { type: mime }), k);
            } else {
              form.append(k, String(v));
            }
          }
          body = form;
          // Let fetch set the Content-Type with boundary automatically.
          bodyContentType = undefined;
        } else {
          const bodyInput = inputs['body'];
          if (typeof bodyInput === 'string' && Object.keys(bodyFieldInputs).length === 1) {
            // Pure freeform textarea body — try to parse as JSON.
            try {
              body = JSON.stringify(JSON.parse(bodyInput));
            } catch {
              body = bodyInput;
              bodyContentType = 'text/plain';
            }
          } else if (Object.keys(bodyFieldInputs).length > 0) {
            body = JSON.stringify(bodyFieldInputs);
            bodyContentType = 'application/json';
          }
        }
      }
    } else {
      // Fallback: generic POST to base_url
      logs.push(`[proxied] no operation found for "${action}", falling back to generic POST`);
      method = 'POST';
      url = app.base_url;
      body = JSON.stringify(inputs);
    }

    logs.push(`[proxied] ${method} ${url}`);

    // Parse the auth_config blob (apikey_header, oauth2 config, etc.).
    let authConfig: AuthConfig | null = null;
    if (app.auth_config) {
      try {
        authConfig = JSON.parse(app.auth_config) as AuthConfig;
      } catch {
        logs.push('[warn] Could not parse auth_config; using defaults');
      }
    }

    const authHeaders = await buildAuthHeaders(app.auth_type, secrets, authConfig);
    const requestHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...authHeaders,
      ...extraHeaders,
    };
    if (bodyContentType && !(body instanceof FormData)) {
      requestHeaders['Content-Type'] = bodyContentType;
    }
    if (cookieParts.length > 0) {
      requestHeaders['Cookie'] = cookieParts.join('; ');
    }

    const requestTimeoutMs =
      input.timeoutMs && input.timeoutMs > 0
        ? input.timeoutMs
        : app.timeout_ms && app.timeout_ms > 0
          ? Math.max(30_000, app.timeout_ms)
          : 30_000;

    const fetchInit: RequestInit = {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(requestTimeoutMs),
    };
    if (body !== undefined && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchInit.body = body as BodyInit;
    }

    const res = await fetch(url, fetchInit);
    const responseContentType = res.headers.get('content-type') || '';
    const isStreaming =
      responseContentType.includes('text/event-stream') ||
      responseContentType.includes('application/x-ndjson') ||
      responseContentType.includes('application/stream+json');

    let responseText: string;
    let parsed: unknown;

    if (isStreaming && res.body) {
      // Stream the body in chunks. We accumulate everything so the final
      // `outputs` field contains the full response, but we also push each
      // chunk into `logs` so SSE subscribers see it live.
      logs.push(
        `[proxied] streaming response (${responseContentType}) — reading chunks`,
      );
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let buffered = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        buffered += text;
        // Emit any complete newline-delimited chunks.
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) logs.push(`[stream] ${line}`);
        }
      }
      if (buffered.trim()) logs.push(`[stream] ${buffered}`);
      responseText = chunks.join('');

      // NDJSON: parse each line as JSON and return an array.
      // SSE: leave as text (clients already know the format).
      if (responseContentType.includes('ndjson')) {
        const out: unknown[] = [];
        for (const line of responseText.split('\n')) {
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            out.push(line);
          }
        }
        parsed = out;
      } else {
        parsed = responseText;
      }
    } else {
      responseText = await res.text();
      parsed = responseText;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        // leave as text
      }
    }

    logs.push(`[proxied] HTTP ${res.status} (${Date.now() - start}ms)`);

    const duration_ms = Date.now() - start;

    if (res.ok) {
      return {
        status: 'success',
        outputs: parsed,
        duration_ms,
        logs: logs.join('\n'),
      };
    }

    // Error taxonomy (2026-04-20): split by root cause so the runner
    // surface can show "The app didn't accept your input." for 4xx
    // instead of "Can't reach this app right now" (which was both wrong
    // and trained users to retry identical bad input). Surface a
    // one-line upstream body message when the response had a JSON
    // envelope with `message` / `error` / `detail` — that's usually the
    // single most useful breadcrumb for debugging. Stack traces and
    // long blobs still live in the full `logs`.
    const upstreamMessage = extractUpstreamMessage(parsed, responseText);
    // Dead-end fix (2026-04-20): a 401/403 on an app whose manifest
    // declares no secrets is a creator-config bug, not an auth problem
    // the user can solve. Before this guard the UI showed "This app
    // needs authentication — Open Secrets", which routed to a panel
    // that said "This app doesn't declare any secrets. Nothing to
    // configure here." A direct contradiction. Now we classify as
    // `app_unavailable` so the runner surface renders a neutral "This
    // app is temporarily unavailable" card with no Open-Secrets link.
    const manifestSecrets = input.manifest.secrets_needed ?? [];
    let errorType: ProxiedErrorType = classifyHttpStatus(res.status);
    if (
      errorType === 'auth_error' &&
      manifestSecrets.length === 0
    ) {
      errorType = 'app_unavailable';
    }
    return {
      status: 'error',
      outputs: parsed,
      error: upstreamMessage
        ? `HTTP ${res.status}: ${upstreamMessage}`
        : `HTTP ${res.status}: ${res.statusText || 'error'}`,
      upstream_status: res.status,
      error_type: errorType,
      duration_ms,
      logs: logs.join('\n'),
    };
  } catch (err) {
    const e = err as Error;
    const duration_ms = Date.now() - start;
    logs.push(`[proxied] error: ${e.message}`);
    // Special-case missing_secrets so callers can surface a structured error.
    if (e instanceof MissingSecretsError) {
      return {
        status: 'error',
        outputs: {
          error: 'missing_secrets',
          required: e.required,
          help: e.help,
        },
        error: e.message,
        error_type: 'missing_secret',
        duration_ms,
        logs: logs.join('\n'),
      };
    }
    // Classify pre-response failures. `AbortSignal.timeout` raises a
    // DOMException with name 'TimeoutError' before any status arrives.
    // DNS / TCP / TLS failures surface as AggregateError / TypeError
    // with messages like "fetch failed" / "ENOTFOUND" / "ECONNREFUSED".
    // Neither has a status, so we route them to distinct taxonomy
    // classes the client shows as "took too long" vs. "can't reach".
    const preResponse = classifyPreResponseError(e);
    return {
      status: 'error',
      outputs: null,
      error: e.message || 'Unknown error',
      error_type: preResponse,
      duration_ms,
      logs: logs.join('\n'),
    };
  }
}

// ---------- error taxonomy helpers ----------

function classifyHttpStatus(status: number): ProxiedErrorType {
  if (status === 401 || status === 403) return 'auth_error';
  if (status >= 400 && status < 500) return 'user_input_error';
  if (status >= 500 && status < 600) return 'upstream_outage';
  return 'runtime_error';
}

function classifyPreResponseError(e: Error): ProxiedErrorType {
  const name = (e as { name?: string }).name || '';
  const msg = (e.message || '').toLowerCase();
  if (name === 'TimeoutError' || /timed? ?out|timeout|aborted/.test(msg)) {
    return 'timeout';
  }
  // node's fetch undici error shape: "fetch failed" with a nested cause
  // carrying code ENOTFOUND / ECONNREFUSED / ECONNRESET / EAI_AGAIN /
  // UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET.
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const causeCode = cause?.code || '';
  if (
    /fetch failed|enotfound|econnrefused|econnreset|eai_again|und_err_connect|und_err_socket|getaddrinfo/.test(
      msg,
    ) ||
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT/.test(causeCode)
  ) {
    return 'network_unreachable';
  }
  // Anything else thrown before we got a response: unknown runtime.
  // Leave as `runtime_error` so the UI keeps its "something broke"
  // fallback instead of claiming a network failure.
  return 'runtime_error';
}

/**
 * Extract a short, safe one-liner from the upstream response body.
 * Typical payloads: `{ "message": "..." }`, `{ "error": "..." }`,
 * `{ "detail": "..." }`, FastAPI validation arrays. We cap at 140 chars
 * so a 50KB stack trace never leaks into the headline, and we never
 * return if the field is empty / not a plain string.
 */
function extractUpstreamMessage(parsed: unknown, raw: string): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (!trimmed) return null;
    return trimmed.length > 140 ? trimmed.slice(0, 137) + '...' : trimmed;
  };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    const fromMsg = pick(p.message) || pick(p.error) || pick(p.detail);
    if (fromMsg) return fromMsg;
    // FastAPI validation: detail = [{ msg, loc, type }]
    if (Array.isArray(p.detail) && p.detail.length > 0) {
      const first = p.detail[0];
      if (first && typeof first === 'object') {
        const msg = pick((first as Record<string, unknown>).msg);
        if (msg) return msg;
      }
    }
  }
  // Last resort: surface a short snippet of the raw text if it's not
  // JSON at all (many APIs return `text/plain` error pages).
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith('<') && trimmed.length < 200) {
      return trimmed.length > 140 ? trimmed.slice(0, 137) + '...' : trimmed;
    }
  }
  return null;
}
