// OpenAPI ingest pipeline.
// Reads a YAML or JSON config file listing proxied apps, fetches their OpenAPI
// specs, generates a Floom manifest for each operation, and upserts into the
// apps table. Idempotent: re-running with the same config does not duplicate.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — json-schema-merge-allof has no types on npm
import mergeAllOf from 'json-schema-merge-allof';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { db } from '../db.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import type { NormalizedManifest, InputSpec, OutputSpec } from '../types.js';

// ---------- config schema ----------

interface OpenApiAppSpec {
  slug: string;
  type: 'proxied' | 'hosted';
  openapi_spec_url?: string;
  openapi_spec?: string;
  base_url?: string;
  auth?: 'bearer' | 'apikey' | 'basic' | 'oauth2_client_credentials' | 'none';
  /**
   * For auth: apikey — which HTTP header name carries the key.
   * Default: X-API-Key.
   */
  apikey_header?: string;
  /**
   * For auth: oauth2_client_credentials — the token endpoint URL.
   * Required when auth === 'oauth2_client_credentials'.
   */
  oauth2_token_url?: string;
  /**
   * For auth: oauth2_client_credentials — space-separated scopes.
   */
  oauth2_scopes?: string;
  secrets?: string[];
  display_name?: string;
  description?: string;
  category?: string;
  icon?: string;
  /**
   * Per-app visibility. Defaults to public.
   *  - public: anyone can run the app
   *  - auth-required: caller must present a valid bearer token matching
   *    FLOOM_AUTH_TOKEN env var (see apps/server/src/routes/*.ts)
   */
  visibility?: 'public' | 'auth-required';
  // ---------- async job queue fields (v0.3.0) ----------
  /**
   * When true, the app runs through the Floom job queue instead of the
   * synchronous /api/:slug/run endpoint. POST /api/:slug/jobs enqueues a
   * job, GET /api/:slug/jobs/:id polls its state, and a creator-declared
   * webhook_url (below) receives the completion notification.
   */
  async?: boolean;
  /**
   * POST target for job-completed webhooks. Fires when a job reaches a
   * terminal state (succeeded / failed / cancelled) with payload
   * { job_id, slug, status, output, error, duration_ms, attempts }.
   */
  webhook_url?: string;
  /**
   * Max runtime per job in milliseconds. Defaults to 30 minutes.
   */
  timeout_ms?: number;
  /**
   * Max retry attempts on job failure. Defaults to 0.
   */
  retries?: number;
  /**
   * Client contract for async apps. 'poll' (default) means clients poll
   * the job endpoint. 'webhook' means clients rely on webhook delivery.
   * 'stream' is reserved for future streaming support.
   */
  async_mode?: 'poll' | 'webhook' | 'stream';
}

interface AppsConfig {
  apps: OpenApiAppSpec[];
}

// ---------- OpenAPI types (minimal) ----------

interface OpenApiInfo {
  title?: string;
  description?: string;
  version?: string;
}

// Post-dereference JSON schema shape (all $refs inlined).
// We accept almost anything — broad typing is intentional because real-world
// specs are varied and we walk this structurally at runtime.
interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  discriminator?: { propertyName?: string; mapping?: Record<string, string> };
  nullable?: boolean;
  [key: string]: unknown;
}

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenApiRequestBodyContent {
  schema?: JsonSchema;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, OpenApiRequestBodyContent>;
  };
  responses?: Record<string, { description?: string }>;
  tags?: string[];
}

interface OpenApiPath {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiServerVariable {
  default: string;
  enum?: string[];
  description?: string;
}

interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, OpenApiServerVariable>;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string; // Swagger 2.0
  host?: string; // Swagger 2.0
  basePath?: string; // Swagger 2.0
  schemes?: string[]; // Swagger 2.0
  info?: OpenApiInfo;
  paths?: Record<string, OpenApiPath>;
  servers?: OpenApiServer[];
}

// ---------- helpers ----------

