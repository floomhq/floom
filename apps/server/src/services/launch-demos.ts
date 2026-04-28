// Launch-demo seeder: registers the showcase demo apps in the runtime catalog
// at boot.
//
// Why this exists
// ---------------
// PRs #260/#261/#262 added the demo source under `examples/<slug>/` but did
// not wire them into the catalog. The public hub allowlist in
// apps/web/src/lib/hub-filter.ts (added in #263) already filters /apps and
// landing to the showcase slugs, but the DB rows themselves were never
// inserted — so /apps rendered "0 APPS" and /p/<slug> hit 404. Issue #252.
//
// Design
// ------
// - Each demo ships its own Dockerfile (self-contained, python:3.12-slim
//   based) and follows the Floom entrypoint protocol directly (argv[1]
//   JSON in, __FLOOM_RESULT__ line on stdout). So we build the image
//   straight from `examples/<slug>/` without Floom's generated Dockerfile
//   wrapper.
// - Manifests are normalized in TS (not parsed from each demo's
//   `floom.yaml`) because the three YAML files were authored with
//   inconsistent shapes (v2 multi-action, v1 single-action, and
//   array-input variants) that the server-side manifest.ts validator
//   rejects. Hand-normalizing here keeps the seeder deterministic.
// - Fully idempotent: content-addressed image tags rebuild only when the
//   demo context changes, and existing DB rows are refreshed in place so
//   preview keeps serving the repo's current launch demos.
//
// Gating: FLOOM_SEED_LAUNCH_DEMOS=false to opt out (default: on).
// Requires /var/run/docker.sock mounted into the container (same as the
// main seeder). If docker is not reachable, we log and skip without
// throwing so boot still succeeds on non-docker dev environments.

import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { alertLaunchDemoInactive } from '../lib/alerts.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import type { NormalizedManifest } from '../types.js';

export const LAUNCH_DEMO_BUILD_TIMEOUT = Number(
  process.env.LAUNCH_DEMO_BUILD_TIMEOUT || 600_000,
);

type BuildEvent = {
  errorDetail?: { message?: string } | unknown;
  error?: unknown;
};

export type SeedLogger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface LaunchDemoDockerLike {
  ping(): Promise<unknown>;
  buildImage(file: unknown, opts: { t: string; rm: boolean; forcerm: boolean }): Promise<unknown>;
  getImage(tag: string): { inspect(): Promise<unknown> };
  modem: {
    followProgress(
      stream: unknown,
      onFinished: (err: Error | null, output?: BuildEvent[]) => void,
      onProgress?: (event: BuildEvent) => void,
    ): void;
  };
}

interface SeedLaunchDemosOptions {
  docker?: LaunchDemoDockerLike;
  logger?: SeedLogger;
  repoRoot?: string | null;
}

interface LaunchDemo {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string | null;
  author: string | null;
  /** Directory (relative to repo root) with Dockerfile + source. */
  contextDir: string;
  manifest: NormalizedManifest;
}

