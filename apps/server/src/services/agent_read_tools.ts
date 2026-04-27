import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Context } from 'hono';
import { adapters } from '../adapters/index.js';
import { newRunId } from '../lib/ids.js';
import {
  extractByokInputSecret,
  extractUserApiKey,
  runByokGate,
  runGate,
  type RunGateResult,
} from '../lib/run-gate.js';
import { isByokGated } from '../lib/byok-gate.js';
import { validateInputs, ManifestError } from './manifest.js';
import { dispatchRun, getRun } from './runner.js';
import type {
  AppRecord,
  NormalizedManifest,
  RunRecord,
  SessionContext,
} from '../types.js';

export type AgentToolErrorCode =
  | 'auth_required'
  | 'forbidden_scope'
  | 'not_found'
  | 'not_accessible'
  | 'invalid_input'
  | 'rate_limit_exceeded'
  | 'request_body_too_large'
  | 'byok_required'
  | 'runtime_error';

export class AgentToolError extends Error {
  code: AgentToolErrorCode;
  status: number;
  details?: unknown;
  headers?: Record<string, string>;

  constructor(
    code: AgentToolErrorCode,
    message: string,
    status: number,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export interface DiscoverAppsArgs {
  category?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface RunAppArgs {
  slug: string;
  action?: string;
  inputs?: Record<string, unknown>;
}

function throwRunGateError(gate: Exclude<RunGateResult, { ok: true }>): never {
  const code =
    typeof gate.body.error === 'string'
      ? (gate.body.error as AgentToolErrorCode)
      : 'runtime_error';
  const message =
    typeof gate.body.message === 'string'
      ? gate.body.message
      : code === 'rate_limit_exceeded'
        ? 'Rate limit exceeded.'
        : 'Run request rejected.';
  throw new AgentToolError(code, message, gate.status, gate.body, gate.headers);
}

export interface ListRunsArgs {
  slug?: string;
  limit?: number;
  cursor?: string;
  since_ts?: string;
}

export function requireAgentContext(ctx: SessionContext): void {
  if (!ctx.agent_token_id || !ctx.agent_token_scope) {
    throw new AgentToolError(
      'auth_required',
      'Authorization: Bearer floom_agent_<token> is required.',
      401,
    );
  }
}

function requireReadScope(ctx: SessionContext): void {
  requireAgentContext(ctx);
  if (ctx.agent_token_scope === 'read' || ctx.agent_token_scope === 'read-write') {
    return;
  }
  throw new AgentToolError(
    'forbidden_scope',
    'This tool requires read or read-write agent-token scope.',
    403,
  );
}

function requireAnyAgentScope(ctx: SessionContext): void {
  requireAgentContext(ctx);
}

function isPublicLive(app: AppRecord): boolean {
  const visibility = app.visibility || 'public';
  const publishStatus = app.publish_status || 'published';
  return (
    app.status === 'active' &&
    (visibility === 'public' || visibility === null) &&
    publishStatus === 'published'
  );
}

function isOwnedByContext(app: AppRecord, ctx: SessionContext): boolean {
  return (
    app.workspace_id === ctx.workspace_id &&
    app.author !== null &&
    app.author === ctx.user_id
  );
}

function canDiscoverApp(app: AppRecord, ctx: SessionContext): boolean {
  if (isPublicLive(app)) return true;
  return isOwnedByContext(app, ctx);
}

function canRunApp(app: AppRecord, ctx: SessionContext): boolean {
  if (ctx.agent_token_scope === 'read' && isPublicLive(app)) return true;
  if (ctx.agent_token_scope === 'read-write') {
    return isPublicLive(app) || isOwnedByContext(app, ctx);
  }
  return false;
}

function visibilityLabel(app: AppRecord): string {
  if (isPublicLive(app)) return 'public_live';
  return app.visibility || 'public';
}

function parseManifest(app: AppRecord): NormalizedManifest {
  try {
    return JSON.parse(app.manifest) as NormalizedManifest;
  } catch {
    throw new AgentToolError(
      'runtime_error',
      'App manifest is corrupted.',
      500,
    );
  }
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function encodeCursor(startedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ started_at: startedAt, id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | undefined): { started_at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      started_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.started_at === 'string' && typeof parsed.id === 'string') {
      return { started_at: parsed.started_at, id: parsed.id };
    }
  } catch {
    return null;
  }
  throw new AgentToolError('invalid_input', 'Invalid cursor.', 400);
}

function runStartedMs(run: Pick<RunRecord, 'started_at'>): number {
  const normalized = run.started_at.includes('T')
    ? run.started_at
    : run.started_at.replace(' ', 'T');
  const parsed = Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicBaseUrl(c: Context): string {
  const override = process.env.FLOOM_PUBLIC_ORIGIN || process.env.PUBLIC_URL || '';
  if (override.trim()) return override.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return 'https://floom.dev';
  }
}

function appSummary(app: AppRecord, baseUrl: string): Record<string, unknown> {
  const manifest = parseManifest(app);
  return {
    slug: app.slug,
    name: app.name,
    description: app.description,
    category: app.category,
    visibility: visibilityLabel(app),
    runtime: manifest.runtime,
    public_link: `${baseUrl}/p/${app.slug}`,
  };
}

export async function discoverApps(
  c: Context,
  ctx: SessionContext,
  args: DiscoverAppsArgs,
): Promise<Record<string, unknown>> {
  requireReadScope(ctx);
  const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
  const offset = args.cursor ? Number(args.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AgentToolError('invalid_input', 'cursor must be a non-negative offset.', 400);
  }
  const rows = (await adapters.storage.listApps())
    .filter((app) => {
      if (app.status !== 'active') return false;
      const publishedPublic =
        (app.visibility === 'public' || app.visibility === null) &&
        app.publish_status === 'published';
      const owned = app.workspace_id === ctx.workspace_id && app.author === ctx.user_id;
      return publishedPublic || owned;
    })
    .sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        a.name.localeCompare(b.name) ||
        a.slug.localeCompare(b.slug),
    );
  const needle = typeof args.q === 'string' ? args.q.trim().toLowerCase() : '';
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  const filtered = rows.filter((app) => {
    if (!canDiscoverApp(app, ctx)) return false;
    if (category && app.category !== category) return false;
    if (needle) {
      const haystack = `${app.slug} ${app.name} ${app.description}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    apps: page.map((app) => appSummary(app, publicBaseUrl(c))),
    next_cursor: nextOffset < filtered.length ? String(nextOffset) : null,
  };
}

async function loadAccessibleApp(ctx: SessionContext, slug: string): Promise<AppRecord> {
  const app = await adapters.storage.getApp(slug);
  if (!app || app.status !== 'active') {
    throw new AgentToolError('not_found', `App not found: ${slug}`, 404);
  }
  if (!canDiscoverApp(app, ctx)) {
    throw new AgentToolError(
      'not_accessible',
      `App is not accessible to this agent token: ${slug}`,
      403,
    );
  }
  return app;
}

export async function getAppSkill(
  c: Context,
  ctx: SessionContext,
  slug: string,
): Promise<Record<string, unknown>> {
  requireReadScope(ctx);
  const app = await loadAccessibleApp(ctx, slug);
  const manifest = parseManifest(app);
  const actionNames = Object.keys(manifest.actions);
  const action =
    (manifest.primary_action && manifest.actions[manifest.primary_action]
      ? manifest.primary_action
      : null) ||
    (manifest.actions.run ? 'run' : actionNames[0]) ||
    'run';
  const baseUrl = publicBaseUrl(c);
  const skillMd = [
    `# ${app.name}`,
    '',
    app.description,
    '',
    `Slug: \`${app.slug}\``,
    `Primary action: \`${action}\``,
    `MCP: \`${baseUrl}/mcp/app/${app.slug}\``,
    `HTTP: \`${baseUrl}/api/${app.slug}/run\``,
    '',
    'Call this app through Floom with `{ action, inputs }`.',
    '',
  ].join('\n');
  return {
    slug: app.slug,
    skill_md: skillMd,
    etag: createHash('sha256').update(skillMd).digest('hex'),
  };
}

export async function runApp(
  c: Context,
  ctx: SessionContext,
  args: RunAppArgs,
): Promise<Record<string, unknown>> {
  requireReadScope(ctx);
  const gate = runGate(c, ctx, { slug: args.slug });
  if (!gate.ok) throwRunGateError(gate);

  const app = await loadAccessibleApp(ctx, args.slug);
  if (!canRunApp(app, ctx)) {
    throw new AgentToolError(
      'forbidden_scope',
      'This agent token cannot run that app.',
      403,
    );
  }
  const manifest = parseManifest(app);
  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof args.action === 'string' && args.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]) ||
    'run';
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    throw new AgentToolError(
      'invalid_input',
      `Action "${actionName}" not found.`,
      400,
    );
  }