/**
 * Collapse `allOf` / `oneOf` / `anyOf` into a single flat schema where possible.
 *
 * - allOf: merge all subschemas into one via json-schema-merge-allof. This
 *   handles the composition-heavy specs (GitHub, Stripe, many generated).
 * - oneOf / anyOf: merge by unioning properties from every branch. Required
 *   fields are demoted to optional because different branches require
 *   different subsets. When a `discriminator` is present, its propertyName
 *   becomes a required enum with the branch names as options.
 *
 * This is a pragmatic flattening — it loses some precision (you can't
 * enforce "if type=X then field Y required") but it produces a single JSON
 * Schema that MCP tools can consume.
 */
function flattenComposition(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  // allOf: merge all subschemas. If it fails (incompatible schemas), fall
  // back to a pragmatic object-property merge of the subschemas that have
  // properties.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    try {
      const merged = mergeAllOf(schema, {
        resolvers: {
          defaultResolver: (compacted: unknown[]) => compacted[0],
        },
      }) as JsonSchema;
      return flattenComposition(merged);
    } catch {
      // Manual fallback: union properties from any subschemas that have them.
      const merged: JsonSchema = { ...schema, type: 'object', properties: {} };
      delete merged.allOf;
      const allRequired = new Set<string>(schema.required || []);
      for (const sub of schema.allOf) {
        const flat = flattenComposition(sub);
        if (flat.properties) {
          Object.assign(merged.properties!, flat.properties);
        }
        for (const r of flat.required || []) allRequired.add(r);
      }
      merged.required = Array.from(allRequired);
      return merged;
    }
  }

  // oneOf / anyOf: union properties. Required fields are demoted to optional
  // because different branches have different required sets. Discriminator
  // (if present) becomes a required enum.
  const variants = schema.oneOf || schema.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const merged: JsonSchema = {
      type: 'object',
      properties: {},
      description: schema.description,
    };
    const seen = new Set<string>();
    for (const sub of variants) {
      const flat = flattenComposition(sub);
      if (flat.properties) {
        for (const [k, v] of Object.entries(flat.properties)) {
          if (!seen.has(k)) {
            merged.properties![k] = v;
            seen.add(k);
          }
        }
      }
    }
    // If a discriminator is defined, surface it as a required enum listing
    // the mapping keys (or the variant indices if no mapping).
    if (schema.discriminator?.propertyName) {
      const name = schema.discriminator.propertyName;
      const options = schema.discriminator.mapping
        ? Object.keys(schema.discriminator.mapping)
        : variants
            .map((v, i) => {
              const t = flattenComposition(v);
              // Try to extract a title or type tag; otherwise fall back to index.
              return (t.type as string) || `variant_${i}`;
            });
      merged.properties![name] = {
        type: 'string',
        enum: options,
        description: `Discriminator: pick one of ${options.join(', ')}`,
      };
      merged.required = [name];
    }
    return merged;
  }

  // Recurse into nested properties for deep nested composition.
  if (schema.properties && typeof schema.properties === 'object') {
    const newProps: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      newProps[k] = flattenComposition(v);
    }
    return { ...schema, properties: newProps };
  }

  return schema;
}

function schemaToInputType(schema: JsonSchema): InputSpec['type'] {
  // Handle nullable unions like type: ["string", "null"] (OpenAPI 3.1).
  const t = Array.isArray(schema.type)
    ? schema.type.find((x) => x !== 'null') || schema.type[0]
    : schema.type;
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  if (schema.format === 'binary') return 'file';
  if (schema.format === 'date' || schema.format === 'date-time') return 'date';
  if (schema.format === 'uri' || schema.format === 'url') return 'url';
  if (t === 'object' || t === 'array') return 'textarea';
  return 'text';
}

function formatLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function openApiParamToInput(param: OpenApiParameter): InputSpec {
  const schema = flattenComposition(param.schema || {});
  const type = schemaToInputType(schema);

  return {
    name: param.name,
    label: formatLabel(param.name),
    type,
    required: param.required ?? false,
    description: param.description,
    options: type === 'enum' ? (schema.enum as string[]) : undefined,
    default: schema.default,
  };
}

/**
 * Walk a fully-dereferenced request body schema and emit Floom InputSpecs.
 * Returns [] if there are no structured properties (caller falls back to a
 * freeform textarea). For multipart/form-data, maps `format: binary` to
 * `type: file`.
 */
