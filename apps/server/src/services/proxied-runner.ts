// Proxied runner: forward HTTP requests to an external API with secret injection.
// Used when app.app_type === 'proxied' (i.e. app registered via OpenAPI spec URL).
import type {
  AppRecord,
  AuthConfig,
  AuthType,
  NormalizedManifest,
  ActionSpec,
} from '../types.js';

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
}

export interface ProxiedRunResult {
  status: 'success' | 'error';
  outputs: unknown;
  error?: string;
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
    throw new Error(
      `OAuth2 token endpoint returned HTTP ${res.status}: ${await res.text()}`,
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
    const requiredSecrets = manifest.secrets_needed || [];
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
          // Multipart form body. File fields are expected to arrive as either
          // a Buffer/Blob or a base64-encoded data URL. We pass everything
          // else through as form fields.
          const form = new FormData();
          for (const [k, v] of Object.entries(bodyFieldInputs)) {
            if (k === 'body') continue; // generic textarea fallback, skip
            if (v instanceof Blob) {
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

    const fetchInit: RequestInit = {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(30_000),
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

    return {
      status: 'error',
      outputs: parsed,
      error: `HTTP ${res.status}: ${res.statusText}`,
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
        duration_ms,
        logs: logs.join('\n'),
      };
    }
    return {
      status: 'error',
      outputs: null,
      error: e.message || 'Unknown error',
      duration_ms,
      logs: logs.join('\n'),
    };
  }
}
