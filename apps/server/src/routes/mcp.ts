// MCP endpoints for Floom.
//   /mcp           — admin surface (ingest_app, ingest_hint, detect_inline,
//                    list_apps, search_apps, get_app)
//   /mcp/search    — gallery-wide semantic search
//   /mcp/app/:slug — per-app MCP (one tool per action)
//
// Registration order matters: `/` (admin) is handled ahead of
// `/app/:slug` below so Hono does not swallow the root path as a slug.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { db } from '../db.js';
import { newRunId, newJobId } from '../lib/ids.js';
import { validateInputs, ManifestError } from '../services/manifest.js';
import { dispatchRun, getRun } from '../services/runner.js';
import { createJob } from '../services/jobs.js';
import { pickApps } from '../services/embeddings.js';
import {
  buildIngestHint,
  detectAppFromInlineSpec,
  ingestAppFromSpec,
  ingestAppFromUrl,
} from '../services/openapi-ingest.js';
import {
  ingestAppFromDockerImage,
  isDockerPublishEnabled,
  DockerPublishDisabledError,
  DOCKER_PUBLISH_FLAG,
} from '../services/docker-image-ingest.js';
import { resolveUserContext } from '../services/session.js';
import { isCloudMode } from '../lib/better-auth.js';
import {
  AUTH_DOCS_URL,
  AUTH_HINT_CLOUD,
  checkAppVisibility,
} from '../lib/auth.js';
import { checkMcpIngestLimit, extractIp } from '../lib/rate-limit.js';
import { filterTestFixtures } from '../lib/hub-filter.js';
import { recordMcpToolCall } from '../lib/metrics-counters.js';
import type {
  ActionSpec,
  AppRecord,
  InputSpec,
  NormalizedManifest,
  RunRecord,
  SessionContext,
} from '../types.js';

export const mcpRouter = new Hono();

/**
 * Resolve the public origin used in MCP response bodies (permalink, mcp_url,
 * etc.).
 *
 * Priority (B8 fix — was hardcoded to `https://floom.dev`):
 *   1. `FLOOM_PUBLIC_ORIGIN` env (explicit operator override — used in prod
 *      to pin responses to the canonical origin regardless of which host
 *      the request came in on).
 *   2. The origin of the incoming request. Any reverse proxy (nginx, Cloud
 *      Run) is expected to preserve the public hostname in `c.req.url`; if
 *      not, set `FLOOM_PUBLIC_ORIGIN` to override.
 *
 * Why no hardcoded fallback: defaulting to `https://floom.dev` on preview
 * environments caused ingest_app responses to hand out prod permalinks that
 * broke the preview→ingest→click-through loop. Deriving from the request
 * keeps preview.floom.dev, docker.floom.dev, and local dev all self-consistent.
 *
 * NB: email templates (`apps/server/src/lib/email.ts`) and canonical URL meta
 * tags in HTML responses intentionally still point at the prod origin —
 * emails are only sent from prod, and canonical tags must resolve to the
 * indexed URL. Only MCP response bodies use this helper.
 */
export function getPublicBaseUrl(c: Context): string {
  const override = process.env.FLOOM_PUBLIC_ORIGIN;
  if (typeof override === 'string' && override.length > 0) {
    return override.replace(/\/+$/, '');
  }
  try {
    return new URL(c.req.url).origin;
  } catch {
    // Defensive fallback. Any request reaching a Hono handler will have a
    // parseable URL, so this branch should be unreachable in practice.
    return 'https://floom.dev';
  }
}