function bodySchemaToInputs(
  content: Record<string, OpenApiRequestBodyContent>,
  required: boolean,
): InputSpec[] {
  // Prefer application/json, then multipart, then first content type.
  const mediaType =
    content['application/json'] ||
    content['multipart/form-data'] ||
    content[Object.keys(content)[0]];

  if (!mediaType?.schema) {
    return [
      {
        name: 'body',
        label: 'Request Body',
        type: 'textarea',
        required,
        description: 'JSON request body',
      },
    ];
  }

  // Flatten allOf/oneOf/anyOf so we have a single schema with .properties.
  const schema = flattenComposition(mediaType.schema);

  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return [
      {
        name: 'body',
        label: 'Request Body',
        type: 'textarea',
        required,
        description: 'JSON request body',
      },
    ];
  }

  const required_fields = schema.required || [];
  const inputs: InputSpec[] = [];
  for (const [propName, rawProp] of Object.entries(schema.properties)) {
    const propSchema = flattenComposition(rawProp);
    const type = schemaToInputType(propSchema);

    inputs.push({
      name: propName,
      label: formatLabel(propName),
      type,
      required: required_fields.includes(propName),
      description:
        typeof propSchema.description === 'string'
          ? propSchema.description
          : undefined,
      options: type === 'enum' ? (propSchema.enum as string[]) : undefined,
      default: propSchema.default,
    });
  }
  return inputs;
}

