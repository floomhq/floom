import { db } from '../db.js';
import { newAppId, newAppInstallId } from '../lib/ids.js';
import { auditLog } from './audit-log.js';
import { canAccessApp } from './sharing.js';
import type { AppRecord, SessionContext } from '../types.js';

export class AppLibraryError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppLibraryError';
    this.status = status;
    this.code = code;
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

function appBySlug(slug: string): AppRecord {
  const app = db.prepare(`SELECT * FROM apps WHERE slug = ?`).get(slug) as AppRecord | undefined;
  if (!app) throw new AppLibraryError(404, 'not_found', 'App not found');
  return app;
}

function uniqueSlug(base: string): string {
  const stem = slugify(base).slice(0, 40) || 'app';
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? stem : `${stem}-${i + 1}`;
    const hit = db.prepare(`SELECT 1 FROM apps WHERE slug = ?`).get(candidate);
    if (!hit) return candidate;
  }
  throw new AppLibraryError(409, 'slug_unavailable', 'Could not derive an available slug');
}

function publicOrOwned(app: AppRecord, ctx: SessionContext, linkToken?: string | null): boolean {
  return canAccessApp(app, ctx, linkToken);
}

function isInstallable(app: AppRecord): boolean {
  return (
    app.visibility === 'public_live' ||
    (app.visibility === 'public' && app.publish_status === 'published')
  );
}

export function forkApp(
  ctx: SessionContext,
  sourceSlug: string,
  options: { slug?: string; name?: string; linkToken?: string | null } = {},
): { app: AppRecord; created: true; source: AppRecord } {
  const source = appBySlug(sourceSlug);
  if (!publicOrOwned(source, ctx, options.linkToken)) {
    throw new AppLibraryError(404, 'not_found', 'App not found');
  }
  const slug = uniqueSlug(options.slug || `${source.slug}-fork`);
  const name = options.name || `${source.name} Fork`;
  const id = newAppId();
  db.prepare(
    `INSERT INTO apps (
       id, slug, name, description, manifest, status, docker_image, code_path,
       category, author, icon, app_type, base_url, auth_type, auth_config,
       openapi_spec_url, openapi_spec_cached, visibility, link_share_requires_auth,
       link_share_token, is_async, webhook_url, timeout_ms, retries, async_mode,
       max_run_retention_days, run_rate_limit_per_hour, workspace_id,
       publish_status, thumbnail_url, forked_from_app_id
     ) VALUES (
       ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, 'private', 0,
       NULL, ?, ?, ?, ?, ?,
       ?, ?, ?,
       'pending_review', ?, ?
     )`,
  ).run(
    id,
    slug,
    name,
    source.description,
    source.manifest,
    source.docker_image,
    source.app_type === 'proxied' ? `proxied:${slug}` : source.code_path,
    source.category,
    ctx.user_id,
    source.icon,
    source.app_type,
    source.base_url,
    source.auth_type,
    source.auth_config,
    source.openapi_spec_url,
    source.openapi_spec_cached,
    source.is_async,
    source.webhook_url,
    source.timeout_ms,
    source.retries,
    source.async_mode,
    source.max_run_retention_days,
    source.run_rate_limit_per_hour,
    ctx.workspace_id,
    source.thumbnail_url,
    source.id,
  );
  const app = db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id) as AppRecord;
  auditLog({
    actor: { userId: ctx.user_id, tokenId: ctx.agent_token_id || null },
    action: 'app.forked',
    target: { type: 'app', id },
    before: null,
    after: { slug, forked_from_app_id: source.id, workspace_id: ctx.workspace_id },
    metadata: { source_slug: source.slug },
  });
  return { app, created: true, source };
}

export function claimApp(ctx: SessionContext, slug: string): { app: AppRecord; claimed: true } {
  const app = appBySlug(slug);
  const claimable =
    (app.author === null || app.author === 'local') &&
    (app.workspace_id === null || app.workspace_id === 'local') &&
    !app.claimed_at;
  if (!claimable) {
    throw new AppLibraryError(409, 'already_owned', 'App is already owned');
  }
  db.prepare(
    `UPDATE apps
        SET author = ?,
            workspace_id = ?,
            visibility = 'private',
            link_share_token = NULL,
            link_share_requires_auth = 0,
            claimed_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(ctx.user_id, ctx.workspace_id, app.id);
  const claimed = db.prepare(`SELECT * FROM apps WHERE id = ?`).get(app.id) as AppRecord;
  auditLog({
    actor: { userId: ctx.user_id, tokenId: ctx.agent_token_id || null },
    action: 'app.claimed',
    target: { type: 'app', id: app.id },
    before: { author: app.author, workspace_id: app.workspace_id },
    after: { author: ctx.user_id, workspace_id: ctx.workspace_id, visibility: 'private' },
    metadata: { slug },
  });
  return { app: claimed, claimed: true };
}

export function installApp(ctx: SessionContext, slug: string): { installed: boolean; app: AppRecord } {
  const app = appBySlug(slug);
  if (!isInstallable(app)) {
    throw new AppLibraryError(404, 'not_found', 'App not found');
  }
  const existing = db
    .prepare(`SELECT id FROM app_installs WHERE app_id = ? AND workspace_id = ? AND user_id = ?`)
    .get(app.id, ctx.workspace_id, ctx.user_id) as { id: string } | undefined;
  if (existing) return { installed: false, app };
  db.prepare(
    `INSERT INTO app_installs (id, app_id, workspace_id, user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(newAppInstallId(), app.id, ctx.workspace_id, ctx.user_id);
  auditLog({
    actor: { userId: ctx.user_id, tokenId: ctx.agent_token_id || null },
    action: 'app.installed',
    target: { type: 'app', id: app.id },
    before: null,
    after: { slug: app.slug, workspace_id: ctx.workspace_id },
  });
  return { installed: true, app };
}

export function uninstallApp(ctx: SessionContext, slug: string): { removed: boolean; app: AppRecord } {
  const app = appBySlug(slug);
  const result = db
    .prepare(`DELETE FROM app_installs WHERE app_id = ? AND workspace_id = ? AND user_id = ?`)
    .run(app.id, ctx.workspace_id, ctx.user_id);
  auditLog({
    actor: { userId: ctx.user_id, tokenId: ctx.agent_token_id || null },
    action: 'app.uninstalled',
    target: { type: 'app', id: app.id },
    before: { installed: result.changes > 0 },
    after: null,
    metadata: { slug: app.slug, workspace_id: ctx.workspace_id },
  });
  return { removed: result.changes > 0, app };
}

export function listInstalledApps(ctx: SessionContext): AppRecord[] {
  return db
    .prepare(
      `SELECT apps.*
         FROM app_installs
         JOIN apps ON apps.id = app_installs.app_id
        WHERE app_installs.workspace_id = ?
          AND app_installs.user_id = ?
        ORDER BY app_installs.installed_at DESC`,
    )
    .all(ctx.workspace_id, ctx.user_id) as AppRecord[];
}

export function isInstalled(ctx: SessionContext, appId: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM app_installs WHERE app_id = ? AND workspace_id = ? AND user_id = ?`)
    .get(appId, ctx.workspace_id, ctx.user_id);
  return Boolean(row);
}
