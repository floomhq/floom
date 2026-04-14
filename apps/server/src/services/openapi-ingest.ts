// OpenAPI ingest pipeline.
// Reads a YAML or JSON config file listing proxied apps, fetches their OpenAPI
// specs, generates a Floom manifest for each operation, and upserts into the
// apps table. Idempotent: re-running with the same config does not duplicate.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
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
  auth?: 'bearer' | 'apikey' | 'none';
  secrets?: string[];
  display_name?: string;
  description?: string;
  category?: string;
  icon?: string;
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

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    enum?: string[];
    default?: unknown;
  };
}

interface OpenApiRequestBodyContent {
  schema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
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

function openApiParamToInput(param: OpenApiParameter): InputSpec {
  const schema = param.schema || {};
  let type: InputSpec['type'] = 'text';
  if (schema.type === 'number' || schema.type === 'integer') type = 'number';
  else if (schema.type === 'boolean') type = 'boolean';
  else if (Array.isArray(schema.enum) && schema.enum.length > 0) type = 'enum';

  return {
    name: param.name,
    label: param.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    type,
    required: param.required ?? false,
    description: param.description,
    options: type === 'enum' ? (schema.enum as string[]) : undefined,
    default: schema.default,
  };
}

function bodySchemaToInputs(
  content: Record<string, OpenApiRequestBodyContent>,
  required: boolean,
): InputSpec[] {
  const inputs: InputSpec[] = [];
  // Prefer application/json, fall back to first content type
  const mediaType =
    content['application/json'] || content[Object.keys(content)[0]];
  if (!mediaType?.schema?.properties) {
    // No structured schema — accept freeform text
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
  const required_fields = mediaType.schema.required || [];
  for (const [propName, propSchema] of Object.entries(
    mediaType.schema.properties,
  )) {
    let type: InputSpec['type'] = 'text';
    if (propSchema.type === 'number' || propSchema.type === 'integer') type = 'number';
    else if (propSchema.type === 'boolean') type = 'boolean';
    else if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) type = 'enum';

    inputs.push({
      name: propName,
      label: propName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      type,
      required: required_fields.includes(propName),
      description: propSchema.description,
      options: type === 'enum' ? (propSchema.enum as string[]) : undefined,
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

  // Path + query parameters
  for (const param of op.parameters || []) {
    if (param.in === 'path' || param.in === 'query') {
      inputs.push(openApiParamToInput(param));
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
 *   2. spec.servers[0].url (OpenAPI 3.x) with variable substitution
 *   3. Swagger 2.0 host + basePath + schemes[0]
 *   4. null if nothing found
 *
 * Variable substitution uses {var} placeholders from spec.servers[0].variables.
 * If a placeholder has no default, it is left as-is (and will cause a runtime
 * failure with a clear message — better than silently rewriting it).
 */
export function resolveBaseUrl(
  spec: OpenApiSpec,
  appSpec: OpenApiAppSpec,
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
    // Handle server-relative URLs (starts with /): these are relative to
    // the spec's fetch URL, which we don't track here. Caller should pass
    // base_url explicitly in that case.
    if (url.startsWith('/') || !url.startsWith('http')) {
      return null;
    }
    return url;
  }

  // 3. Swagger 2.0 host + basePath
  if (spec.host) {
    const scheme =
      (Array.isArray(spec.schemes) && spec.schemes[0]) || 'https';
    const basePath = spec.basePath || '';
    return `${scheme}://${spec.host}${basePath}`;
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
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon, app_type, base_url, auth_type, openapi_spec_url, openapi_spec_cached)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, 'proxied', ?, ?, ?, ?)`,
  );
  const updateApp = db.prepare(
    `UPDATE apps SET name=?, description=?, manifest=?, category=?, app_type='proxied', base_url=?, auth_type=?, openapi_spec_url=?, openapi_spec_cached=?, updated_at=datetime('now') WHERE slug=?`,
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

      const secretNames = appSpec.secrets || [];
      const manifest = specToManifest(spec, appSpec, secretNames);
      const specCached = JSON.stringify(spec);

      // Resolve the effective base URL. appSpec.base_url wins, otherwise
      // we read spec.servers[] (OpenAPI 3.x) or spec.host + basePath (Swagger 2).
      const resolvedBaseUrl = resolveBaseUrl(spec, appSpec);
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

      if (existing) {
        updateApp.run(
          manifest.name,
          appSpec.description || manifest.description,
          JSON.stringify(manifest),
          appSpec.category || null,
          resolvedBaseUrl || null,
          appSpec.auth || null,
          appSpec.openapi_spec_url || null,
          specCached,
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
          appSpec.openapi_spec_url || null,
          specCached,
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