function operationToAction(
  method: string,
  path: string,
  op: OpenApiOperation,
): { name: string; inputs: InputSpec[]; outputs: OutputSpec[]; description: string } {
  const name =
    op.operationId
      ? op.operationId.replace(/[^a-zA-Z0-9_]/g, '_')
      : `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

  const inputs: InputSpec[] = [];

  // Path, query, header, cookie parameters.
  // Header/cookie inputs are namespaced so they don't collide with body
  // field names (e.g. an `Authorization` header vs an `authorization` body
  // field). The proxied-runner reads the name prefix to route them to the
  // right transport.
  for (const param of op.parameters || []) {
    if (param.in === 'path' || param.in === 'query') {
      inputs.push(openApiParamToInput(param));
    } else if (param.in === 'header') {
      // Skip standard headers that are handled automatically.
      const headerName = param.name.toLowerCase();
      if (
        headerName === 'content-type' ||
        headerName === 'accept' ||
        headerName === 'authorization'
      ) {
        continue;
      }
      const input = openApiParamToInput(param);
      inputs.push({
        ...input,
        name: `header_${param.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        label: `${formatLabel(param.name)} (header)`,
        description: `${input.description || ''} [HTTP header]`.trim(),
      });
    } else if (param.in === 'cookie') {
      const input = openApiParamToInput(param);
      inputs.push({
        ...input,
        name: `cookie_${param.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        label: `${formatLabel(param.name)} (cookie)`,
        description: `${input.description || ''} [HTTP cookie]`.trim(),
      });
    }
  }

  // Request body (POST/PUT/PATCH)
  if (op.requestBody?.content) {
    const bodyInputs = bodySchemaToInputs(
      op.requestBody.content,
      op.requestBody.required ?? false,
    );
    inputs.push(...bodyInputs);
  }

  // If no inputs at all, add a generic freeform field
  if (inputs.length === 0) {
    inputs.push({
      name: 'freeform',
      label: 'Parameters',
      type: 'text',
      required: false,
      description: 'Optional query parameters (key=value pairs, comma-separated)',
    });
  }

  const outputs: OutputSpec[] = [
    {
      name: 'response',
      label: 'Response',
      type: 'json',
      description: 'API response',
    },
  ];

  return {
    name,
    inputs,
    outputs,
    description: op.summary || op.description || `${method.toUpperCase()} ${path}`,
  };
}

/**
 * Resolve the effective base URL for a spec. Priority:
 *   1. appSpec.base_url (explicit override in apps.yaml) — wins if set
 *   2. spec.servers[0].url (OpenAPI 3.x) with variable substitution,
 *      resolving spec-relative server URLs against the spec fetch URL
 *   3. Swagger 2.0 host + basePath + schemes[0]
 *   4. Spec fetch URL origin (last-resort: better than null for server-less specs)
 *   5. null if nothing found
 *
 * Variable substitution uses {var} placeholders from spec.servers[0].variables.
 */
export function resolveBaseUrl(
  spec: OpenApiSpec,
  appSpec: OpenApiAppSpec,
  specFetchUrl?: string,
): string | null {
  // 1. Explicit override wins.
  if (appSpec.base_url) {
    return appSpec.base_url;
  }

  // 2. OpenAPI 3.x servers[]
  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    const server = spec.servers[0];
    let url = server.url;
    if (server.variables) {
      // Replace {varName} with its default value.
      for (const [name, variable] of Object.entries(server.variables)) {
        const value = variable.default ?? '';
        url = url.replace(new RegExp(`\\{${name}\\}`, 'g'), value);
      }
    }
    // If the URL is absolute, return as-is.
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    // Handle spec-relative server URLs. Per OpenAPI 3.x, a server URL that
    // doesn't start with a scheme is relative to the spec's fetch URL.
    // Petstore uses this: servers: [{ url: "/api/v3" }]
    if (specFetchUrl) {
      try {
        const fetchUrl = new URL(specFetchUrl);
        if (url.startsWith('/')) {
          // Absolute path relative to fetch URL origin.
          return `${fetchUrl.origin}${url.replace(/\/+$/, '')}`;
        }
        // Relative path: resolve against the fetch URL directory.
        return new URL(url, fetchUrl).toString().replace(/\/+$/, '');
      } catch {
        // fall through
      }
    }
    // Relative URL with no fetch context — can't resolve.
    return null;
  }

  // 3. Swagger 2.0 host + basePath
  if (spec.host) {
    const scheme =
      (Array.isArray(spec.schemes) && spec.schemes[0]) || 'https';
    const basePath = spec.basePath || '';
    return `${scheme}://${spec.host}${basePath}`;
  }

  // 4. Last-resort: origin of the spec fetch URL (the API probably serves
  // under the same origin the spec lives on).
  if (specFetchUrl) {
    try {
      return new URL(specFetchUrl).origin;
    } catch {
      // fall through
    }
  }

  return null;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Read the max actions cap from the FLOOM_MAX_ACTIONS_PER_APP env var.
 * Defaults to 200. Set to 0 for unlimited (useful for Stripe, GitHub, etc).
 */
function getMaxActionsCap(): number {
  const raw = process.env.FLOOM_MAX_ACTIONS_PER_APP;
  if (raw === undefined || raw === '') return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 200;
  return Math.floor(n); // 0 = unlimited
}

function specToManifest(
  spec: OpenApiSpec,
  appSpec: OpenApiAppSpec,
  secretNames: string[],
): NormalizedManifest {
  const actions: NormalizedManifest['actions'] = {};
  const maxActions = getMaxActionsCap(); // 0 = unlimited
  let count = 0;
  let truncatedAt: number | null = null;

  outer: for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof OpenApiPath] as OpenApiOperation | undefined;
      if (!op) continue;
      if (maxActions > 0 && count >= maxActions) {
        truncatedAt = count;
        break outer;
      }
      const action = operationToAction(method, path, op);
      // Avoid collision: if we already used this name, append _2, _3, ...
      let name = action.name;
      let suffix = 2;
      while (actions[name]) {
        name = `${action.name}_${suffix++}`;
      }
      actions[name] = {
        label: action.description,
        description: action.description,
        inputs: action.inputs,
        outputs: action.outputs,
      };
      count++;
    }
  }

  if (truncatedAt !== null) {
    // Count the total operations in the spec so the warning is actionable.
    let total = 0;
    for (const pathItem of Object.values(spec.paths || {})) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method as keyof OpenApiPath]) total++;
      }
    }
    console.warn(
      `[openapi-ingest] ${appSpec.slug}: truncated at ${truncatedAt} actions (spec has ${total}). Raise FLOOM_MAX_ACTIONS_PER_APP to ${total} or 0 for unlimited.`,
    );
  }

  // If no paths were parsed, add a single generic action
  if (Object.keys(actions).length === 0) {
    actions['call'] = {
      label: 'Call API',
      description: `Call the ${appSpec.display_name || appSpec.slug} API`,
      inputs: [
        {
          name: 'path',
          label: 'Path',
          type: 'text',
          required: true,
          description: 'API path (e.g. /v1/endpoint)',
        },
        {
          name: 'body',
          label: 'Body',
          type: 'textarea',
          required: false,
          description: 'JSON request body',
        },
      ],
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    };
  }

  return {
    name: appSpec.display_name || spec.info?.title || appSpec.slug,
    description:
      appSpec.description ||
      spec.info?.description ||
      `${appSpec.display_name || appSpec.slug} API`,
    actions,
    runtime: 'python', // proxied apps don't run python but the field is required
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: secretNames,
    manifest_version: '2.0',
  };
}