// Launch showcase roster flipped 2026-04-25 (Federico P0 call):
// previous 3 (lead-scorer, competitor-analyzer, resume-screener) can run
// 30s-5min on real inputs, which times out in the demo UX. Replacement
// roster below is bounded to demo-speed runs. Old 3 stay under examples/
// and return to the showcase when the job queue (Phase 2 protocol)
// ships — see project memory.
export const DEMOS: LaunchDemo[] = [
  {
    slug: 'competitor-lens',
    name: 'Competitor Lens',
    description:
      'Paste 2 URLs (yours + one competitor). Floom fetches both pages and a single Gemini 2.5 Flash Lite call returns a positioning, pricing, and angle diff. Under 5 seconds.',
    category: 'research',
    icon: null,
    author: 'floom',
    contextDir: 'examples/competitor-lens',
    manifest: {
      name: 'Competitor Lens',
      description:
        'Compare your page against one competitor page. Bounded positioning + pricing + angle diff.',
      runtime: 'python',
      python_dependencies: [
        'beautifulsoup4==4.13.4',
        'httpx==0.28.1',
        'fastapi>=0.110',
        'pydantic>=2',
      ],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        analyze: {
          label: 'Compare Pages',
          description:
            'Fetches both pages in parallel (5s cap, 500KB max), extracts the readable text, and runs a single Gemini 2.5 Flash Lite call with strict JSON schema. Returns positioning, pricing, and unique-angle diffs in under 5 seconds.',
          inputs: [
            {
              name: 'your_url',
              label: 'Your URL',
              type: 'url',
              required: true,
              placeholder: 'floom.dev',
              description:
                'Your homepage or product page. https:// is added automatically. Max 200 chars.',
            },
            {
              name: 'competitor_url',
              label: 'Competitor URL',
              type: 'url',
              required: true,
              placeholder: 'n8n.io',
              description:
                'One competitor page on a different host. https:// is added automatically. Max 200 chars.',
            },
          ],
          outputs: [
            { name: 'positioning', label: 'Positioning', type: 'table' },
            { name: 'pricing', label: 'Pricing', type: 'table' },
            { name: 'pricing_insight', label: 'Pricing Insight', type: 'text' },
            { name: 'unique_to_you', label: 'Unique To You', type: 'json' },
            { name: 'unique_to_competitor', label: 'Unique To Competitor', type: 'json' },
            { name: 'meta', label: 'Meta', type: 'json' },
          ],
        },
      },
    },
  },
  {
    slug: 'ai-readiness-audit',
    name: 'AI Readiness Audit',
    description:
      'Paste one HTTPS URL. Floom fetches the landing page and a single Gemini 2.5 Flash Lite call returns a readiness score 0-10, 3 risks, 3 opportunities, and one next action. Under 5 seconds.',
    category: 'research',
    icon: null,
    author: 'floom',
    contextDir: 'examples/ai-readiness-audit',
    manifest: {
      name: 'AI Readiness Audit',
      description:
        'Single-URL AI readiness score with 3 risks, 3 opportunities, and a concrete next step.',
      runtime: 'python',
      python_dependencies: [
        'beautifulsoup4==4.13.4',
        'google-genai==1.64.0',
        'httpx==0.28.1',
      ],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        audit: {
          label: 'Run Audit',
          description:
            'Fetches the page (5s cap, 500KB max), extracts the readable text, and runs a single Gemini 2.5 Flash Lite call with strict JSON schema. Returns a 0-10 readiness score, three risks, three opportunities, and one concrete next step in under 5 seconds.',
          inputs: [
            {
              name: 'company_url',
              label: 'Company URL',
              type: 'url',
              required: true,
              placeholder: 'floom.dev',
              description:
                'Public URL. https:// is added automatically. Max 200 chars. Private / loopback / RFC1918 addresses are rejected server-side.',
            },
          ],
          outputs: [
            { name: 'company_url', label: 'Audited URL', type: 'text' },
            { name: 'readiness_score', label: 'Readiness Score', type: 'number' },
            { name: 'score_rationale', label: 'Score Rationale', type: 'text' },
            { name: 'risks', label: 'Risks', type: 'json' },
            { name: 'opportunities', label: 'Opportunities', type: 'json' },
            { name: 'next_action', label: 'Next Action', type: 'text' },
            { name: 'model', label: 'Model', type: 'text' },
          ],
        },
      },
    },
  },
  {
    slug: 'pitch-coach',
    name: 'Pitch Coach',
    description:
      'Paste a 20-500 char startup pitch. A single Gemini 2.5 Flash Lite call returns 3 direct critiques, 3 angle-specific rewrites, and a 1-line TL;DR of the biggest issue. Under 5 seconds.',
    category: 'writing',
    icon: null,
    author: 'floom',
    contextDir: 'examples/pitch-coach',
    manifest: {
      name: 'Pitch Coach',
      description:
        'Roast + rewrite a startup pitch. 3 critiques with VC reactions, 3 rewrites by angle, 1 TL;DR.',
      runtime: 'python',
      python_dependencies: ['google-genai>=1.64.0,<2'],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        coach: {
          label: 'Coach Pitch',
          description:
            'Runs a single Gemini 2.5 Flash Lite call with strict JSON schema against your pitch (20-500 chars). Returns three direct critiques with VC-style reactions, three rewrites in different angles (user-outcome / market-size / technical-moat), and a one-line TL;DR of the biggest issue. Under 5 seconds.',
          inputs: [
            {
              name: 'pitch',
              label: 'Pitch',
              type: 'textarea',
              required: true,
              placeholder:
                'e.g. We help B2B ops teams stop losing leads to slow handoffs.',
              description:
                '20-500 characters. One or two sentences of startup pitch.',
            },
          ],
          outputs: [
            { name: 'harsh_truth', label: 'Harsh Truth', type: 'json' },
            { name: 'rewrites', label: 'Rewrites', type: 'json' },
            { name: 'one_line_tldr', label: 'Biggest Issue', type: 'text' },
            { name: 'model', label: 'Model', type: 'text' },
          ],
        },
      },
    },
  },
  {
    slug: 'linkedin-roaster',
    name: 'LinkedIn Profile Roaster',
    description:
      'Paste a LinkedIn profile URL. Floom returns a cached, specific roast for the launch demo URL in under 10 seconds, with pasted profile text still supported by the app runtime.',
    category: 'writing',
    icon: 'flame',
    author: 'floom',
    contextDir: 'examples/linkedin-roaster',
    manifest: {
      name: 'LinkedIn Profile Roaster',
      description:
        'Roast a LinkedIn profile and rewrite the headline, about intro, and one experience bullet.',
      runtime: 'python',
      python_dependencies: ['google-genai>=1.64.0,<2'],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        roast: {
          label: 'Roast Profile',
          description:
            'Cached demo URL path plus one Gemini 2.5 Flash Lite call for pasted profile text.',
          inputs: [
            {
              name: 'url',
              label: 'LinkedIn URL',
              type: 'url',
              required: true,
              placeholder: 'https://linkedin.com/in/federicodeponte',
              description:
                'LinkedIn profile URL. The launch demo URL is cached for sub-10s cold runs.',
            },
          ],
          outputs: [
            { name: 'roast', label: 'Roast', type: 'table' },
            { name: 'rewrites', label: 'Rewrites', type: 'table' },
            { name: 'top_tip', label: 'Top Tip', type: 'text' },
            { name: 'model', label: 'Model', type: 'text' },
            { name: 'dry_run', label: 'Dry Run', type: 'text' },
            { name: 'cache_hit', label: 'Cache Hit', type: 'text' },
          ],
        },
      },
    },
  },
];

function findRepoRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // From apps/server/src/services or apps/server/dist/services, walk up
  // until we find a directory that contains both `examples/competitor-lens`
  // and `package.json`.
  const candidates = [
    resolve(here, '..', '..', '..', '..'),
    resolve(here, '..', '..', '..', '..', '..'),
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '..', '..'),
  ];
  for (const c of candidates) {
    // Sentinel: one of the current showcase apps is always shipped under
    // examples/. competitor-lens is the launch roster's 2026-04-25 anchor.
    if (existsSync(resolve(c, 'examples', 'competitor-lens', 'Dockerfile'))) {
      return c;
    }
  }
  return null;
}

async function imageExists(
  docker: Pick<LaunchDemoDockerLike, 'getImage'>,
  tag: string,
): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

const IGNORED_CONTEXT_NAMES = new Set([
  '.git',
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  'node_modules',
]);

function walkContextFiles(contextPath: string, relDir = ''): string[] {
  const absDir = relDir ? resolve(contextPath, relDir) : contextPath;
  const entries = readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => !IGNORED_CONTEXT_NAMES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkContextFiles(contextPath, relPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relPath);
      continue;
    }
    const absPath = resolve(contextPath, relPath);
    if (lstatSync(absPath).isFile()) files.push(relPath);
  }
  return files;
}

export function fingerprintDemoContext(contextPath: string): string {
  const hash = createHash('sha256');
  for (const relPath of walkContextFiles(contextPath)) {
    hash.update(relPath);
    hash.update('\0');
    hash.update(readFileSync(resolve(contextPath, relPath)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function imageTagForDemo(
  demo: Pick<LaunchDemo, 'slug'>,
  contextPath: string,
): string {
  return `floom-demo-${demo.slug}:ctx-${fingerprintDemoContext(contextPath)}`;
}

async function buildDemoImage(
  docker: LaunchDemoDockerLike,
  contextPath: string,
  tag: string,
): Promise<void> {
  const stream = await docker.buildImage(
    { context: contextPath, src: ['.'] },
    { t: tag, rm: true, forcerm: true },
  );

  await new Promise<void>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(
        new Error(
          `[launch-demos] build timed out after ${LAUNCH_DEMO_BUILD_TIMEOUT}ms for ${tag}`,
        ),
      );
    }, LAUNCH_DEMO_BUILD_TIMEOUT);
    docker.modem.followProgress(
      stream,
      (err, output) => {
        clearTimeout(timer);
        if (err) return rejectP(err);
        const errEvent = (output || []).find((e) => e.errorDetail || e.error);
        if (errEvent) {
          const msg =
            (typeof errEvent.error === 'string' ? errEvent.error : null) ||
            (errEvent.errorDetail &&
            typeof (errEvent.errorDetail as { message?: string }).message ===
              'string'
              ? (errEvent.errorDetail as { message: string }).message
              : null) ||
            'build failed';
          return rejectP(new Error(msg));
        }
        resolveP();
      },
      () => {
        // swallow progress events — we only care about success/failure
      },
    );
  });
}

