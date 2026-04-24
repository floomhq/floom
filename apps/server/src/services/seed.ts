// Seed the local SQLite DB from apps/server/src/db/seed.json on boot.
// Idempotent: re-runs on every startup; new rows insert, existing rows refresh
// catalog fields from seed.json so manifest edits propagate without manual SQL.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { adapters } from '../adapters/index.js';
import { db } from '../db.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

/**
 * Probe the Docker daemon to confirm `image` exists locally. Used by the
 * seeder to skip bundled demo apps whose image hasn't been built on this
 * host (e.g. the 14 first-party apps with marketplace-minted images
 * like `floom-app-app_yyyzfrybsv:v1`). Without this guard, those apps
 * appeared in /api/hub, landed on the store grid, and every click
 * returned `floom_internal_error` because `docker.createContainer`
 * threw 404 at run time.
 *
 * Docker-unavailable (no socket, daemon down) → returns `false` and the
 * seeder skips the docker apps entirely. That matches the safer default:
 * don't ship apps that can't possibly run.
 */
async function dockerImageExists(image: string): Promise<boolean> {
  try {
    const docker = new Docker();
    const img = docker.getImage(image);
    await img.inspect();
    return true;
  } catch {
    return false;
  }
}

interface SeedApp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  author: string | null;
  docker_image: string;
  marketplace_app_id: string;
  manifest: NormalizedManifest;
}

interface SeedFile {
  generated_at: string;
  source: string;
  apps: SeedApp[];
  global_secrets: Record<string, string>;
  per_app_secrets: Record<string, Record<string, string>>;
}

function findSeedFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'db', 'seed.json'),
    join(here, '..', '..', 'src', 'db', 'seed.json'),
    join(process.cwd(), 'src', 'db', 'seed.json'),
    join(process.cwd(), 'apps', 'server', 'src', 'db', 'seed.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function seedFromFile(): Promise<{
  apps_added: number;
  secrets_added: number;
  apps_skipped_missing_image: number;
}> {
  // FLOOM_SEED_APPS gates the bundled docker-based demo apps. They require
  // /var/run/docker.sock mounted into the container AND can connect to a
  // host Docker daemon, so we default to OFF (empty hub) and let users
  // populate via apps.yaml. Set FLOOM_SEED_APPS=true to opt in.
  const seedEnabled = (() => {
    const v = process.env.FLOOM_SEED_APPS;
    if (v === undefined || v === '') return false;
    return /^(1|true|yes|on)$/i.test(v);
  })();
  if (!seedEnabled) {
    console.log(
      '[seed] FLOOM_SEED_APPS not set — starting with empty hub. Use apps.yaml to register apps.',
    );
    return { apps_added: 0, secrets_added: 0, apps_skipped_missing_image: 0 };
  }
  const path = findSeedFile();
  if (!path) {
    console.log('[seed] no seed.json found — skipping');
    return { apps_added: 0, secrets_added: 0, apps_skipped_missing_image: 0 };
  }
  const raw = readFileSync(path, 'utf-8');
  const seed = JSON.parse(raw) as SeedFile;
  console.log(`[seed] loading ${seed.apps.length} apps from ${path}`);
  console.log(
    '[seed] FLOOM_SEED_APPS is on — the bundled docker demo apps require /var/run/docker.sock to be mounted into the container.',
  );

  // Launch blocker fix (2026-04-20): every bundled seed app ships with a
  // marketplace-minted docker_image (e.g. `floom-app-app_yyyzfrybsv:v1`).
  // Those images aren't built into this OSS stack, so dispatching a run
  // used to throw `(HTTP code 404) no such container - No such image`
  // from dockerode, which the runner caught and re-labelled as
  // `floom_internal_error`. That label rendered as "Something broke
  // inside Floom" on /p/:slug — misleading, because the root cause is a
  // missing image, not a Floom runtime bug. We now probe each image
  // once at boot; any app whose image is absent is skipped entirely so
  // it never appears in /api/hub.
  //
  // Operators who want the first-party apps back should build the
  // matching images on the host (same tag as in seed.json) and restart
  // the server — the probe picks them up on the next boot.
  const imagesToCheck = Array.from(
    new Set(seed.apps.map((a) => a.docker_image).filter(Boolean)),
  );
  const imageAvailability = new Map<string, boolean>();
  await Promise.all(
    imagesToCheck.map(async (img) => {
      imageAvailability.set(img, await dockerImageExists(img));
    }),
  );
  const missingImages = imagesToCheck.filter((img) => !imageAvailability.get(img));
  if (missingImages.length > 0) {
    console.log(
      `[seed] ${missingImages.length}/${imagesToCheck.length} seed images are NOT present locally. Skipping those apps so the store only lists runnable apps.`,
    );
  }

  let appsAdded = 0;
  let secretsAdded = 0;
  let appsSkipped = 0;

  // Bundled seed apps ship as 'published' on first insert — they're first-party
  // content that already went through Federico's review. New user-ingested apps
  // go to 'pending_review' via services/openapi-ingest.ts / docker-image-ingest.ts.
  // Updates refresh seed-owned fields only; we do not overwrite
  // publish_status, stars, featured, hero, etc.
  //
  // Insert + refresh are now routed through `adapters.storage` (the
  // existing `existing` lookup already lets us branch deterministically,
  // so splitting the former `INSERT ... ON CONFLICT DO UPDATE` into two
  // adapter calls produces the same row state: existing rows get their
  // seed-owned columns refreshed, new rows are inserted with
  // publish_status='published'; non-seed columns (stars / featured /
  // hero / publish_status) are left untouched on the update path.
  const insertSecret = db.prepare(
    `INSERT OR IGNORE INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)`,
  );
  const existsBySlug = db.prepare('SELECT id FROM apps WHERE slug = ?');
  const markAppInactive = db.prepare(
    `UPDATE apps SET status = 'inactive' WHERE id = ?`,
  );

  const txn = db.transaction(() => {
    for (const app of seed.apps) {
      const existing = existsBySlug.get(app.slug) as { id: string } | undefined;
      const imageOk = !app.docker_image || imageAvailability.get(app.docker_image);

      // Image is absent on this host: skip the insert, and if a previous
      // boot had already inserted the row (e.g. before this guard landed),
      // mark it inactive so /api/hub (which filters on status='active')
      // stops surfacing it without losing any existing runs.
      if (!imageOk) {
        appsSkipped++;
        if (existing) {
          markAppInactive.run(existing.id);
          console.log(
            `[seed] ${app.slug}: image "${app.docker_image}" not found locally — marking inactive`,
          );
        } else {
          console.log(
            `[seed] ${app.slug}: image "${app.docker_image}" not found locally — not inserting`,
          );
        }
        continue;
      }

      const appId = existing ? existing.id : newAppId();
      // code_path is unused when docker_image is already set; we store
      // a placeholder so the NOT NULL constraint is satisfied.
      const codePath = `reused:${app.marketplace_app_id}`;
      const manifestJson = JSON.stringify(app.manifest);
      if (existing) {
        adapters.storage.updateApp(app.slug, {
          name: app.name,
          description: app.description,
          manifest: manifestJson,
          status: 'active',
          docker_image: app.docker_image,
          code_path: codePath,
          category: app.category,
          author: app.author,
          icon: app.icon,
        } as Partial<AppRecord>);
      } else {
        adapters.storage.createApp({
          id: appId,
          slug: app.slug,
          name: app.name,
          description: app.description,
          manifest: manifestJson,
          status: 'active',
          docker_image: app.docker_image,
          code_path: codePath,
          category: app.category,
          author: app.author,
          icon: app.icon,
          publish_status: 'published',
        } as unknown as Parameters<typeof adapters.storage.createApp>[0]);
        appsAdded++;
      }

      // Per-app secrets
      const perApp = seed.per_app_secrets[app.slug] || {};
      for (const [name, value] of Object.entries(perApp)) {
        const result = insertSecret.run(newSecretId(), name, value, appId);
        if (result.changes > 0) secretsAdded++;
      }
    }

    // Global secrets
    for (const [name, value] of Object.entries(seed.global_secrets)) {
      const result = insertSecret.run(newSecretId(), name, value, null);
      if (result.changes > 0) secretsAdded++;
    }
  });
  txn();

  console.log(
    `[seed] apps added: ${appsAdded}, secrets added: ${secretsAdded}, skipped (image missing): ${appsSkipped}`,
  );
  return {
    apps_added: appsAdded,
    secrets_added: secretsAdded,
    apps_skipped_missing_image: appsSkipped,
  };
}