async function fetchSpec(url: string): Promise<OpenApiSpec> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json, application/yaml, text/plain' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  // Try JSON first, fall back to YAML
  try {
    return JSON.parse(text) as OpenApiSpec;
  } catch {
    return parseYaml(text) as OpenApiSpec;
  }
}

/**
 * Dereference all $refs in the spec. Uses @apidevtools/json-schema-ref-parser
 * with circular-ref support ('ignore' mode — cyclic refs become $ref objects
 * that we leave alone, rather than throwing).
 *
 * On failure we return the original spec (callers see a degraded manifest but
 * nothing crashes).
 */
export async function dereferenceSpec(spec: OpenApiSpec): Promise<OpenApiSpec> {
  try {
    // Deep clone so we don't mutate the cached original.
    const clone = JSON.parse(JSON.stringify(spec));
    const derefed = await $RefParser.dereference(clone, {
      dereference: { circular: 'ignore' },
    });
    return derefed as unknown as OpenApiSpec;
  } catch (err) {
    console.warn(
      `[openapi-ingest] $ref dereference failed: ${(err as Error).message}. Using raw spec.`,
    );
    return spec;
  }
}

// ---------- public API ----------

export interface IngestResult {
  apps_ingested: number;
  apps_failed: number;
  errors: Array<{ slug: string; error: string }>;
}

