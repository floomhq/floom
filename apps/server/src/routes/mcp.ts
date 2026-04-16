// MCP per-app endpoints. /mcp/app/:slug exposes that app's actions as MCP tools.
// Trimmed port of the marketplace's mcp.ts — only the per-app path remains.
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
import { checkAppVisibility } from '../lib/auth.js';
import type {
  ActionSpec,
  AppRecord,
  InputSpec,
  NormalizedManifest,
  RunRecord,
} from '../types.js';

export const mcpRouter = new Hono();

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://preview.floom.dev';

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

function createPerAppMcpServer(app: AppRecord): McpServer {
  const manifest = JSON.parse(app.manifest) as NormalizedManifest;
  const server = new McpServer({
    name: `floom-chat-${app.slug}`,
    version: '0.3.0',
  });

  const secretsNeeded = manifest.secrets_needed || [];

  for (const [actionName, actionSpec] of Object.entries(manifest.actions) as Array<
    [string, ActionSpec]
  >) {
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
        inputSchema: buildZodSchema(actionSpec.inputs, secretsNeeded),
      },
      async (rawInputs) => {
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
        if (secretsNeeded.length > 0) {
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

          const missing = secretsNeeded.filter((n) => !available.has(n));
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
        dispatchRun(
          fresh,
          freshManifest,
          runId,
          actionName,
          validated,
          perCallSecrets,
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

function createSearchMcpServer(): McpServer {
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
                mcp_url: `${PUBLIC_URL}/mcp/app/${r.slug}`,
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

// /mcp/search — gallery-wide search
mcpRouter.all('/search', async (c) => {
  const server = createSearchMcpServer();
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
  const blocked = checkAppVisibility(c, row.visibility || 'public');
  if (blocked) return blocked;
  const server = createPerAppMcpServer(row);
  return handleMcp(server, c.req.raw);
});
