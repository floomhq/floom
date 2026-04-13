// Proxied runner: forward HTTP requests to an external API with secret injection.
// Used when app.app_type === 'proxied' (i.e. app registered via OpenAPI spec URL).
import type { AppRecord, NormalizedManifest, ActionSpec } from '../types.js';

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

// ---------- helpers ----------

/**
 * Given the cached OpenAPI spec and the action name, find the matching
 * operation (path + method) so we can build the correct URL.
 */
interface OperationInfo {
  method: string;
  path: string;
  paramNames: { name: string; in: 'path' | 'query' | 'body' }[];
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
            requestBody?: unknown;
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
        if (param.in === 'path' || param.in === 'query') {
          paramNames.push({ name: param.name, in: param.in as 'path' | 'query' });
        }
      }
      if (op.requestBody) {
        paramNames.push({ name: 'body', in: 'body' });
      }

      return { method, path, paramNames };
    }
  }
  return null;
}

function buildUrl(
  baseUrl: string,
  path: string,
  inputs: Record<string, unknown>,
  pathParams: string[],
  queryParams: string[],
): string {
  let resolvedPath = path;
  for (const name of pathParams) {
    resolvedPath = resolvedPath.replace(`{${name}}`, encodeURIComponent(String(inputs[name] ?? '')));
  }
  const url = new URL(resolvedPath, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  for (const name of queryParams) {
    if (inputs[name] !== undefined && inputs[name] !== null && inputs[name] !== '') {
      url.searchParams.set(name, String(inputs[name]));
    }
  }
  return url.toString();
}

function buildAuthHeaders(
  authType: string | null,
  secrets: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authType === 'bearer') {
    // Find first secret value that looks like an API key
    const tokenValue = Object.values(secrets).find((v) => v && v.length > 0);
    if (tokenValue) {
      headers['Authorization'] = `Bearer ${tokenValue}`;
    }
  } else if (authType === 'apikey') {
    const keyValue = Object.values(secrets).find((v) => v && v.length > 0);
    if (keyValue) {
      headers['X-API-Key'] = keyValue;
    }
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

    const opInfo = findOperation(spec, action);
    logs.push(`[proxied] ${app.slug}/${action} → ${opInfo ? `${opInfo.method.toUpperCase()} ${opInfo.path}` : 'POST /'}`);

    let method = 'GET';
    let url: string;
    let body: string | undefined;

    if (opInfo) {
      const pathParamNames = opInfo.paramNames
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      const queryParamNames = opInfo.paramNames
        .filter((p) => p.in === 'query')
        .map((p) => p.name);

      method = opInfo.method.toUpperCase();
      url = buildUrl(app.base_url, opInfo.path, inputs, pathParamNames, queryParamNames);

      // Build body for POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        const bodyInput = inputs['body'];
        if (typeof bodyInput === 'string') {
          // Freeform body — try to parse as JSON, else send as-is
          try {
            body = JSON.stringify(JSON.parse(bodyInput));
          } catch {
            body = bodyInput;
          }
        } else {
          // Collect body-intended fields (all non-path, non-query inputs)
          const nonParamInputs: Record<string, unknown> = {};
          const paramSet = new Set([...pathParamNames, ...queryParamNames]);
          for (const [k, v] of Object.entries(inputs)) {
            if (!paramSet.has(k) && v !== undefined && v !== null && v !== '') {
              nonParamInputs[k] = v;
            }
          }
          if (Object.keys(nonParamInputs).length > 0) {
            body = JSON.stringify(nonParamInputs);
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

    const authHeaders = buildAuthHeaders(app.auth_type, secrets);
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders,
    };

    const fetchInit: RequestInit = {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(30_000),
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchInit.body = body;
    }

    const res = await fetch(url, fetchInit);
    const responseText = await res.text();
    logs.push(`[proxied] HTTP ${res.status} (${Date.now() - start}ms)`);

    let parsed: unknown = responseText;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // leave as text
    }

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
    return {
      status: 'error',
      outputs: null,
      error: e.message || 'Unknown error',
      duration_ms,
      logs: logs.join('\n'),
    };
  }
}