export async function ingestOpenApiApps(configPath: string): Promise<IngestResult> {
  const raw = readFileSync(configPath, 'utf-8');
  let config: AppsConfig;
  if (configPath.endsWith('.json')) {
    config = JSON.parse(raw) as AppsConfig;
  } else {
    config = parseYaml(raw) as AppsConfig;
  }

  if (!Array.isArray(config?.apps)) {
    console.warn('[openapi-ingest] config has no apps array — skipping');
    return { apps_ingested: 0, apps_failed: 0, errors: [] };
  }

  console.log(`[openapi-ingest] processing ${config.apps.length} apps from ${configPath}`);

  const existsBySlug = db.prepare('SELECT id FROM apps WHERE slug = ?');
  const insertApp = db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon, app_type, base_url, auth_type, auth_config, openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url, timeout_ms, retries, async_mode)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, 'proxied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateApp = db.prepare(
    `UPDATE apps SET name=?, description=?, manifest=?, category=?, app_type='proxied', base_url=?, auth_type=?, auth_config=?, openapi_spec_url=?, openapi_spec_cached=?, visibility=?, is_async=?, webhook_url=?, timeout_ms=?, retries=?, async_mode=?, updated_at=datetime('now') WHERE slug=?`,
  );
  const insertSecret = db.prepare(
    `INSERT OR IGNORE INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)`,
  );

  let apps_ingested = 0;
  let apps_failed = 0;
  const errors: Array<{ slug: string; error: string }> = [];

  for (const appSpec of config.apps) {
    try {
      if (!appSpec.slug) {
        throw new Error('app entry is missing required "slug" field');
      }

      // Fetch the OpenAPI spec
      let spec: OpenApiSpec = { paths: {} };
      if (appSpec.openapi_spec_url) {
        console.log(`[openapi-ingest] fetching spec for ${appSpec.slug}: ${appSpec.openapi_spec_url}`);
        try {
          spec = await fetchSpec(appSpec.openapi_spec_url);
        } catch (err) {
          console.warn(
            `[openapi-ingest] could not fetch spec for ${appSpec.slug}: ${(err as Error).message}. Using empty spec.`,
          );
        }
      }

      // Resolve all $refs so downstream walkers see inlined schemas.
      // Cyclic refs (Stripe has some) are left in place rather than throwing.
      const derefedSpec = await dereferenceSpec(spec);

      const secretNames = appSpec.secrets || [];
      const manifest = specToManifest(derefedSpec, appSpec, secretNames);
      // Cache the dereferenced spec so the proxied-runner operates on the
      // same shape (path params, query params, request body, response schema)
      // that the manifest declared. This also lets the runner walk request
      // bodies without resolving refs itself.
      const specCached = JSON.stringify(derefedSpec);

      // Resolve the effective base URL. appSpec.base_url wins, otherwise
      // we read spec.servers[] (OpenAPI 3.x) with spec-relative URL support,
      // or spec.host + basePath (Swagger 2), or the spec fetch URL origin.
      const resolvedBaseUrl = resolveBaseUrl(
        derefedSpec,
        appSpec,
        appSpec.openapi_spec_url,
      );
      if (!resolvedBaseUrl) {
        console.warn(
          `[openapi-ingest] ${appSpec.slug}: no base_url resolved (neither apps.yaml override nor spec.servers[]). Runtime calls will fail.`,
        );
      } else if (!appSpec.base_url) {
        console.log(
          `[openapi-ingest] ${appSpec.slug}: auto-resolved base_url = ${resolvedBaseUrl} (from spec.servers[])`,
        );
      }

      const existing = existsBySlug.get(appSpec.slug) as { id: string } | undefined;

      // Build auth_config blob from the apps.yaml entry.
      const authConfig: Record<string, string> = {};
      if (appSpec.apikey_header) authConfig.apikey_header = appSpec.apikey_header;
      if (appSpec.oauth2_token_url)
        authConfig.oauth2_token_url = appSpec.oauth2_token_url;
      if (appSpec.oauth2_scopes) authConfig.oauth2_scopes = appSpec.oauth2_scopes;
      const authConfigJson =
        Object.keys(authConfig).length > 0 ? JSON.stringify(authConfig) : null;
      const visibility = appSpec.visibility || 'public';
      // v0.3.0 async fields
      const isAsync = appSpec.async === true ? 1 : 0;
      const webhookUrl = appSpec.webhook_url || null;
      const timeoutMs =
        typeof appSpec.timeout_ms === 'number' && appSpec.timeout_ms > 0
          ? appSpec.timeout_ms
          : null;
      const retries =
        typeof appSpec.retries === 'number' && appSpec.retries >= 0
          ? appSpec.retries
          : 0;
      const asyncMode = appSpec.async_mode || (isAsync ? 'poll' : null);

      if (existing) {
        updateApp.run(
          manifest.name,
          appSpec.description || manifest.description,
          JSON.stringify(manifest),
          appSpec.category || null,
          resolvedBaseUrl || null,
          appSpec.auth || null,
          authConfigJson,
          appSpec.openapi_spec_url || null,
          specCached,
          visibility,
          isAsync,
          webhookUrl,
          timeoutMs,
          retries,
          asyncMode,
          appSpec.slug,
        );
        // Insert placeholder secrets if not already present (so the UI shows them)
        for (const name of secretNames) {
          insertSecret.run(newSecretId(), name, '', existing.id);
        }
        console.log(`[openapi-ingest] updated ${appSpec.slug}`);
      } else {
        const appId = newAppId();
        insertApp.run(
          appId,
          appSpec.slug,
          manifest.name,
          appSpec.description || manifest.description,
          JSON.stringify(manifest),
          `proxied:${appSpec.slug}`,
          appSpec.category || null,
          appSpec.icon || null,
          resolvedBaseUrl || null,
          appSpec.auth || null,
          authConfigJson,
          appSpec.openapi_spec_url || null,
          specCached,
          visibility,
          isAsync,
          webhookUrl,
          timeoutMs,
          retries,
          asyncMode,
        );
        // Insert placeholder secrets
        for (const name of secretNames) {
          insertSecret.run(newSecretId(), name, '', appId);
        }
        console.log(`[openapi-ingest] inserted ${appSpec.slug}`);
      }

      apps_ingested++;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[openapi-ingest] failed ${appSpec.slug}: ${msg}`);
      errors.push({ slug: appSpec.slug, error: msg });
      apps_failed++;
    }
  }

  console.log(
    `[openapi-ingest] done: ${apps_ingested} ingested, ${apps_failed} failed`,
  );
  return { apps_ingested, apps_failed, errors };
}
