import { Hono } from 'hono';
import { z } from 'zod';

import { requireAuthenticatedInCloud } from '../lib/auth.js';
import { resolveUserContext } from '../services/session.js';
import {
  createGithubBuild,
  createGithubRebuildFromWebhook,
  formatGithubBuild,
  getGithubBuild,
  GithubDeployError,
  verifyGithubWebhookSignature,
} from '../services/github-deploy.js';

export const studioBuildRouter = new Hono();

const FromGithubBody = z.object({
  github_url: z.string().min(1).max(2048),
  branch: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  manifest_path: z.string().min(1).max(240).optional(),
});

studioBuildRouter.post('/from-github', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const parsed = FromGithubBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        code: 'invalid_body',
        issues: parsed.error.flatten(),
      },
      400,
    );
  }

  try {
    const build = await createGithubBuild({
      ...parsed.data,
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
    });
    return c.json(
      {
        slug: build.app_slug,
        build_id: build.build_id,
        status: 'publishing',
        edit_url: build.app_slug ? `/studio/apps/${build.app_slug}` : null,
      },
      202,
    );
  } catch (err) {
    if (err instanceof GithubDeployError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          ...(err.code === 'manifest_picker' &&
          err.details &&
          typeof err.details === 'object' &&
          'manifest_paths' in err.details
            ? { manifest_paths: (err.details as { manifest_paths: string[] }).manifest_paths }
            : {}),
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        err.status as 400 | 403 | 409 | 422 | 502,
      );
    }
    throw err;
  }
});

studioBuildRouter.get('/:build_id', (c) => {
  const buildId = c.req.param('build_id');
  const build = getGithubBuild(buildId);
  if (!build) {
    return c.json({ error: 'Build not found', code: 'not_found' }, 404);
  }
  return c.json(formatGithubBuild(build));
});

studioBuildRouter.post('/github-webhook', async (c) => {
  const event = c.req.header('x-github-event') || c.req.header('X-GitHub-Event') || '';
  const body = await c.req.text();
  const sig =
    c.req.header('x-hub-signature-256') ||
    c.req.header('X-Hub-Signature-256') ||
    null;

  if (!verifyGithubWebhookSignature(body, sig)) {
    return c.json({ error: 'Invalid signature', code: 'bad_signature' }, 401);
  }

  if (event && event !== 'push') {
    return c.json({ ok: true, ignored: true, reason: 'not_push' }, 200);
  }

  try {
    const result = await createGithubRebuildFromWebhook(body);
    if (result.ignored) {
      return c.json({ ok: true, ignored: true, reason: result.reason }, 200);
    }
    return c.json(
      {
        ok: true,
        build_id: result.build.build_id,
        status: 'publishing',
        slug: result.build.app_slug,
      },
      202,
    );
  } catch (err) {
    if (err instanceof GithubDeployError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 422);
    }
    throw err;
  }
});