function formatRun(row: RunRecord) {
  return {
    id: row.id,
    app_id: row.app_id,
    action: row.action,
    inputs: row.inputs ? JSON.parse(row.inputs) : null,
    outputs: row.outputs ? JSON.parse(row.outputs) : null,
    logs: row.logs,
    status: row.status,
    error: row.error,
    error_type: row.error_type,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

async function waitForRun(runId: string): Promise<RunRecord> {
  const MAX_WAIT_MS = 10 * 60 * 1000;
  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const row = getRun(runId);
    if (!row) throw new Error(`Run ${runId} not found`);
    if (['success', 'error', 'timeout'].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const row = getRun(runId);
  if (!row) throw new Error(`Run ${runId} not found`);
  return row;
}

function buildZodSchema(
  inputs: InputSpec[],
  secretsNeeded: string[],
): Record<string, z.ZodType> {
  const schema: Record<string, z.ZodType> = {};
  for (const inp of inputs) {
    let field: z.ZodType;
    switch (inp.type) {
      case 'number':
        field = z.number().describe(inp.description ?? inp.label);
        break;
      case 'boolean':
        field = z.boolean().describe(inp.description ?? inp.label);
        break;
      case 'enum':
        if (inp.options && inp.options.length > 0) {
          field = z
            .enum(inp.options as [string, ...string[]])
            .describe(inp.description ?? inp.label);
        } else {
          field = z.string().describe(inp.description ?? inp.label);
        }
        break;
      default:
        field = z.string().describe(inp.description ?? inp.label);
    }
    if (!inp.required) {
      field = field.optional();
    }
    schema[inp.name] = field;
  }
  // Per-user secrets injection (Floom MCP extension).
  // When the app declares secrets_needed, advertise them as an optional
  // `_auth` meta object. The MCP client can populate it per call; values
  // are injected into the per-run secrets and never persisted server-side.
  if (secretsNeeded.length > 0) {
    const authShape: Record<string, z.ZodType> = {};
    for (const name of secretsNeeded) {
      authShape[name] = z
        .string()
        .optional()
        .describe(`Per-user secret: ${name}`);
    }
    schema._auth = z
      .object(authShape)
      .optional()
      .describe(
        `Per-user secrets for this app. Required: ${secretsNeeded.join(
          ', ',
        )}. These values are used for this call only and are never stored server-side.`,
      );
  }
  return schema;
}

function createPerAppMcpServer(
  app: AppRecord,
  ctx?: SessionContext,
): McpServer {
  const manifest = JSON.parse(app.manifest) as NormalizedManifest;
  const server = new McpServer({
    name: `floom-chat-${app.slug}`,
    version: '0.3.0',
  });

  for (const [actionName, actionSpec] of Object.entries(manifest.actions) as Array<
    [string, ActionSpec]
  >) {
    const actionSecretsNeeded =
      actionSpec.secrets_needed !== undefined
        ? actionSpec.secrets_needed
        : manifest.secrets_needed || [];
    const toolName =
      actionName === 'run' ? app.slug.replace(/[^a-z0-9_]/g, '_') : actionName;
    const toolDescription =
      actionSpec.description ??
      `Run the "${actionSpec.label}" action on ${app.name}. ${app.description}`;

    server.registerTool(
      toolName,
      {
        title: actionSpec.label,
        description: toolDescription,
        inputSchema: buildZodSchema(actionSpec.inputs, actionSecretsNeeded),
      },
      async (rawInputs) => {
        recordMcpToolCall(toolName);
        const fresh = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id) as
          | AppRecord
          | undefined;
        if (!fresh) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `App not found: ${app.slug}` }],
          };
        }
        if (fresh.status !== 'active') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `App is ${fresh.status}, cannot run` }],
          };
        }

        // Extract the Floom MCP _auth extension from the raw inputs before
        // validating against the action's input schema. _auth is per-call
        // secrets that the MCP client can supply on each tool invocation.
        // Never persisted server-side.
        const raw = { ...(rawInputs as Record<string, unknown>) };
        let perCallSecrets: Record<string, string> | undefined;
        if (raw._auth && typeof raw._auth === 'object' && raw._auth !== null) {
          const authObj = raw._auth as Record<string, unknown>;
          perCallSecrets = {};
          for (const [k, v] of Object.entries(authObj)) {
            if (typeof v === 'string' && v.length > 0) {
              perCallSecrets[k] = v;
            }
          }
          delete raw._auth;
        }

        let validated: Record<string, unknown>;
        try {
          validated = validateInputs(actionSpec, raw);
        } catch (err) {
          const e = err as ManifestError;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Invalid inputs: ${e.message}` }],
          };
        }
        const runId = newRunId();
        const freshManifest = JSON.parse(fresh.manifest) as NormalizedManifest;

        // If the app requires secrets and none are available (neither
        // server-side persisted nor per-call _auth), return a structured
        // missing_secrets error so the MCP client can prompt the user.
        if (actionSecretsNeeded.length > 0) {
          const available = new Set<string>();
          // Server-side persisted secrets
          const rows = db
            .prepare(
              "SELECT name FROM secrets WHERE (app_id IS NULL OR app_id = ?) AND value != ''",
            )
            .all(fresh.id) as { name: string }[];
          for (const r of rows) available.add(r.name);
          // Per-call secrets
          for (const k of Object.keys(perCallSecrets || {})) available.add(k);

          const missing = actionSecretsNeeded.filter((n) => !available.has(n));
          if (missing.length > 0) {
            const errorPayload = {
              error: 'missing_secrets',
              required: missing,
              help: `This app needs ${missing.join(
                ', ',
              )}. Supply them via the _auth meta argument: {"_auth": {"${missing[0]}": "your_value"}}`,
            };
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: JSON.stringify(errorPayload, null, 2) },
              ],
            };
          }
        }

        // Async app (v0.3.0): enqueue a job and return immediately so the
        // MCP client doesn't block on a 10-20 minute run. The client polls
        // /api/:slug/jobs/:id or receives a webhook on completion.
        if (fresh.is_async) {
          const jobId = newJobId();
          createJob(jobId, {
            app: fresh,
            action: actionName,
            inputs: validated,
            perCallSecrets,
          });
          const publicUrl =
            process.env.PUBLIC_URL ||
            `http://localhost:${process.env.PORT || 3051}`;
          const pollUrl = `${publicUrl}/api/${fresh.slug}/jobs/${jobId}`;
          const payload = {
            job_id: jobId,
            status: 'queued',
            slug: fresh.slug,
            action: actionName,
            poll_url: pollUrl,
            cancel_url: `${pollUrl}/cancel`,
            message: `Job started: ${jobId}. Poll ${pollUrl} for status.`,
          };
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        }

        db.prepare(
          `INSERT INTO runs (id, app_id, action, inputs, status) VALUES (?, ?, ?, ?, 'pending')`,
        ).run(runId, fresh.id, actionName, JSON.stringify(validated));
        // Parity with POST /api/run + POST /api/:slug/run: pass the
        // resolved SessionContext so dispatchRun can merge the caller's
        // user-vault secrets. Without this every authed MCP consumer
        // falls back to defaultContext() (the synthetic 'local' user)
        // and loses access to their own vault. See
        // docs/product-audit/deep/pd-05-three-surface-parity.md.
        dispatchRun(
          fresh,
          freshManifest,
          runId,
          actionName,
          validated,
          perCallSecrets,
          ctx,
        );
        const done = await waitForRun(runId);
        return {
          isError: done.status !== 'success',
          content: [{ type: 'text' as const, text: JSON.stringify(formatRun(done), null, 2) }],
        };
      },
    );
  }

  return server;
}

