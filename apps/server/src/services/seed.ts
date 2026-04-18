// Seed the local SQLite DB from apps/server/src/db/seed.json on boot.
// Idempotent: re-runs on every startup, but only inserts missing rows.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import type { NormalizedManifest } from '../types.js';

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

export function seedFromFile(): { apps_added: number; secrets_added: number } {
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
    return { apps_added: 0, secrets_added: 0 };
  }
  const path = findSeedFile();
  if (!path) {
    console.log('[seed] no seed.json found — skipping');
    return { apps_added: 0, secrets_added: 0 };
  }
  const raw = readFileSync(path, 'utf-8');
  const seed = JSON.parse(raw) as SeedFile;
  console.log(`[seed] loading ${seed.apps.length} apps from ${path}`);
  console.log(
    '[seed] FLOOM_SEED_APPS is on — the bundled docker demo apps require /var/run/docker.sock to be mounted into the container.',
  );

  let appsAdded = 0;
  let secretsAdded = 0;

  const insertApp = db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  );
  const insertSecret = db.prepare(
    `INSERT OR IGNORE INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)`,
  );
  const existsBySlug = db.prepare('SELECT id FROM apps WHERE slug = ?');

  const txn = db.transaction(() => {
    for (const app of seed.apps) {
      const existing = existsBySlug.get(app.slug) as { id: string } | undefined;
      let appId: string;
      if (!existing) {
        appId = newAppId();
        insertApp.run(
          appId,
          app.slug,
          app.name,
          app.description,
          JSON.stringify(app.manifest),
          app.docker_image,
          // code_path is unused when docker_image is already set; we store
          // a placeholder so the NOT NULL constraint is satisfied.
          `reused:${app.marketplace_app_id}`,
          app.category,
          app.author,
          app.icon,
        );
        appsAdded++;
      } else {
        appId = existing.id;
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

  console.log(`[seed] apps added: ${appsAdded}, secrets added: ${secretsAdded}`);
  return { apps_added: appsAdded, secrets_added: secretsAdded };
}
