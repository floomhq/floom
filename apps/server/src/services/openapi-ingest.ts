// OpenAPI ingest pipeline.
// Reads a YAML or JSON config file listing proxied apps, fetches their OpenAPI
// specs, generates a Floom manifest for each operation, and upserts into the
// apps table. Idempotent: re-running with the same config does not duplicate.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import * as dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — json-schema-merge-allof has no types on npm
import mergeAllOf from 'json-schema-merge-allof';
import $RefParser from '@apidevtools/json-schema-ref-parser';
// Runtime helper lives in a server-local copy (src/lib/renderer-manifest.ts)
// so the compiled production image does not need to resolve
// `@floom/renderer/contract` at runtime (it ships .ts source only). Types
// still come from the shared contract — erased at compile time.
import { parseRendererManifest } from '../lib/renderer-manifest.js';
import type { RendererManifest } from '@floom/renderer/contract';
import { db } from '../db.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import { bundleRendererFromManifest } from './renderer-bundler.js';
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
   *  - public: anyone can run the app, listed in /api/hub
   *  - auth-required: caller must present a valid bearer token matching
   *    FLOOM_AUTH_TOKEN env var (see apps/server/src/routes/*.ts)
   *  - private: only the app's author can run/see it. Never listed in
   *    the public directory; accessible via /api/hub/mine.
   */
  visibility?: 'public' | 'auth-required' | 'private';
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
  /**
   * Optional free-text reason this app is blocked and cannot be run by
   * self-hosters. Surfaced in /api/hub and rendered as a warning pill on
   * the store card. Used to mark apps like `flyfast` as "hosted-mode only
   * pending internal infra". Setting this does NOT hide the app from the
   * hub; it just annotates it.
   */
  blocked_reason?: string;
  // ---------- custom renderer fields (v0.3.1 W2.2) ----------
  /**
   * Custom renderer declaration. When present, the server compiles the
   * creator's TSX entry into an ESM bundle at ingest time and serves it
   * at `GET /renderer/:slug/bundle.js`. The web client lazy-loads the
   * bundle when the app is run and falls back to the default renderer
   * if the component crashes.
   *
   *   renderer:
   *     kind: component          # or "default" (skip compilation)
   *     entry: ./renderer.tsx    # path relative to this manifest
   *     output_shape: table      # optional pin — used as the crash fallback
   */
  renderer?: unknown;
  /**
   * v16 renderer cascade (Layer 2): optional stock library component
   * hint. Surfaces on the generated manifest under `render` so the web
   * client can pick from the output library (TextBig / CodeBlock /
   * Markdown / FileDownload) without shipping a custom bundle. Extra
   * keys pass through; see apps/web/src/components/output/.
   */
  render?: { output_component?: string; [key: string]: unknown };
  /**
   * Per-input label overrides. Keys are input names (as they appear in the
   * OpenAPI body schema), values replace the auto-generated label from
   * formatLabel(). Lets apps.yaml rename UI-visible labels without
   * changing input keys, e.g. { version: "UUID format" } so the uuid app
   * reads "UUID format" in the form while still submitting `version: "v4"`.
   */
  input_labels?: Record<string, string>;
}

interface AppsConfig {
  apps: OpenApiAppSpec[];
}

// ---------- OpenAPI types (minimal) ----------