function isEnabled(): boolean {
  const v = process.env.FLOOM_SEED_LAUNCH_DEMOS;
  if (v === undefined || v === '') return true;
  return !/^(0|false|no|off)$/i.test(v);
}

/**
 * Derive the full set of secret env keys the launch demos declare across their
 * manifests. Today that's just GEMINI_API_KEY, but walking `secrets_needed`
 * keeps this honest if a future demo adds another.
 */
function demoSecretKeys(): string[] {
  const keys = new Set<string>();
  for (const demo of DEMOS) {
    for (const k of demo.manifest.secrets_needed || []) keys.add(k);
  }
  return [...keys];
}

/**
 * 2026-04-24: auto-seed any demo secret env (e.g. GEMINI_API_KEY) as a GLOBAL
 * secret from process.env when set and when no global row exists for that key.
 * Prevents fresh preview/prod deploys from leaving the 3 AI demos in dry-run
 * mode (empty `secrets` table → runner falls back to GEMINI_API_KEY="" →
 * handler emits a random-score dry-run result, which breaks the landing
 * demo). Idempotent: runs once per boot, does nothing on subsequent boots
 * because the global row already exists, and is a pure no-op if the env var
 * is unset.
 */
function seedLaunchDemoSecretsFromEnv(logger: SeedLogger = console): void {
  const selectGlobal = db.prepare(
    "SELECT id FROM secrets WHERE name = ? AND app_id IS NULL",
  );
  const insertGlobal = db.prepare(
    'INSERT INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, NULL)',
  );
  for (const key of demoSecretKeys()) {
    const envVal = process.env[key];
    if (!envVal || envVal.length < 20) continue;
    const existing = selectGlobal.get(key) as { id: string } | undefined;
    if (existing) continue;
    insertGlobal.run(newSecretId(), key, envVal);
    logger.log(`[launch-demos] seeded global ${key} from env`);
  }
}

export async function resolveDemoImageTag(opts: {
  contextPath: string;
  demo: Pick<LaunchDemo, 'slug'>;
  docker: LaunchDemoDockerLike;
  logger: SeedLogger;
  persistedImageTag: string | null;
}): Promise<
  | { kind: 'ready'; imageTag: string }
  | { kind: 'keep_previous'; imageTag: string }
  | { kind: 'missing'; imageTag: string }
> {
  const imageTag = imageTagForDemo(opts.demo, opts.contextPath);

  if (!(await imageExists(opts.docker, imageTag))) {
    opts.logger.log(
      `[launch-demos] ${opts.demo.slug}: building image ${imageTag} from ${opts.contextPath}`,
    );
    try {
      await buildDemoImage(opts.docker, opts.contextPath, imageTag);
      opts.logger.log(`[launch-demos] ${opts.demo.slug}: built ${imageTag}`);
    } catch (err) {
      opts.logger.error(
        `[launch-demos] ${opts.demo.slug}: build failed:`,
        (err as Error).message,
      );
      if (
        opts.persistedImageTag &&
        opts.persistedImageTag !== imageTag &&
        (await imageExists(opts.docker, opts.persistedImageTag))
      ) {
        return { kind: 'keep_previous', imageTag: opts.persistedImageTag };
      }
      return { kind: 'missing', imageTag };
    }
  } else {
    opts.logger.log(
      `[launch-demos] ${opts.demo.slug}: image ${imageTag} already present`,
    );
  }

  // Production incident 2026-04-24: prod carried DB rows that pointed at
  // `floom-demo-<slug>:ctx-<hash>` tags that no longer existed on the host.
  // If the target tag cannot be inspected after build OR reuse, never advance
  // the DB to it. Keep the previous runnable tag when possible, otherwise the
  // app must be marked inactive so /api/run refuses it instead of serving a
  // broken hero app.
  if (await imageExists(opts.docker, imageTag)) {
    return { kind: 'ready', imageTag };
  }
  if (
    opts.persistedImageTag &&
    opts.persistedImageTag !== imageTag &&
    (await imageExists(opts.docker, opts.persistedImageTag))
  ) {
    return { kind: 'keep_previous', imageTag: opts.persistedImageTag };
  }
  return { kind: 'missing', imageTag };
}