  const rawInputs = args.inputs ?? {};
  const byokInput = isByokGated(app.slug)
    ? extractByokInputSecret(rawInputs)
    : { apiKey: null, inputs: rawInputs };
  const byok = await runByokGate(
    c,
    ctx,
    app.slug,
    extractUserApiKey(c) ?? byokInput.apiKey,
    { allowUserVaultKey: true },
  );
  if (!byok.ok) throwRunGateError(byok);

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(actionSpec, byokInput.inputs);
  } catch (err) {
    const e = err as ManifestError;
    throw new AgentToolError('invalid_input', e.message, 400, { field: e.field });
  }

  const runId = newRunId();
  await adapters.storage.createRun({
    id: runId,
    app_id: app.id,
    thread_id: null,
    action: actionName,
    inputs: validated,
    workspace_id: ctx.workspace_id,
    user_id: ctx.user_id,
    device_id: ctx.device_id,
  });
  await dispatchRun(app, manifest, runId, actionName, validated, byok.perCallSecrets, ctx);
  const fresh = await waitForRun(runId);
  return formatAgentRun(fresh, app.slug, manifest.runtime);
}

async function waitForRun(runId: string): Promise<RunRecord> {
  const maxWaitMs = 10 * 60 * 1000;
  const pollIntervalMs = 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const row = await getRun(runId);
    if (!row) throw new AgentToolError('not_found', 'Run not found.', 404);
    if (row.status === 'success' || row.status === 'error' || row.status === 'timeout') {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const row = await getRun(runId);
  if (!row) throw new AgentToolError('not_found', 'Run not found.', 404);
  return row;
}

function formatAgentRun(
  run: RunRecord | undefined,
  slug: string,
  runtime?: string,
): Record<string, unknown> {
  if (!run) {
    throw new AgentToolError('not_found', 'Run not found.', 404);
  }
  return {
    run_id: run.id,
    slug,
    action: run.action,
    status: run.status,
    output: safeParse(run.outputs),
    error: run.error,
    error_type: run.error_type,
    dry_run: false,
    model: runtime || null,
    duration_ms: run.duration_ms,
    started_at: run.started_at,
    completed_at: run.finished_at,
  };
}

export async function getAgentRun(
  ctx: SessionContext,
  runId: string,
): Promise<Record<string, unknown>> {
  requireReadScope(ctx);
  const row = await adapters.storage.getRun(runId);
  if (!row) throw new AgentToolError('not_found', 'Run not found.', 404);
  const app = await adapters.storage.getAppById(row.app_id);
  if (!app) throw new AgentToolError('not_found', 'App not found.', 404);
  const owner =
    row.workspace_id === ctx.workspace_id &&
    row.user_id !== null &&
    row.user_id === ctx.user_id;
  const publicLiveRun =
    row.is_public === 1 &&
    app.status === 'active' &&
    (app.visibility === 'public' || app.visibility === null) &&
    app.publish_status === 'published';
  if (!owner && !publicLiveRun) {
    throw new AgentToolError('not_accessible', 'Run is not accessible.', 403);
  }
  let runtime: string | undefined;
  try {
    runtime = (JSON.parse(app.manifest) as NormalizedManifest).runtime;
  } catch {
    runtime = undefined;
  }
  return formatAgentRun(row, app.slug, runtime);
}

export async function listMyRuns(
  ctx: SessionContext,
  args: ListRunsArgs,
): Promise<Record<string, unknown>> {
  requireAnyAgentScope(ctx);
  const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
  const cursor = decodeCursor(args.cursor);
  const slugApp = args.slug ? await adapters.storage.getApp(args.slug) : undefined;
  if (args.slug) {
    if (!slugApp) return { runs: [], next_cursor: null };
  }
  const sinceMs = args.since_ts ? Date.parse(args.since_ts) : null;
  const cursorMs = cursor ? runStartedMs({ started_at: cursor.started_at }) : null;
  const rows = (
    await adapters.storage.listRuns({
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      ...(slugApp ? { app_id: slugApp.id } : {}),
    })
  )
    .filter((run) => {
      const started = runStartedMs(run);
      if (sinceMs !== null && Number.isFinite(sinceMs) && started < sinceMs) return false;
      if (cursor && cursorMs !== null) {
        if (started > cursorMs) return false;
        if (started === cursorMs && run.id >= cursor.id) return false;
      }
      return true;
    })
    .sort((a, b) => runStartedMs(b) - runStartedMs(a) || b.id.localeCompare(a.id))
    .slice(0, limit + 1);
  const appById = new Map(
    (
      await Promise.all(
        [...new Set(rows.map((run) => run.app_id))].map(
          async (appId) => [appId, await adapters.storage.getAppById(appId)] as const,
        ),
      )
    ).filter((entry) => !!entry[1]),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map((run) => ({
      run_id: run.id,
      slug: appById.get(run.app_id)?.slug ?? null,
      action: run.action,
      status: run.status,
      started_at: run.started_at,
      completed_at: run.finished_at,
      duration_ms: run.duration_ms,
      dry_run: false,
    })),
    next_cursor:
      rows.length > limit && last ? encodeCursor(last.started_at, last.id) : null,
  };
}

export function agentToolErrorBody(err: unknown): {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
} {
  if (err instanceof AgentToolError) {
    const details =
      err.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : null;
    return {
      status: err.status,
      headers: err.headers,
      body: {
        ...(details ?? {}),
        error: err.code,
        message: err.message,
        details: err.details ?? undefined,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: 'runtime_error',
      message: err instanceof Error ? err.message : 'Unexpected error.',
    },
  };
}