interface OpenApiInfo {
  title?: string;
  description?: string;
  version?: string;
  license?: { name?: string; url?: string } | string;
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

/**
 * An OpenAPI security requirement object: a map from security scheme name
 * to the list of scopes required. Multiple entries at the same level are
 * AND-combined within one object; multiple objects in a `security` array
 * are alternatives (OR-combined). An empty array `security: []` on an
 * operation explicitly means "no security required for this operation"
 * and overrides the global `security` setting (OpenAPI 3.x §4.8.10).
 */
type OpenApiSecurityRequirement = Record<string, string[]>;

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
  /**
   * Operation-level security override. When present (even as an empty
   * array), it REPLACES the global spec.security for this operation.
   * See `deriveSecretsFromSpec` for how this is flattened into
   * manifest.secrets_needed.
   */
  security?: OpenApiSecurityRequirement[];
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
  /**
   * Global security requirements. Applies to every operation that does
   * not define its own `security` field. An operation-level `security`
   * (including an empty array) REPLACES this for that operation.
   */
  security?: OpenApiSecurityRequirement[];
  components?: {
    securitySchemes?: Record<
      string,
      {
        type?: string;
        scheme?: string;
        name?: string;
        in?: string;
        description?: string;
      }
    >;
  };
  /**
   * Swagger 2.0 security definitions (predecessor of
   * OpenAPI 3.x `components.securitySchemes`). Same shape minus the
   * `http` + `scheme` split — Swagger 2 uses `type: 'basic'` instead of
   * `type: 'http', scheme: 'basic'`, and has no bearer equivalent. We
   * merge both worlds in `collectSecuritySchemes` so downstream lookup
   * paths can stay OpenAPI-3-shaped.
   */
  securityDefinitions?: Record<
    string,
    {
      type?: string;
      name?: string;
      in?: string;
      description?: string;
      flow?: string; // swagger 2 oauth2
    }
  >;
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
 * Lower score = earlier in manifest key order (drives MCP tool order + "How it works").
 * Deprioritizes boilerplate health/readiness endpoints so POST /jobs etc. surface first.
 */
export function operationSortScore(
  method: string,
  path: string,
  op: OpenApiOperation,
): number {
  const p = path.replace(/\/$/, '') || '/';
  const m = method.toLowerCase();
  let score = 0;
  if (p === '/' || p === '/health') score += 10_000;
  const blob = `${op.summary || ''} ${op.description || ''}`.toLowerCase();
  if (blob.includes('health check') || blob.trim() === 'health') score += 5_000;
  const methodRank: Record<string, number> = {
    post: 0,
    put: 2,
    patch: 2,
    delete: 3,
    get: 8,
  };
  score += methodRank[m] ?? 5;
  return score;
}

function licenseNameFromSpec(spec: { info?: OpenApiInfo }): string | undefined {
  const lic = spec.info?.license;
  if (!lic) return undefined;
  if (typeof lic === 'string') return lic;
  if (typeof lic === 'object' && lic && typeof lic.name === 'string' && lic.name.trim()) {
    return lic.name.trim();
  }
  return undefined;
}

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

export function specToManifest(
  spec: OpenApiSpec,
  appSpec: OpenApiAppSpec,
  secretNames: string[],
): NormalizedManifest {
  const actions: NormalizedManifest['actions'] = {};
  const maxActions = getMaxActionsCap(); // 0 = unlimited
  let count = 0;
  let truncatedAt: number | null = null;

  type OpIter = {
    method: (typeof HTTP_METHODS)[number];
    path: string;
    pathItem: OpenApiPath;
    op: OpenApiOperation;
  };
  const opList: OpIter[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof OpenApiPath] as OpenApiOperation | undefined;
      if (!op) continue;
      opList.push({ method, path, pathItem, op });
    }
  }
  opList.sort((a, b) => {
    const da = operationSortScore(a.method, a.path, a.op);
    const db = operationSortScore(b.method, b.path, b.op);
    if (da !== db) return da - db;
    const ka = `${a.method} ${a.path}`;
    const kb = `${b.method} ${b.path}`;
    return ka.localeCompare(kb);
  });

  outer: for (const { method, path, op } of opList) {
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
    // Per-op strict secret requirements: operation-level `security`
    // overrides global, alternatives are OR-combined (see
    // requiredSecretsForOperation). This lets the proxied-runner
    // block an action only when THAT action's required secrets are
    // missing, unblocking public operations on specs like petstore
    // where `getInventory` strictly requires api_key but most other
    // operations do not. Fix for INGEST-SECRETS-GLOBAL.
    const opSecrets = requiredSecretsForOperation(spec, op);
    const label =
      (op.summary && op.summary.trim()) || action.description;
    // Apply creator-declared per-input label overrides. Keys match input
    // `name` (e.g. `version`); values replace the formatLabel() default.
    // Used by fast-apps apps.yaml to rename the uuid app's "Version"
    // selector to "UUID format" without changing the body key.
    const labelOverrides = appSpec.input_labels;
    const labeledInputs = labelOverrides
      ? action.inputs.map((inp) =>
          labelOverrides[inp.name]
            ? { ...inp, label: labelOverrides[inp.name] }
            : inp,
        )
      : action.inputs;

    // Regex-based auth lifter. For specs that don't declare a security
    // scheme (or declare one but forget to reference it at the op level),
    // any parameter whose name smells like a credential is promoted into
    // `secrets_needed` and removed from the public `inputs` list. This
    // keeps the run form from rendering plaintext textboxes for API keys
    // that get logged and stored un-scoped.
    const liftedSecrets: string[] = [];
    const remainingInputs: InputSpec[] = [];
    for (const inp of labeledInputs) {
      if (inputNameLooksLikeAuth(inp.name)) {
        // Normalize to the bare credential name (`X-API-Key` instead of
        // `header_X-API-Key`) so proxied-runner injection matches by key.
        const bare = inp.name.replace(/^(header|cookie)_/i, '');
        liftedSecrets.push(bare);
      } else {
        remainingInputs.push(inp);
      }
    }

    // Union per-op scheme-derived secrets with regex-lifted ones, deduped
    // and stable-ordered (scheme-derived first).
    const mergedSecrets: string[] = [];
    const seenSecret = new Set<string>();
    for (const key of [...opSecrets, ...liftedSecrets]) {
      if (!key || seenSecret.has(key)) continue;
      seenSecret.add(key);
      mergedSecrets.push(key);
    }

    actions[name] = {
      label,
      description: action.description,
      inputs: remainingInputs,
      outputs: action.outputs,
      secrets_needed: mergedSecrets,
    };
    count++;
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

  const license = licenseNameFromSpec(spec);

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
    ...(appSpec.blocked_reason ? { blocked_reason: appSpec.blocked_reason } : {}),
    ...(license ? { license } : {}),
    ...(appSpec.render ? { render: appSpec.render } : {}),
  };
}

