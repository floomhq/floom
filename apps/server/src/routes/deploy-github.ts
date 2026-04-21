/**
 * POST /api/deploy-github
 *
 * Clones a public GitHub repo, auto-detects its runtime, builds a Docker
 * image via Ax41DockerProvider, smoke-tests it, and registers the resulting
 * app in the SQLite `apps` table. Build logs stream back to the browser as
 * Server-Sent Events so the creator sees live progress.
 *
 * SSE events:
 *   { event: 'log',   data: { text: string } }
 *   { event: 'done',  data: { slug: string; app_url: string } }
 *   { event: 'error', data: { message: string; draft_manifest?: string } }
 *
 * Rate limited: 5 deploys / user / day (FLOOM_RATE_LIMIT_DEPLOY_PER_DAY).
 * Auth: required in cloud mode (requireAuthenticatedInCloud).
 *
 * Issue #234 — repo→hosted pipeline.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import { extractIp, checkDeployLimit } from '../lib/rate-limit.js';
import { newAppId } from '../lib/ids.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import type { NormalizedManifest, InputSpec, OutputSpec } from '../types.js';
import type { Manifest as RuntimeManifest, Input as RuntimeInput } from '@floom/runtime';
import { deployFromGithub, Ax41DockerProvider } from '@floom/runtime';

export const deployGithubRouter = new Hono();

// ---------- manifest conversion ----------

/**
 * Map a runtime Input.type to the NormalizedManifest InputSpec.type.
 * The server's InputType is the UI-visible form type; the runtime uses
 * a smaller set.
 */
function mapInputType(rt: RuntimeInput['type']): InputSpec['type'] {
  switch (rt) {
    case 'string':  return 'text';
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'file':    return 'file';
    case 'json':    return 'textarea';
    default:        return 'text';
  }
}

/**
 * Convert a runtime Manifest (from deployFromGithub) into the
 * NormalizedManifest shape the server stores and the UI renders.
 * Produces a single action named "run".
 */
function toNormalizedManifest(m: RuntimeManifest): NormalizedManifest {
  const inputs: InputSpec[] = m.inputs.map((i) => ({
    name: i.name,
    type: mapInputType(i.type),
    label: i.label ?? i.name,
    required: i.required ?? false,
    default: i.default,
    description: i.description,
    placeholder: i.placeholder,
  }));

  // Map the single output to an OutputSpec.
  const outType = m.outputs.type;
  const output: OutputSpec = {
    name: 'output',
    type:
      outType === 'markdown' ? 'markdown'
      : outType === 'json'   ? 'json'
      : outType === 'html'   ? 'html'
      : outType === 'file'   ? 'file'
      : 'text',   // 'stdout' → 'text'
    label: 'Output',
  };

  return {
    name: m.name,
    description: m.description,
    runtime: m.runtime.startsWith('python') ? 'python' : 'node',
    actions: {
      run: {
        label: 'Run',
        inputs,
        outputs: [output],
      },
    },
    secrets_needed: m.secrets ?? [],
    python_dependencies: [],
    node_dependencies: {},
    manifest_version: '2.0',
  };
}

/**
 * Derive a slug from a manifest name. Lowercases, replaces spaces/underscores
 * with hyphens, strips non-alphanumeric characters, deduplicates hyphens.
 */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'hosted-app';
}

/**
 * Make a slug unique: if `base` already exists in the apps table, append
 * a numeric suffix (-2, -3, …) until it's free. Returns the unique slug.
 */
function resolveUniqueSlug(base: string): string {
  const exists = (s: string) =>
    !!(db.prepare('SELECT 1 FROM apps WHERE slug = ?').get(s));
  if (!exists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  // Fallback: append a random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- route ----------

deployGithubRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const ip = extractIp(c);
  const quota = checkDeployLimit(ctx, ip);
  if (!quota.allowed) {
    return c.json(
      {
        error: 'deploy_quota_exceeded',
        message: `You've hit the daily deploy limit. Try again in ${quota.retryAfterSec} seconds.`,
        retry_after_seconds: quota.retryAfterSec,
      },
      429,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }

  const { repo_url, ref } = (body ?? {}) as { repo_url?: string; ref?: string };
  if (!repo_url || typeof repo_url !== 'string') {
    return c.json({ error: 'repo_url is required', code: 'invalid_body' }, 400);
  }
  // Basic GitHub URL guard — the deploy pipeline will error more precisely
  // but we can save a round-trip for obviously bad input.
  if (!/github\.com/i.test(repo_url)) {
    return c.json({ error: 'Only public GitHub repos are supported', code: 'unsupported_host' }, 400);
  }

  const provider = new Ax41DockerProvider();
  const githubToken = process.env.GITHUB_TOKEN;

  // SSE stream: send build logs in real time, then one terminal event.
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    await send('log', { text: `[floom] Starting deploy for ${repo_url} …\n` });

    const result = await deployFromGithub(repo_url, {
      provider,
      ref: ref || undefined,
      githubToken,
      onLog: async (chunk) => {
        await send('log', { text: chunk });
      },
    });

    if (!result.success || !result.manifest || !result.artifactId) {
      await send('error', {
        message: result.error ?? 'Deploy failed',
        draft_manifest: result.draftManifest,
      });
      return;
    }

    // Persist the deployed app.
    const normalizedManifest = toNormalizedManifest(result.manifest);
    const baseSlug = slugify(result.manifest.name);
    const slug = resolveUniqueSlug(baseSlug);

    const existingRow = db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug) as
      | { id: string }
      | undefined;

    if (existingRow) {
      db.prepare(
        `UPDATE apps
         SET name=?, description=?, manifest=?, docker_image=?, code_path=?,
             category=?, author=?, app_type='docker', status='active',
             updated_at=datetime('now')
         WHERE slug=?`,
      ).run(
        result.manifest.displayName || result.manifest.name,
        result.manifest.description,
        JSON.stringify(normalizedManifest),
        result.artifactId,
        repo_url,
        result.manifest.category ?? null,
        result.manifest.creator ?? ctx.user_id,
        slug,
      );
    } else {
      const appId = newAppId();
      db.prepare(
        `INSERT INTO apps (
           id, slug, name, description, manifest, status,
           docker_image, code_path, category, author, icon,
           app_type, base_url, auth_type, auth_config,
           openapi_spec_url, openapi_spec_cached, visibility,
           is_async, webhook_url, timeout_ms, retries, async_mode,
           workspace_id
         ) VALUES (
           ?, ?, ?, ?, ?, 'active',
           ?, ?, ?, ?, NULL,
           'docker', NULL, 'none', NULL,
           NULL, NULL, 'public',
           0, NULL, NULL, 0, NULL,
           ?
         )`,
      ).run(
        appId,
        slug,
        result.manifest.displayName || result.manifest.name,
        result.manifest.description,
        JSON.stringify(normalizedManifest),
        result.artifactId,
        repo_url,
        result.manifest.category ?? null,
        result.manifest.creator ?? ctx.user_id,
        ctx.workspace_id,
      );
    }

    invalidateHubCache();

    await send('log', { text: `\n[floom] ✓ App published at /p/${slug}\n` });
    await send('done', {
      slug,
      app_url: `/p/${slug}`,
      artifact_id: result.artifactId,
      commit_sha: result.commitSha,
    });
  });
});