// Layer-5 Discord alert hook: flip `apps.status` to inactive and fire a
// deduped Discord ping so ops see silent breakages within 10 min instead of
// from a user report. Safe to call when the row is already inactive — the
// guard below makes it a no-op. Network post is best-effort inside
// alertLaunchDemoInactive; a webhook outage never blocks seeding.
function markLaunchDemoInactive(slug: string, detail: string): void {
  const row = db
    .prepare('SELECT id, status FROM apps WHERE slug = ?')
    .get(slug) as { id: string; status: string } | undefined;
  if (!row || row.status === 'inactive') return;
  db.prepare(
    "UPDATE apps SET status = 'inactive', updated_at = datetime('now') WHERE id = ?",
  ).run(row.id);
  console.warn(`[launch-demos] ${slug}: marking inactive (${detail})`);
  alertLaunchDemoInactive(slug, detail);
}

export async function seedLaunchDemos(): Promise<{
  apps_added: number;
  apps_existing: number;
  apps_failed: number;
}>;
export async function seedLaunchDemos(
  options: SeedLaunchDemosOptions = {},
): Promise<{
  apps_added: number;
  apps_existing: number;
  apps_failed: number;
}> {
  const logger = options.logger || console;
  if (!isEnabled()) {
    logger.log('[launch-demos] FLOOM_SEED_LAUNCH_DEMOS disabled — skipping');
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  // Seed global secrets from env BEFORE building images. This runs even when
  // docker is unreachable on this host (dev mode without Docker), because the
  // secret is a DB-only operation and a later host with docker reachable will
  // reuse the same DB.
  seedLaunchDemoSecretsFromEnv(logger);

  const repoRoot = options.repoRoot ?? findRepoRoot();
  if (!repoRoot) {
    logger.log(
      '[launch-demos] repo root not found (no examples/competitor-lens/Dockerfile nearby) — skipping',
    );
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  const docker = options.docker || new Docker();
  try {
    await docker.ping();
  } catch {
    logger.log(
      '[launch-demos] docker daemon not reachable — skipping (preview requires /var/run/docker.sock mount)',
    );
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  const existsBySlug = db.prepare(
    'SELECT id, status, docker_image FROM apps WHERE slug = ?',
  );
  // Launch-demo apps are first-party showcases — always 'published'. User
  // ingestion paths (openapi-ingest / docker-image-ingest) go through the
  // manual review gate (publish_status='pending_review' by default).
  //
  // Wireframe parity (2026-04-23): seed hero=1 on the 3 AI demo apps so
  // the /apps grid renders the accent "HERO" tag per v17 store.html. All
  // three slugs in DEMOS are the bounded AI demos (competitor-lens,
  // ai-readiness-audit, pitch-coach) so a blanket hero=1 is correct here;
  // if a non-hero demo is added later, gate this on demo.slug.
  // Note: we force app_type='docker', visibility='public', base_url=NULL on
  // every insert + update. Production incident 2026-04-25: a prior
  // preseed attempt had left ai-readiness-audit rows with
  // app_type='proxied' + base_url='http://172.17.0.1:4310' +
  // visibility='private'. The older updateApp kept those stale fields,
  // and the next seed refreshed only name/desc/image/etc. The runner
  // then tried to POST HTTP to the dead proxied URL instead of running
  // the Docker image, and /api/hub filtered the private row out. Force
  // the showcase shape on every seed so stale rows heal themselves.
  const insertApp = db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon, publish_status, hero, app_type, visibility, base_url)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 'published', 1, 'docker', 'public', NULL)`,
  );
  const updateApp = db.prepare(
    `UPDATE apps
       SET name = ?,
           description = ?,
           manifest = ?,
           status = 'active',
           docker_image = ?,
           code_path = ?,
           category = ?,
           author = ?,
           icon = ?,
           hero = 1,
           app_type = 'docker',
           visibility = 'public',
           base_url = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  );
  const markAppActive = db.prepare(
    `UPDATE apps
       SET status = 'active',
           updated_at = datetime('now')
     WHERE id = ?`,
  );

  let added = 0;
  let existing = 0;
  let failed = 0;
  let keptPrevious = 0;
  let markedInactive = 0;

  // 2026-04-25 roster swap (Federico P0): the previous showcase slugs can
  // exceed the demo budget on real inputs. Mark any leftover rows inactive
  // so they stop appearing in the hub listing even if their docker images
  // linger. The examples/ directory keeps the source for the v1.1 re-launch
  // when the job queue ships.
  const PREVIOUS_SHOWCASE_SLUGS = [
    'lead-scorer',
    'competitor-analyzer',
    'resume-screener',
  ];
  const markPreviousInactive = db.prepare(
    `UPDATE apps
       SET status = 'inactive',
           updated_at = datetime('now')
     WHERE slug = ? AND status != 'inactive'`,
  );
  for (const oldSlug of PREVIOUS_SHOWCASE_SLUGS) {
    const info = markPreviousInactive.run(oldSlug) as { changes: number };
    if (info.changes > 0) {
      logger.log(
        `[launch-demos] ${oldSlug}: marked inactive (2026-04-25 roster swap)`,
      );
    }
  }

  for (const demo of DEMOS) {
    const contextPath = resolve(repoRoot, demo.contextDir);
    if (!existsSync(resolve(contextPath, 'Dockerfile'))) {
      markLaunchDemoInactive(
        demo.slug,
        `seedLaunchDemos missing Dockerfile at ${contextPath}`,
      );
      logger.log(
        `[launch-demos] ${demo.slug}: Dockerfile missing at ${contextPath} — skipping`,
      );
      failed++;
      continue;
    }

    // Insert the DB row if missing. Existing launch demos are refreshed in
    // place so preview picks up current manifests + image tags after deploy.
    const row = existsBySlug.get(demo.slug) as
      | { id: string; status: string; docker_image: string | null }
      | undefined;
    const resolvedImage = await resolveDemoImageTag({
      contextPath,
      demo,
      docker,
      logger,
      persistedImageTag: row?.docker_image ?? null,
    });
    if (resolvedImage.kind === 'keep_previous') {
      if (row) {
        markAppActive.run(row.id);
        keptPrevious++;
        existing++;
        logger.warn(
          `[launch-demos] WARN: ${demo.slug}: keeping existing docker_image ${resolvedImage.imageTag}`,
        );
      } else {
        failed++;
        logger.error(
          `[launch-demos] ${demo.slug}: no existing row to keep on ${resolvedImage.imageTag}`,
        );
      }
      continue;
    }
    if (resolvedImage.kind === 'missing') {
      failed++;
      if (row) {
        markLaunchDemoInactive(
          demo.slug,
          `${resolvedImage.imageTag} unavailable after build/reuse`,
        );
        markedInactive++;
        logger.error(
          `[launch-demos] FATAL: ${demo.slug}: ${resolvedImage.imageTag} unavailable; marked app inactive`,
        );
      } else {
        logger.error(
          `[launch-demos] FATAL: ${demo.slug}: ${resolvedImage.imageTag} unavailable; not inserting`,
        );
      }
      continue;
    }

    const imageTag = resolvedImage.imageTag;
    const codePath = `reused:launch-demo:${demo.slug}:${imageTag.split(':')[1]}`;
    const manifestJson = JSON.stringify(demo.manifest);
    if (row) {
      updateApp.run(
        demo.name,
        demo.description,
        manifestJson,
        imageTag,
        codePath,
        demo.category,
        demo.author,
        demo.icon,
        row.id,
      );
      if (row.docker_image !== imageTag) {
        logger.log(
          `[launch-demos] ${demo.slug}: refreshed existing app to ${imageTag}`,
        );
      } else {
        logger.log(
          `[launch-demos] ${demo.slug}: refreshed existing app metadata`,
        );
      }
      existing++;
      continue;
    }
    const appId = newAppId();
    insertApp.run(
      appId,
      demo.slug,
      demo.name,
      demo.description,
      manifestJson,
      imageTag,
      codePath,
      demo.category,
      demo.author,
      demo.icon,
    );
    added++;
    logger.log(`[launch-demos] ${demo.slug}: inserted (app_id=${appId})`);
  }

  logger.log(
    `[launch-demos] done: ${added} added, ${existing} existing, ${failed} failed, ${keptPrevious} kept-previous, ${markedInactive} marked-inactive`,
  );
  return { apps_added: added, apps_existing: existing, apps_failed: failed };
}