interface FetchSpecOptions {
  allowPrivateNetwork?: boolean;
  redirectsRemaining?: number;
}

// SSRF hardening (issue #378, pentest 2026-04-22).
//
// Block every CIDR that could resolve to internal infra from a public caller:
//   - IPv4 loopback 127.0.0.0/8
//   - IPv4 "this host" 0.0.0.0/8 (pentest bypass: plain 0.0.0.0 was NOT in
//     the old string blocklist; on Linux it binds loopback and returned
//     "fetch failed" instead of a 403)
//   - IPv4 link-local 169.254.0.0/16 (covers AWS/GCP 169.254.169.254 metadata)
//   - IPv4 RFC1918 private 10/8, 172.16/12, 192.168/16
//   - IPv4 CGNAT 100.64.0.0/10 (some infra uses it, e.g. Tailscale)
//   - IPv4 multicast / broadcast
//   - IPv6 loopback ::1/128
//   - IPv6 unique-local fc00::/7 (covers fc00 + fd00)
//   - IPv6 link-local fe80::/10
//   - IPv6 unspecified ::/128
//   - IPv6 IPv4-mapped ::ffff:0:0/96 (e.g. ::ffff:127.0.0.1)
const SSRF_BLOCK_LIST = (() => {
  const bl = new BlockList();
  bl.addSubnet('127.0.0.0', 8, 'ipv4');
  bl.addSubnet('0.0.0.0', 8, 'ipv4');
  bl.addSubnet('169.254.0.0', 16, 'ipv4');
  bl.addSubnet('10.0.0.0', 8, 'ipv4');
  bl.addSubnet('172.16.0.0', 12, 'ipv4');
  bl.addSubnet('192.168.0.0', 16, 'ipv4');
  bl.addSubnet('100.64.0.0', 10, 'ipv4');
  bl.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
  bl.addAddress('255.255.255.255', 'ipv4'); // broadcast
  bl.addAddress('::1', 'ipv6');
  bl.addAddress('::', 'ipv6');
  bl.addSubnet('fc00::', 7, 'ipv6');
  bl.addSubnet('fe80::', 10, 'ipv6');
  bl.addSubnet('::ffff:0:0', 96, 'ipv6'); // v4-mapped v6
  return bl;
})();

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // non-IP string: treat as unsafe
  return SSRF_BLOCK_LIST.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

async function isSafeUrl(
  urlString: string,
  options: FetchSpecOptions = {},
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  // Only http(s). Reject file:, gopher:, data:, ftp:, dict:, ws(s):, etc.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname) return false;

  // Trusted operator-controlled callers (e.g. apps.yaml ingest for local
  // sidecars) can opt out; never honor this flag for user-supplied URLs.
  if (options.allowPrivateNetwork) return true;

  // Reject localhost string variants upfront. DNS lookup of "localhost" on
  // most systems returns 127.0.0.1 anyway, but some resolvers can be
  // re-pointed (e.g. /etc/hosts rewrites), so we don't rely on DNS alone.
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === 'ip6-localhost' || host.endsWith('.localhost')) {
    return false;
  }

  // If the hostname is literally an IP, check it directly (no DNS).
  // URL parsing strips IPv6 brackets, so `isIP` sees the raw address.
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    return !isBlockedIp(host);
  }

  // Hostname is a name — resolve to every A/AAAA record and reject if ANY
  // resolved IP is in the blocklist. This defeats DNS rebinding at ingest
  // time (we only fetch once here, so TOCTOU against rebind is low risk).
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.length === 0) return false;
    for (const record of records) {
      if (isBlockedIp(record.address)) return false;
    }
  } catch {
    return false; // DNS failed — fail closed
  }
  return true;
}

// Response size + timeout caps for the spec fetch. OpenAPI specs are JSON/YAML
// text; 5 MB is ~10x the size of the Stripe OpenAPI spec and leaves headroom
// for large enterprise specs. Anything larger is almost certainly either a
// mistake (wrong URL) or an attempt to exhaust memory.
const MAX_SPEC_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_TIMEOUT_MS = 10_000; // 10 s
const TRUSTED_FETCH_TIMEOUT_MS = 30_000; // operator-controlled apps.yaml

