// Reconstruct an OpenAPI 3.0 spec from a Floom manifest.
//
// Background: when an app is ingested via `studio_publish_app` with an
// OpenAPI URL or inline spec, we cache the raw spec in
// `apps.openapi_spec_cached`. But Docker-image apps (and a handful of
// legacy proxied apps) don't have a cached spec — only the normalized
// manifest with its `actions` map. The frontend agent-onboarding banner
// (`AppPermalinkPage.tsx`) tells callers to fetch
// `/api/hub/:slug/openapi.json`, so we synthesize one on the fly when
// `openapi_spec_cached` is null.
//
// The synthesized spec mirrors the shape Floom's own runtime exposes:
// each action becomes a `POST /api/:slug/run` operation with body
// `{ action, inputs }`. This is also the shape `studio_publish_app`
// accepts as input, so the round-trip is symmetric.
//
// Returns null when the manifest has no usable actions (caller should
// surface the "no_openapi_spec" error in that case).

import type { InputSpec, NormalizedManifest } from '../types.js';

interface OpenApiPropertySchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
}

interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  requestBody: {
    required: boolean;
    content: {
      'application/json': {
        schema: {
          type: 'object';
          properties: {
            action: { type: 'string'; enum: [string] };
            inputs: {
              type: 'object';
              properties: Record<string, OpenApiPropertySchema>;
              required?: string[];
            };
          };
          required: string[];
        };
        example?: Record<string, unknown>;
      };
    };
  };
  responses: Record<string, unknown>;
}

interface OpenApiSpec {
  openapi: '3.0.0';
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string; description?: string }>;
  paths: Record<string, { post: OpenApiOperation }>;
}

function inputToOpenApiProperty(input: InputSpec): OpenApiPropertySchema {
  const property: OpenApiPropertySchema = {};
  switch (input.type) {
    case 'number':
      property.type = 'number';
      break;
    case 'boolean':
      property.type = 'boolean';
      break;
    case 'enum':
      property.type = 'string';
      if (input.options && input.options.length > 0) property.enum = input.options;
      break;
    case 'url':
      property.type = 'string';
      property.format = 'uri';
      break;
    case 'date':
      property.type = 'string';
      property.format = 'date';
      break;
    case 'file':
    case 'file/csv':
    case 'file/image':
    case 'file/pdf':
    case 'file/audio':
      property.type = 'string';
      property.format = 'binary';
      break;
    case 'array':
      property.type = 'array';
      break;
    case 'object':
      property.type = 'object';
      break;
    case 'textarea':
    case 'text':
    default:
      property.type = 'string';
      break;
  }
  if (input.description) property.description = input.description;
  if (input.default !== undefined) property.default = input.default;
  return property;
}

function exampleValueForInput(input: InputSpec): unknown {
  if (input.default !== undefined) return input.default;
  if (input.type === 'number') return 1;
  if (input.type === 'boolean') return true;
  if (input.type === 'enum') return input.options?.[0] ?? 'example';
  if (input.type === 'url') return 'https://example.com';
  if (input.type === 'date') return '2026-01-01';
  return input.placeholder || 'example';
}

/**
 * Build an OpenAPI 3.0 spec from a Floom manifest. Returns null if the
 * manifest has no actions (caller should respond with 404 + no_openapi_spec).
 *
 * The synthesized spec is good enough to feed back into `studio_publish_app`
 * (round-trip safe) and to drive an agent that wants a machine-readable
 * contract for the Floom-hosted app.
 */
export function manifestToOpenApi(
  manifest: NormalizedManifest,
  options: {
    slug: string;
    serverBaseUrl: string;
  },
): OpenApiSpec | null {
  const actions = manifest.actions || {};
  const actionNames = Object.keys(actions);
  if (actionNames.length === 0) return null;

  const paths: OpenApiSpec['paths'] = {};
  for (const [actionName, actionSpec] of Object.entries(actions)) {
    const inputs = actionSpec.inputs || [];
    const properties: Record<string, OpenApiPropertySchema> = {};
    const requiredInputs: string[] = [];
    const exampleInputs: Record<string, unknown> = {};
    for (const input of inputs) {
      properties[input.name] = inputToOpenApiProperty(input);
      if (input.required) requiredInputs.push(input.name);
      if (input.required) exampleInputs[input.name] = exampleValueForInput(input);
    }
    // Per-action path so each action maps to one operationId. Keeping the
    // path stable as `/api/:slug/run` (matching Floom's actual HTTP route)
    // means an agent can curl the synthesized URL and have it work — the
    // server dispatches on the `action` field in the body.
    const pathKey = `/api/${options.slug}/run#${actionName}`;
    paths[pathKey] = {
      post: {
        operationId: actionName,
        summary: actionSpec.label || actionName,
        ...(actionSpec.description ? { description: actionSpec.description } : {}),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: [actionName] },
                  inputs: {
                    type: 'object',
                    properties,
                    ...(requiredInputs.length > 0 ? { required: requiredInputs } : {}),
                  },
                },
                required: ['action', 'inputs'],
              },
              example: {
                action: actionName,
                inputs: exampleInputs,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful run',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'Action-specific output. Matches the action outputs declared in the Floom manifest.',
                },
              },
            },
          },
          '400': {
            description: 'Invalid input',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    code: { type: 'string' },
                  },
                },
              },
            },
          },
          '429': {
            description: 'Rate limited',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    code: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.0',
    info: {
      title: manifest.name,
      version: '0.1.0',
      ...(manifest.description ? { description: manifest.description } : {}),
    },
    servers: [
      {
        url: options.serverBaseUrl.replace(/\/+$/, ''),
        description: 'Floom-hosted runtime',
      },
    ],
    paths,
  };
}
