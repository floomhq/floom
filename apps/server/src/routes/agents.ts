import { Hono } from 'hono';
import { parseJsonBody, bodyParseError } from '../lib/body.js';
import { runGate } from '../lib/run-gate.js';
import { resolveUserContext } from '../services/session.js';
import {
  AgentToolError,
  agentToolErrorBody,
  discoverApps,
  getAgentRun,
  getAppSkill,
  listMyRuns,
  runApp,
} from '../services/agent_read_tools.js';

export const agentsRouter = new Hono();

function numericLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function jsonError(
  body: Record<string, unknown>,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
  });
}

agentsRouter.get('/apps', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    return c.json(
      await discoverApps(c, ctx, {
        category: c.req.query('category'),
        q: c.req.query('q'),
        limit: numericLimit(c.req.query('limit')),
        cursor: c.req.query('cursor'),
      }),
    );
  } catch (err) {
    const { status, body, headers } = agentToolErrorBody(err);
    return jsonError(body, status, headers);
  }
});

agentsRouter.post('/run', async (c) => {
  const ctx = await resolveUserContext(c);
  const bodyGate = runGate(c, ctx, { checkRate: false });
  if (!bodyGate.ok) return c.json(bodyGate.body, bodyGate.status, bodyGate.headers);
  const parsed = await parseJsonBody(c);
  if (parsed.kind === 'error') return bodyParseError(c, parsed);
  const body = parsed.value as {
    slug?: unknown;
    action?: unknown;
    inputs?: unknown;
  };
  try {
    if (typeof body.slug !== 'string' || body.slug.length === 0) {
      throw new AgentToolError('invalid_input', 'slug is required', 400);
    }
    const inputs =
      body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};
    return c.json(
      await runApp(c, ctx, {
        slug: body.slug,
        action: typeof body.action === 'string' ? body.action : undefined,
        inputs,
      }),
    );
  } catch (err) {
    const { status, body: errorBody, headers } = agentToolErrorBody(err);
    return jsonError(errorBody, status, headers);
  }
});

agentsRouter.get('/runs', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    return c.json(
      await listMyRuns(ctx, {
        slug: c.req.query('slug'),
        limit: numericLimit(c.req.query('limit')),
        cursor: c.req.query('cursor'),
        since_ts: c.req.query('since_ts'),
      }),
    );
  } catch (err) {
    const { status, body, headers } = agentToolErrorBody(err);
    return jsonError(body, status, headers);
  }
});

agentsRouter.get('/runs/:run_id', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    return c.json(await getAgentRun(ctx, c.req.param('run_id')));
  } catch (err) {
    const { status, body, headers } = agentToolErrorBody(err);
    return jsonError(body, status, headers);
  }
});

agentsRouter.get('/apps/:slug/skill', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    return c.json(await getAppSkill(c, ctx, c.req.param('slug')));
  } catch (err) {
    const { status, body, headers } = agentToolErrorBody(err);
    return jsonError(body, status, headers);
  }
});