// ---------------------------------------------------------------------
// Admin MCP server (/mcp root)
//
// Exposes four tools for gallery + app-creation workflows. `ingest_app`
// is the only authenticated call — it mirrors the HTTP `/api/hub/ingest`
// session rules so one API surface covers both MCP clients and the web
// UI. The three read tools are public, matching `/api/hub` + `/mcp/search`.
// ---------------------------------------------------------------------

interface AdminToolContext {
  ctx: SessionContext;
  ip: string;
  baseUrl: string;
}

function serializeHubApp(
  row: AppRecord,
  manifest: NormalizedManifest | null,
  baseUrl: string,
) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    icon: row.icon,
    actions: manifest ? Object.keys(manifest.actions) : [],
    runtime: manifest?.runtime ?? 'python',
    secrets_needed: manifest?.secrets_needed ?? [],
    featured: row.featured === 1,
    avg_run_ms: row.avg_run_ms,
    created_at: row.created_at,
    permalink: `${baseUrl}/p/${row.slug}`,
    mcp_url: `${baseUrl}/mcp/app/${row.slug}`,
  };
}

function safeParseManifest(raw: string): NormalizedManifest | null {
  try {
    return JSON.parse(raw) as NormalizedManifest;
  } catch {
    return null;
  }
}

function createAdminMcpServer({ ctx, ip, baseUrl }: AdminToolContext): McpServer {
  const server = new McpServer({
    name: 'floom-admin',
    version: '0.4.0',
  });

  // ---- ingest_app -----------------------------------------------------
  server.registerTool(
    'ingest_app',
    {
      title: 'Ingest App from OpenAPI or Docker image',
      description:
        'Create or update a Floom app. Two ingest modes: (1) OpenAPI — supply `openapi_url` or `openapi_spec`; (2) Docker image — supply `docker_image_ref` (gated behind FLOOM_ENABLE_DOCKER_PUBLISH=true, off by default). Exactly one mode per call. Overrides: name, description, slug, category. Requires authentication in Cloud mode. Returns the persisted slug + permalink.',
      inputSchema: {
        openapi_url: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe(
            'Publicly reachable OpenAPI 3.x or Swagger 2.0 spec URL. Example: https://petstore3.swagger.io/api/v3/openapi.json',
          ),
        openapi_spec: z
          .record(z.unknown())
          .optional()
          .describe(
            'Inline OpenAPI spec object (alternative to openapi_url). Must declare servers[].url or swagger host for runtime calls to resolve.',
          ),
        docker_image_ref: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe(
            'Docker image reference (admin-gated). Example: "ghcr.io/floomhq/ig-nano-scout:latest". Requires FLOOM_ENABLE_DOCKER_PUBLISH=true on the server.',
          ),
        manifest: z
          .record(z.unknown())
          .optional()
          .describe(
            'Optional Floom manifest (v1 or v2) paired with docker_image_ref. If absent, a minimal single-action manifest is synthesized.',
          ),
        secret_bindings: z
          .record(z.string())
          .optional()
          .describe(
            'Map of container env var → vault key in the caller\'s user_secrets. Example: {"IG_SESSIONID": "instagram_session_id"}. Only honored with docker_image_ref.',
          ),
        name: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe('Display name override. Defaults to spec.info.title or image repo name.'),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe('Description override. Defaults to spec.info.description or image label.'),
        slug: z
          .string()
          .min(1)
          .max(48)
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .optional()
          .describe(
            'URL slug override. Lowercase alphanumerics and dashes only. Defaults to slugify(name).',
          ),
        category: z
          .string()
          .max(48)
          .optional()
          .describe('Category tag (e.g. "productivity", "data", "ai").'),
        visibility: z
          .enum(['public', 'private', 'auth-required'])
          .optional()
          .describe(
            'Visibility override. Docker apps default to "private" in cloud mode, "public" in OSS local mode. OpenAPI apps keep existing defaults.',
          ),
      },
    },
    async (args) => {
      // Per-user/IP rate limit on ingest_app. Stops an MCP client from
      // scripting dozens of /mcp ingests per minute. Check BEFORE the
      // auth gate so we don't leak "anonymous users get 0 runs" vs "are
      // blocked for other reasons" through timing — 429 is a distinct
      // failure mode.
      const limit = checkMcpIngestLimit(ctx, ip);
      if (!limit.allowed) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'rate_limit_exceeded',
                  scope: 'mcp_ingest',
                  retry_after_seconds: limit.retryAfterSec,
                  message:
                    'ingest_app is limited to 10 calls per user per day. Retry after the window resets.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Auth gate: mirror /api/hub/ingest. In Cloud mode anonymous callers
      // cannot create apps; in OSS mode every caller is the synthetic local
      // user and the call always succeeds.
      if (isCloudMode() && !ctx.is_authenticated) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    'Authentication required. Sign in (or supply a valid session cookie / bearer token) and retry.',
                  code: 'auth_required',
                  hint: AUTH_HINT_CLOUD,
                  docs_url: AUTH_DOCS_URL,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const openapi_url = typeof args.openapi_url === 'string' ? args.openapi_url : undefined;
      const openapi_spec = args.openapi_spec as Record<string, unknown> | undefined;
      const docker_image_ref =
        typeof args.docker_image_ref === 'string' ? args.docker_image_ref : undefined;

      // Exactly one ingest mode per call. Both provided ⇒ ambiguous;
      // neither provided ⇒ nothing to ingest.
      const modes = [openapi_url, openapi_spec, docker_image_ref].filter(Boolean).length;
      if (modes === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'invalid_input',
                  message: 'Supply one of: openapi_url, openapi_spec, docker_image_ref.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (modes > 1) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'invalid_input',
                  message:
                    'Supply exactly one of: openapi_url, openapi_spec, docker_image_ref.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Docker-image path is admin-gated. Reject before touching the daemon so
      // the schema field can advertise the capability without exposing it.
      if (docker_image_ref && !isDockerPublishEnabled()) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'docker_publish_disabled',
                  message: `Docker-image ingest is disabled on this Floom instance. Set ${DOCKER_PUBLISH_FLAG}=true to enable.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      try {
        const common = {
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          slug: args.slug as string | undefined,
          category: args.category as string | undefined,
          workspace_id: ctx.workspace_id,
          author_user_id: ctx.user_id,
        };
        let result: { slug: string; name: string; created: boolean };
        if (docker_image_ref) {
          result = await ingestAppFromDockerImage({
            ...common,
            docker_image_ref,
            manifest: args.manifest,
            secret_bindings: args.secret_bindings as Record<string, string> | undefined,
            visibility: args.visibility as 'public' | 'private' | 'auth-required' | undefined,
            ctx,
          });
        } else if (openapi_url) {
          // Prefer URL path — ingestAppFromUrl fetches + dereferences.
          result = await ingestAppFromUrl({
            ...common,
            openapi_url,
            allowPrivateNetwork:
              ctx.workspace_id === 'local' && ctx.user_id === 'local',
          });
        } else {
          // Inline spec path. Accept any JSON object and let
          // dereferenceSpec + specToManifest validate shape downstream.
          result = await ingestAppFromSpec({
            ...common,
            spec: openapi_spec as Parameters<typeof ingestAppFromSpec>[0]['spec'],
          });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  slug: result.slug,
                  name: result.name,
                  created: result.created,
                  permalink: `${baseUrl}/p/${result.slug}`,
                  mcp_url: `${baseUrl}/mcp/app/${result.slug}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // Preserve error codes from known ingest failures so MCP clients can
        // render targeted UI (docker_publish_disabled, pull_failed,
        // invalid_image_ref, manifest_invalid, etc.). Fall back to a generic
        // ingest_failed for everything else.
        let errorCode = 'ingest_failed';
        if (err instanceof DockerPublishDisabledError) {
          errorCode = 'docker_publish_disabled';
        } else if (
          typeof (err as { code?: unknown }).code === 'string'
        ) {
          errorCode = (err as { code: string }).code;
        }
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: errorCode,
                  message: (err as Error).message || 'Ingest failed',
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---- ingest_hint ----------------------------------------------------
  //
  // Proactive recovery companion for `ingest_app`. When an agent (Claude
  // in Cursor, Claude Desktop, any MCP client) tries to call ingest_app
  // and the repo doesn't have an OpenAPI spec, it calls ingest_hint to
  // learn exactly what file Floom needs, get a prompt it can run in the
  // user's repo, and the direct upload URL to submit the generated spec
  // back to. This closes the "ingest failed, user stuck" loop without
  // human intervention.
  //
  // No auth gate: returns static metadata + a prompt string, never
  // issues an outbound fetch — so not an SSRF primitive.
  server.registerTool(
    'ingest_hint',
    {
      title: 'Ingest hint: what Floom needs to publish an app',
      description:
        'Returns a structured recovery shape when `ingest_app` fails (or proactively, before calling it). Use this when the repo/URL the user gave you does not have an obvious OpenAPI spec. The response includes: the exact filenames Floom looks for, the minimal spec shape, a ready-to-paste prompt you can run in the user\'s repo to generate `openapi.yaml`, and the upload URL where you can POST the generated spec back to Floom to complete detection without re-entering the URL.',
      inputSchema: {
        input_url: z
          .string()
          .min(1)
          .max(2048)
          .describe(
            'The repo URL, owner/repo ref, or OpenAPI URL the user provided. Example: "federicodeponte/openblog" or "https://github.com/acme/api".',
          ),
        attempted: z
          .array(z.string().max(2048))
          .max(40)
          .optional()
          .describe(
            'Paths the caller already probed (raw.githubusercontent URLs etc.). Forwarded back in `paths_tried` so the response names them exactly.',
          ),
      },
    },
    async ({ input_url, attempted }) => {
      const hint = buildIngestHint({
        input_url,
        attempted,
        baseUrl,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(hint, null, 2) },
        ],
      };
    },
  );

  // ---- detect_inline --------------------------------------------------
  //
  // Agent workflow: after `ingest_hint` gave the caller a ready prompt
  // and they generated an openapi.yaml in the user's repo, they can
  // submit the spec CONTENTS here to run detection without needing the
  // file to be pushed + publicly reachable yet. Mirrors
  // POST /api/hub/detect/inline.
  server.registerTool(
    'detect_inline',
    {
      title: 'Detect app from inline OpenAPI spec',
      description:
        'Run app detection against a spec supplied inline (JSON object or YAML/JSON string). Useful after `ingest_hint` when the caller just generated the spec and wants to preview the detected actions before committing + pushing it. Returns the same shape as `ingest_app`\'s detect preview (slug, name, actions, auth_type, tools_count, secrets_needed).',
      inputSchema: {
        openapi_spec: z
          .union([z.record(z.unknown()), z.string().min(1).max(2 * 1024 * 1024)])
          .describe(
            'OpenAPI 3.x (or Swagger 2.0) spec, either as a pre-parsed object or as a raw YAML/JSON string. YAML is parsed via the `yaml` package.',
          ),
        name: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe('Display name override. Defaults to spec.info.title.'),
        slug: z
          .string()
          .min(1)
          .max(48)
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .optional()
          .describe('URL slug override. Defaults to slugify(name).'),
      },
    },
    async ({ openapi_spec, name, slug }) => {
      try {
        const detected = await detectAppFromInlineSpec(
          openapi_spec as never,
          slug,
          name,
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(detected, null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: (err as Error).message || 'detect_inline_failed',
                  hint_url: `${baseUrl}/api/hub/detect/hint`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---- list_apps ------------------------------------------------------
  server.registerTool(
    'list_apps',
    {
      title: 'List Apps',
      description:
        'List every active app in the Floom hub. Filter by exact category, optionally filter by case-insensitive keyword (matches name + description). Returns slug, name, description, actions, permalink, and mcp_url.',
      inputSchema: {
        category: z
          .string()
          .max(48)
          .optional()
          .describe('Exact category filter (e.g. "productivity", "data").'),
        keyword: z
          .string()
          .max(120)
          .optional()
          .describe('Case-insensitive substring match on name + description.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max results. Defaults to 50.'),
      },
    },
    async ({ category, keyword, limit }) => {
      const lim = typeof limit === 'number' ? limit : 50;
      // MCP list_apps is a public admin surface — only expose public apps.
      // Private apps are owner-only and never show up in gallery-wide listings.
      let sql =
        "SELECT * FROM apps WHERE status = 'active'" +
        " AND (visibility = 'public' OR visibility IS NULL)" +
        (category ? ' AND category = ?' : '') +
        ' ORDER BY featured DESC, name ASC';
      const rows = (category
        ? db.prepare(sql).all(category)
        : db.prepare(sql).all()) as AppRecord[];
      // Issue #144: strip E2E / PRR / audit test fixtures from MCP gallery
      // listings so Claude Desktop + Cursor clients don't surface them in
      // discovery. Same regex as server /api/hub. Fixtures are still
      // accessible via `get_app` with the explicit slug.
      const rowsNoFixtures = filterTestFixtures(rows);
      const needle = typeof keyword === 'string' ? keyword.toLowerCase() : null;
      const filtered = needle
        ? rowsNoFixtures.filter((r) =>
            `${r.name} ${r.description}`.toLowerCase().includes(needle),
          )
        : rowsNoFixtures;
      const results = filtered.slice(0, lim).map((row) =>
        serializeHubApp(row, safeParseManifest(row.manifest), baseUrl),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { total: filtered.length, returned: results.length, apps: results },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---- search_apps (admin copy) --------------------------------------
  server.registerTool(
    'search_apps',
    {
      title: 'Search Apps',
      description:
        'Natural-language search across the Floom hub. Uses OpenAI embeddings when OPENAI_API_KEY is set on the server; falls back to keyword scoring otherwise. Returns the top N matches with slug, name, confidence (0..1), and mcp_url.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'Free-form description of what you need. Example: "summarize a YouTube video" or "generate a QR code".',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max results. Defaults to 5.'),
      },
    },
    async ({ query, limit }) => {
      const results = await pickApps(query, limit ?? 5);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              results.map((r) => ({
                ...r,
                permalink: `${baseUrl}/p/${r.slug}`,
                mcp_url: `${baseUrl}/mcp/app/${r.slug}`,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---- get_app --------------------------------------------------------
  server.registerTool(
    'get_app',
    {
      title: 'Get App',
      description:
        'Fetch a single app by slug. Returns the full manifest including every action with its input schema, outputs, and required secrets.',
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .max(48)
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .describe('The app slug (e.g. "petstore", "qr-code").'),
      },
    },
    async ({ slug }) => {
      const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as
        | AppRecord
        | undefined;
      if (!row) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'not_found', slug, message: `App not found: ${slug}` },
                null,
                2,
              ),
            },
          ],
        };
      }
      const manifest = safeParseManifest(row.manifest);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...serializeHubApp(row, manifest, baseUrl),
                manifest,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

function createSearchMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({
    name: 'floom-chat-search',
    version: '0.3.0',
  });
  server.registerTool(
    'search_apps',
    {
      title: 'Search Apps',
      description:
        'Search the Floom app gallery by natural language. Returns matching apps with slug, name, and MCP URL.',
      inputSchema: {
        query: z.string().describe('Natural language description of what you need'),
        limit: z.number().optional().describe('Max results (default 5)'),
      },
    },
    async ({ query, limit }) => {
      const results = await pickApps(query, limit ?? 5);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              results.map((r) => ({
                ...r,
                mcp_url: `${baseUrl}/mcp/app/${r.slug}`,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  return server;
}

async function handleMcp(server: McpServer, rawRequest: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(rawRequest);
}

// /mcp — admin surface (ingest_app, list_apps, search_apps, get_app).
// Registered ahead of /app/:slug so Hono does not route a bare /mcp to the
// per-app handler as the empty slug "".
mcpRouter.all('/', async (c: Context) => {
  const ctx = await resolveUserContext(c);
  const ip = extractIp(c);
  const baseUrl = getPublicBaseUrl(c);
  const server = createAdminMcpServer({ ctx, ip, baseUrl });
  return handleMcp(server, c.req.raw);
});

// /mcp/search — gallery-wide search
mcpRouter.all('/search', async (c) => {
  const baseUrl = getPublicBaseUrl(c);
  const server = createSearchMcpServer(baseUrl);
  return handleMcp(server, c.req.raw);
});

// /mcp/app/:slug — per-app MCP
mcpRouter.all('/app/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!row) {
    // Wrap unknown-app errors in a JSON-RPC envelope so MCP clients see a
    // protocol-level error, not a bare HTTP 404. Return 200 per JSON-RPC
    // convention — the error is in the envelope.
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: `App not found: ${slug}` },
        id: null,
      },
      200,
    );
  }
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, row.visibility || 'public', {
    author: row.author,
    ctx,
  });
  if (blocked) return blocked;
  // Reuse the ctx we already resolved for the visibility check. The MCP
  // tool handler forwards it to dispatchRun so per-user vault secrets
  // reach the runner, matching POST /api/run + POST /api/:slug/run.
  const server = createPerAppMcpServer(row, ctx);
  return handleMcp(server, c.req.raw);
});