export async function fetchSpec(
  url: string,
  options: FetchSpecOptions = {},
): Promise<OpenApiSpec> {
  if (!(await isSafeUrl(url, options))) {
    throw new Error(`Invalid or disallowed OpenAPI URL: ${url}`);
  }
  const redirectsRemaining = options.redirectsRemaining ?? 3;
  const timeoutMs = options.allowPrivateNetwork
    ? TRUSTED_FETCH_TIMEOUT_MS
    : FETCH_TIMEOUT_MS;
  const res = await fetch(url, {
    headers: { Accept: 'application/json, application/yaml, text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    if (redirectsRemaining <= 0) {
      throw new Error(`Too many redirects while fetching OpenAPI spec from ${url}`);
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new Error(`Redirected OpenAPI spec from ${url} without a location header`);
    }
    const nextUrl = new URL(location, url).toString();
    if (!(await isSafeUrl(nextUrl, options))) {
      throw new Error(`Invalid or disallowed OpenAPI redirect target: ${nextUrl}`);
    }
    return fetchSpec(nextUrl, {
      ...options,
      redirectsRemaining: redirectsRemaining - 1,
    });
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${url}: HTTP ${res.status}`);
  }

  // Enforce a response-size cap. Content-Length is advisory (servers can
  // omit or lie), so we also count bytes as they stream in and abort when
  // the cap is exceeded. Unbounded res.text() would let a malicious or
  // confused endpoint OOM the server.
  const declared = Number(res.headers.get('content-length') || '0');
  if (declared > MAX_SPEC_BYTES) {
    throw new Error(
      `OpenAPI spec at ${url} exceeds ${MAX_SPEC_BYTES} bytes (content-length=${declared})`,
    );
  }

  const body = res.body;
  let text: string;
  if (!body) {
    text = await res.text();
    if (Buffer.byteLength(text, 'utf-8') > MAX_SPEC_BYTES) {
      throw new Error(`OpenAPI spec at ${url} exceeds ${MAX_SPEC_BYTES} bytes`);
    }
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_SPEC_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`OpenAPI spec at ${url} exceeds ${MAX_SPEC_BYTES} bytes`);
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
  }
  // Try JSON first, fall back to YAML
  try {
    return JSON.parse(text) as OpenApiSpec;
  } catch (jsonErr) {
    try {
      return parseYaml(text) as OpenApiSpec;
    } catch (yamlErr) {
      throw new Error(`Failed to parse spec from ${url} as JSON or YAML: ${(yamlErr as Error).message}`);
    }
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
      resolve: { external: false },
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

  // Custom renderers declare paths relative to the manifest file (apps.yaml).
  // Resolve manifestDir once here so bundleRendererFromManifest can sandbox
  // each creator's entry to files inside the same directory.
  const manifestDir = dirname(isAbsolute(configPath) ? configPath : resolvePath(configPath));

  const existsBySlug = db.prepare('SELECT id FROM apps WHERE slug = ?');
  // Operator-declared apps (FLOOM_APPS_CONFIG) skip the publish-review gate —
  // the operator explicitly listed them in apps.yaml, no admin approval
  // needed. They land as 'published'. User-driven ingest (Studio /build,
  // MCP ingest_app) routes through ingestAppFromSpec instead, which
  // applies the 'pending_review' default.
  const insertApp = db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon, app_type, base_url, auth_type, auth_config, openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url, timeout_ms, retries, async_mode, publish_status)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, 'proxied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
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
          spec = await fetchSpec(appSpec.openapi_spec_url, {
            allowPrivateNetwork: true,
          });
        } catch (err) {
          console.warn(
            `[openapi-ingest] could not fetch spec for ${appSpec.slug}: ${(err as Error).message}. Skipping ingest for this app.`,
          );
          errors.push({ slug: appSpec.slug, error: (err as Error).message });
          apps_failed++;
          continue; // Skip inserting an empty manifest
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

      // Parse + compile custom renderer if declared. We parse first (pure,
      // may throw with a clear error) and then bundle (side-effecting,
      // catches errors internally and returns null). The bundle is not
      // persisted in the DB because db.ts is locked this sprint; the
      // in-memory bundle index + the on-disk sidecar files are the source
      // of truth for the /renderer/:slug route.
      let rendererManifest: RendererManifest = { kind: 'default' };
      try {
        rendererManifest = parseRendererManifest(appSpec.renderer);
      } catch (err) {
        console.warn(
          `[openapi-ingest] ${appSpec.slug}: invalid renderer manifest: ${(err as Error).message}`,
        );
        rendererManifest = { kind: 'default' };
      }
      if (rendererManifest.kind === 'component' && rendererManifest.entry) {
        // fire-and-forget: the bundler logs its own result. Ingest continues
        // on failure so one broken renderer doesn't block the rest of the
        // hub.
        void bundleRendererFromManifest(
          appSpec.slug,
          manifestDir,
          rendererManifest.entry,
          rendererManifest.output_shape,
        );
      }

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

// =====================================================================
// W4-minimal: in-memory ingest for /api/hub/ingest
// =====================================================================

/**
 * Shape returned to the /build UI when a user submits an OpenAPI URL.
 * The UI renders the detected values into an editable form, then POSTs
 * the finalized manifest back via a second call.
 */
export interface DetectedApp {
  slug: string;
  name: string;
  description: string;
  actions: Array<{ name: string; label: string; description?: string }>;
  auth_type: string | null;
  category: string | null;
  openapi_spec_url: string;
  tools_count: number;
  secrets_needed: string[];
}

/**
 * Slug-ify a string into a URL-safe app slug. Used when the caller does
 * not provide a slug for /api/hub/ingest.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

/**
 * Thrown by `ingestAppFromSpec` when the requested slug is already owned
 * by a different workspace. Carries three recovery suggestions that the
 * UI renders as clickable pills so the creator can publish with one
 * click instead of hitting a dead-end (audit 2026-04-20, Fix 2).
 *
 *   - numeric suffix (`petstore-2`, `petstore-3`)
 *   - version suffix (`petstore-v2`)
 *   - random short suffix (`petstore-8f3a2b1c`)
 *
 * Generator skips any suffix variant that is itself taken, so all three
 * pills resolve cleanly in 99%+ of cases.
 */
export class SlugTakenError extends Error {
  code = 'slug_taken' as const;
  slug: string;
  suggestions: string[];
  constructor(slug: string, suggestions: string[]) {
    super(`slug "${slug}" is already taken`);
    this.name = 'SlugTakenError';
    this.slug = slug;
    this.suggestions = suggestions;
  }
}

/**
 * Derive three distinct slug suggestions when `base` is taken:
 *   1. Numeric suffix `-2` (or `-3`, `-4`, ...)
 *   2. Version suffix `-v2` (or `-v3`, ...)
 *   3. Random 8-char hex suffix (virtually collision-free)
 *
 * Each candidate is probed against the apps table and the suffix is
 * bumped until it's free. The 8-char hex path is effectively guaranteed
 * to be free on the first try.
 *
 * Exported for tests; callers should raise `SlugTakenError` rather than
 * computing suggestions themselves.
 */
export function deriveSlugSuggestions(base: string): string[] {
  // Cap the base so base + '-NN' still fits the 48-char slug ceiling.
  const truncated = base.slice(0, 40);
  const exists = db.prepare('SELECT 1 FROM apps WHERE slug = ?');
  const isFree = (s: string) => !exists.get(s);

  // Numeric: petstore-2, petstore-3, ...
  let numeric = `${truncated}-2`;
  for (let i = 2; i < 1000 && !isFree(numeric); i++) {
    numeric = `${truncated}-${i}`;
  }

  // Version: petstore-v2, petstore-v3, ...
  let version = `${truncated}-v2`;
  for (let i = 2; i < 1000 && !isFree(version); i++) {
    version = `${truncated}-v${i}`;
  }

  // Random 8-char hex. Node's randomUUID gives us enough entropy.
  // Stripped to a-z0-9 to match the slug regex.
  let random = `${truncated}-${randomSlugSuffix()}`;
  for (let i = 0; i < 8 && !isFree(random); i++) {
    random = `${truncated}-${randomSlugSuffix()}`;
  }

  // De-duplicate in the extremely unlikely case two strategies collapsed
  // to the same value (e.g. base ends in "-v1" already).
  return Array.from(new Set([numeric, version, random]));
}

function randomSlugSuffix(): string {
  // 8 hex chars is ~32 bits of entropy — collision-free for our scale.
  // Use Math.random rather than crypto.randomUUID to keep this file
  // dependency-free and runnable in every worker context.
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/**
 * Detect an app from an OpenAPI URL without persisting it. Used as the
 * "preview" step of /build Step 2 — the UI shows what we found, user
 * edits the name/slug, then clicks Publish.
 */
export async function detectAppFromUrl(
  openapi_url: string,
  requested_slug?: string,
  requested_name?: string,
): Promise<DetectedApp> {
  const spec = await fetchSpec(openapi_url);
  const derefed = await dereferenceSpec(spec);
  const info = (derefed as { info?: { title?: string; description?: string } })
    .info || {};
  const name = requested_name || info.title || 'Untitled app';
  const slug = slugify(requested_slug || name);

  // We only need slug+name+auth_type+action list here — we don't persist.
  // Build a lightweight appSpec compatible with specToManifest.
  const appSpec: OpenApiAppSpec = {
    slug,
    type: 'proxied',
    openapi_spec_url: openapi_url,
    display_name: name,
    description: info.description || undefined,
    auth: 'none',
  };
  const manifest = specToManifest(derefed, appSpec, deriveSecretsFromSpec(derefed));
  const actions = Object.entries(manifest.actions).map(([k, v]) => ({
    name: k,
    label: v.label,
    description: v.description,
  }));

  // Auth-type detection: merged view of OpenAPI 3 `components.securitySchemes`
  // and Swagger 2 `securityDefinitions`, so a spec ingested via either path
  // detects the right credential type for the /build preview pill.
  const schemes = collectSecuritySchemes(derefed);
  let auth_type: string | null = null;
  for (const scheme of Object.values(schemes)) {
    if (scheme?.type === 'http' && scheme?.scheme === 'bearer') {
      auth_type = 'bearer';
      break;
    }
    if (scheme?.type === 'apiKey') {
      auth_type = 'apikey';
      break;
    }
  }

  return {
    slug,
    name,
    description: appSpec.description || info.description || manifest.description || '',
    actions,
    auth_type,
    category: null,
    openapi_spec_url: openapi_url,
    tools_count: actions.length,
    secrets_needed: manifest.secrets_needed || [],
  };
}

/**
 * Persist an app ingested from an OpenAPI URL. Called by POST /api/hub/ingest
 * after the user confirms the detected manifest. Returns the persisted slug
 * on success; throws with a human-readable message on failure.
 *
 * Overrides: name, description, slug, category. Anything else comes from the
 * spec.
 */
export async function ingestAppFromUrl(args: {
  openapi_url: string;
  name?: string;
  description?: string;
  slug?: string;
  category?: string;
  workspace_id: string;
  author_user_id: string;
  visibility?: 'public' | 'private' | 'auth-required';
  allowPrivateNetwork?: boolean;
}): Promise<{ slug: string; name: string; created: boolean }> {
  const { openapi_url } = args;
  if (!openapi_url || !/^https?:\/\//i.test(openapi_url)) {
    throw new Error('openapi_url must be an http(s) URL');
  }

  const spec = await fetchSpec(openapi_url, {
    allowPrivateNetwork: args.allowPrivateNetwork,
  });
  return ingestAppFromSpec({ ...args, spec });
}

/**
 * Persist an app from an already-fetched OpenAPI spec object. Used by the
 * MCP admin `ingest_app` tool when callers submit inline JSON instead of a
 * URL, and internally by `ingestAppFromUrl` after fetching. The spec is
 * dereferenced, normalized into a Floom manifest, and upserted.
 *
 * `openapi_url` is optional — it's cached on the app row for the runtime
 * proxy to resolve relative paths. When callers submit inline JSON without
 * a URL, the spec must declare `servers[]` (OpenAPI 3) or a Swagger 2 `host`
 * for `resolveBaseUrl` to succeed; otherwise runtime calls will fail.
 */
export async function ingestAppFromSpec(args: {
  spec: OpenApiSpec;
  openapi_url?: string;
  name?: string;
  description?: string;
  slug?: string;
  category?: string;
  workspace_id: string;
  author_user_id: string;
  /** When omitted, new cloud apps default to `private`; OSS/local defaults to `public`. */
  visibility?: 'public' | 'private' | 'auth-required';
}): Promise<{ slug: string; name: string; created: boolean }> {
  const openapi_url = args.openapi_url || '';
  const derefed = await dereferenceSpec(args.spec);
  const specCached = JSON.stringify(derefed);
  const info = (derefed as { info?: { title?: string; description?: string } })
    .info || {};

  const name = args.name || info.title || 'Untitled app';
  const slug = slugify(args.slug || name);
  const description = args.description || info.description || '';

  // Refuse to silently collide with an existing app unless owned by same workspace.
  // On collision, attach three recovery suggestions (numeric / version /
  // random suffix) so the UI can render clickable pills instead of a
  // dead-end error (audit 2026-04-20, Fix 2).
  const existing = db
    .prepare('SELECT id, workspace_id, visibility FROM apps WHERE slug = ?')
    .get(slug) as { id: string; workspace_id: string; visibility: string } | undefined;
  if (existing && existing.workspace_id !== args.workspace_id && existing.workspace_id !== 'local') {
    throw new SlugTakenError(slug, deriveSlugSuggestions(slug));
  }

  let visibility: 'public' | 'private' | 'auth-required';
  if (args.visibility !== undefined) {
    visibility = args.visibility;
  } else if (existing) {
    visibility =
      (existing.visibility as 'public' | 'private' | 'auth-required') || 'public';
  } else {
    visibility = args.workspace_id === 'local' ? 'public' : 'private';
  }

  const appSpec: OpenApiAppSpec = {
    slug,
    type: 'proxied',
    openapi_spec_url: openapi_url || undefined,
    display_name: name,
    description,
    category: args.category,
    auth: 'none',
  };

  const manifest = specToManifest(derefed, appSpec, deriveSecretsFromSpec(derefed));
  const resolvedBaseUrl = resolveBaseUrl(derefed, appSpec, openapi_url || undefined);

  if (existing) {
    db.prepare(
      `UPDATE apps SET
         name=?, description=?, manifest=?, category=?, app_type='proxied',
         base_url=?, auth_type=?, auth_config=NULL, openapi_spec_url=?,
         openapi_spec_cached=?, visibility=?, is_async=0,
         webhook_url=NULL, timeout_ms=NULL, retries=0, async_mode=NULL,
         workspace_id=?, author=?, updated_at=datetime('now')
       WHERE slug=?`,
    ).run(
      manifest.name,
      description || manifest.description,
      JSON.stringify(manifest),
      args.category || null,
      resolvedBaseUrl || null,
      'none',
      openapi_url || null,
      specCached,
      visibility,
      args.workspace_id,
      args.author_user_id,
      slug,
    );
    return { slug, name, created: false };
  }

  const appId = newAppId();
  // Manual publish-review gate (#362): user-driven ingest (Studio /build,
  // MCP ingest_app, and anything else that ends up here) lands as
  // 'pending_review'. An admin flips it to 'published' via
  // POST /api/admin/apps/:slug/publish-status before it appears on the
  // public Store. Re-ingesting an existing app hits the UPDATE branch
  // above and leaves publish_status alone, so a published app stays
  // published when its spec refreshes.
  db.prepare(
    `INSERT INTO apps (
       id, slug, name, description, manifest, status, docker_image, code_path,
       category, author, icon, app_type, base_url, auth_type, auth_config,
       openapi_spec_url, openapi_spec_cached, visibility, is_async, webhook_url,
       timeout_ms, retries, async_mode, workspace_id, publish_status
     ) VALUES (
       ?, ?, ?, ?, ?, 'active', NULL, ?,
       ?, ?, NULL, 'proxied', ?, 'none', NULL,
       ?, ?, ?, 0, NULL,
       NULL, 0, NULL, ?, 'pending_review'
     )`,
  ).run(
    appId,
    slug,
    manifest.name,
    description || manifest.description,
    JSON.stringify(manifest),
    `proxied:${slug}`,
    args.category || null,
    args.author_user_id,
    resolvedBaseUrl || null,
    openapi_url || null,
    specCached,
    visibility,
    args.workspace_id,
  );

  return { slug, name, created: true };
}

/**
 * Return true if the scheme produces a "secret" that Floom's manifest
 * needs to request from the operator. We only model schemes we can
 * actually inject at runtime: HTTP bearer and apiKey. OAuth2 flows are
 * handled out-of-band (the user completes an authorization flow) so we
 * do not list them as required secrets. http-basic is handled via two
 * secrets (user/pass) but the creator is expected to declare those in
 * apps.yaml — we do not auto-derive them here to avoid guessing names.
 */
function schemeRequiresSecret(scheme: {
  type?: string;
  scheme?: string;
}): boolean {
  if (!scheme) return false;
  if (scheme.type === 'apiKey') return true;
  if (scheme.type === 'http' && scheme.scheme === 'bearer') return true;
  return false;
}

/**
 * Shape we use internally for a security scheme after merging OpenAPI 3
 * and Swagger 2 conventions. OpenAPI 3 already uses this shape; for
 * Swagger 2 we map `type: 'basic'` → `type: 'http', scheme: 'basic'` so
 * downstream code can reason about a single world.
 */
interface MergedSecurityScheme {
  type?: string;
  scheme?: string;
  name?: string;
  in?: string;
  description?: string;
}

/**
 * Return the combined view of security schemes declared in the spec.
 * Reads `components.securitySchemes` (OpenAPI 3.x) and `securityDefinitions`
 * (Swagger 2.0). If both are present — legal on Swagger→OpenAPI converted
 * specs — OpenAPI 3 entries win on name collision because that's the
 * canonical location on any spec fresh enough to have both fields.
 */
export function collectSecuritySchemes(
  spec: OpenApiSpec,
): Record<string, MergedSecurityScheme> {
  const merged: Record<string, MergedSecurityScheme> = {};

  // Swagger 2.0 — normalize basic → http+basic.
  const swagger2 = spec.securityDefinitions;
  if (swagger2 && typeof swagger2 === 'object') {
    for (const [name, raw] of Object.entries(swagger2)) {
      if (!raw) continue;
      if (raw.type === 'basic') {
        merged[name] = {
          type: 'http',
          scheme: 'basic',
          description: raw.description,
        };
      } else {
        merged[name] = {
          type: raw.type,
          name: raw.name,
          in: raw.in,
          description: raw.description,
        };
      }
    }
  }

  // OpenAPI 3.x — wins on collision.
  const oas3 = spec.components?.securitySchemes;
  if (oas3 && typeof oas3 === 'object') {
    for (const [name, raw] of Object.entries(oas3)) {
      if (!raw) continue;
      merged[name] = {
        type: raw.type,
        scheme: raw.scheme,
        name: raw.name,
        in: raw.in,
        description: raw.description,
      };
    }
  }

  return merged;
}

/**
 * Parameter names that almost always carry a credential, even when the
 * spec failed to declare a matching security scheme. Any input whose
 * runtime `name` matches this pattern is promoted to `secrets_needed` and
 * removed from the action's inputs so the run form doesn't render a
 * plaintext textbox for it.
 *
 * Real-world hits we've seen in user-ingested specs:
 *   - `api_key`, `apiKey`, `api-key`, `apikey`
 *   - `wskey`  (WorldCat / OCLC Search)
 *   - `access_token`, `auth_token`, `access-token`
 *   - `bearer` (when servers expect just the token)
 *   - `X-API-Key` (emitted by `header_X-API-Key` after sanitization)
 */
const AUTH_PARAM_REGEX = /^(api[-_]?key|apikey|wskey|access[-_]?token|auth[-_]?token|bearer|x-api-key)$/i;

/**
 * Return true if the given input name looks like an auth credential. The
 * match is done against both the raw name and the post-sanitization name
 * used for header inputs (prefixed with `header_`), so a spec that
 * declares an `X-API-Key` header parameter is caught whether or not the
 * ingest pipeline has already prefixed it.
 */
function inputNameLooksLikeAuth(name: string): boolean {
  if (!name) return false;
  if (AUTH_PARAM_REGEX.test(name)) return true;
  // Strip the `header_` / `cookie_` prefix our ingest pipeline applies
  // to non-query params, then retest.
  const stripped = name.replace(/^(header|cookie)_/i, '');
  return AUTH_PARAM_REGEX.test(stripped);
}

/**
 * Resolve the EFFECTIVE security requirements for a single operation.
 * Per OpenAPI 3.x §4.8.10, an operation-level `security` field REPLACES
 * the global `security` field entirely (not merges). An empty array
 * (`security: []`) is an explicit override meaning "no auth required",
 * and must be distinguished from "security field missing entirely".
 *
 * Returns:
 *   - null   : operation is public (no security requirements apply).
 *   - array  : the list of alternative requirement objects.
 */
function effectiveSecurityForOperation(
  spec: OpenApiSpec,
  op: OpenApiOperation,
): OpenApiSecurityRequirement[] | null {
  // Operation-level security takes priority when the field is present —
  // even if it is an empty array, which explicitly overrides global.
  if (Object.prototype.hasOwnProperty.call(op, 'security')) {
    const sec = op.security;
    if (!sec || sec.length === 0) return null;
    return sec;
  }
  // Fall back to global security.
  const global = spec.security;
  if (!global || global.length === 0) return null;
  return global;
}

/**
 * Return the set of security-scheme names that are STRICTLY required by
 * a single operation. A scheme is strictly required iff it appears in
 * EVERY alternative of the operation's effective security array. If at
 * least one alternative omits the scheme, the caller can satisfy the op
 * by picking that alternative, so the scheme is not strictly required.
 *
 * This is the correct reading of OpenAPI 3.x §4.8.10 "Security
 * Requirement Object" (AND within an object, OR across the array).
 *
 * Only schemes that produce a manifest secret (apiKey, http bearer) are
 * returned — oauth2 and other flows are handled out-of-band.
 */
export function requiredSecretsForOperation(
  spec: OpenApiSpec,
  op: OpenApiOperation,
): string[] {
  // Merged view: OpenAPI 3 `components.securitySchemes` + Swagger 2
  // `securityDefinitions`. See collectSecuritySchemes() for details.
  const schemes = collectSecuritySchemes(spec);
  if (Object.keys(schemes).length === 0) return [];

  const effective = effectiveSecurityForOperation(spec, op);
  if (!effective) return []; // op is public

  // Intersect scheme names across all alternatives.
  let intersection: Set<string> | null = null;
  for (const requirement of effective) {
    const namesInThisAlt = new Set(Object.keys(requirement));
    if (intersection === null) {
      intersection = namesInThisAlt;
    } else {
      for (const name of Array.from(intersection)) {
        if (!namesInThisAlt.has(name)) intersection.delete(name);
      }
    }
  }
  if (!intersection) return [];

  const out: string[] = [];
  for (const schemeName of intersection) {
    const scheme = schemes[schemeName];
    if (scheme && schemeRequiresSecret(scheme)) {
      out.push(schemeName);
    }
  }
  return out;
}

/**
 * Collect the set of security-scheme names that are strictly required by
 * at least one operation in the spec (after applying per-operation
 * overrides) AND whose scheme type produces a manifest secret. Used to
 * populate the app-level `manifest.secrets_needed`, which is surfaced to
 * MCP clients and the /build preview UI so operators know which secrets
 * to configure.
 *
 * Per-operation granularity lives on the action itself
 * (`ActionSpec.secrets_needed`) so the proxied-runner only blocks an
 * action when THAT action's required secrets are missing, rather than
 * blanket-blocking the entire app.
 */
export function deriveSecretsFromSpec(spec: OpenApiSpec): string[] {
  const required = new Set<string>();
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;

  for (const pathItem of Object.values(spec.paths || {})) {
    for (const method of methods) {
      const op = pathItem[method as keyof OpenApiPath] as
        | OpenApiOperation
        | undefined;
      if (!op) continue;
      for (const name of requiredSecretsForOperation(spec, op)) {
        required.add(name);
      }
      // Regex fallback: surface any parameter whose name smells like a
      // credential. Matches the per-action lifter in `specToManifest` so
      // the app-level `secrets_needed` union stays in sync with each
      // action's per-op `secrets_needed`.
      for (const param of op.parameters || []) {
        if (!param?.name) continue;
        if (inputNameLooksLikeAuth(param.name)) {
          required.add(param.name.replace(/^(header|cookie)_/i, ''));
        }
      }
    }
  }

  return Array.from(required);
}
