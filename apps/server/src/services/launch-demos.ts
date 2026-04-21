// Launch-demo seeder: registers the 3 showcase demo apps (lead-scorer,
// competitor-analyzer, resume-screener) in the runtime catalog at boot.
//
// Why this exists
// ---------------
// PRs #260/#261/#262 added the demo source under `examples/<slug>/` but did
// not wire them into the catalog. The public hub allowlist in
// apps/web/src/lib/hub-filter.ts (added in #263) already filters /apps and
// landing to these three slugs, but the DB rows themselves were never
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
// - Fully idempotent: skips the insert if the slug already exists, skips
//   the build if the tag is already present on the Docker daemon.
//
// Gating: FLOOM_SEED_LAUNCH_DEMOS=false to opt out (default: on).
// Requires /var/run/docker.sock mounted into the container (same as the
// main seeder). If docker is not reachable, we log and skip without
// throwing so boot still succeeds on non-docker dev environments.

import Docker from 'dockerode';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { newAppId } from '../lib/ids.js';
import type { NormalizedManifest } from '../types.js';

export const LAUNCH_DEMO_BUILD_TIMEOUT = Number(
  process.env.LAUNCH_DEMO_BUILD_TIMEOUT || 600_000,
);

interface LaunchDemo {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string | null;
  author: string | null;
  /** Directory (relative to repo root) with Dockerfile + source. */
  contextDir: string;
  /** Tag assigned to the built image. Must be unique per demo. */
  imageTag: string;
  manifest: NormalizedManifest;
}

const DEMOS: LaunchDemo[] = [
  {
    slug: 'lead-scorer',
    name: 'Lead Scorer',
    description:
      'Drop in a CSV of leads plus your ICP. Gemini 3 researches each company with live web search, scores fit 0-100, and returns reasoning plus enriched fields.',
    category: 'growth',
    icon: null,
    author: 'floom',
    contextDir: 'examples/lead-scorer',
    imageTag: 'floom-demo-lead-scorer:v1',
    manifest: {
      name: 'Lead Scorer',
      description:
        'Score CSV leads against an ICP using Gemini 3 with web search grounding.',
      runtime: 'python',
      python_dependencies: ['google-genai==1.64.0'],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        score: {
          label: 'Score Leads',
          inputs: [
            {
              name: 'data',
              label: 'Leads CSV',
              type: 'file',
              required: true,
              description:
                'CSV with a header row. company, website, name, title, industry, country columns are used as-is if present.',
            },
            {
              name: 'icp',
              label: 'Ideal Customer Profile',
              type: 'textarea',
              required: true,
              placeholder:
                'e.g. B2B SaaS CFOs at 100-500 employee fintechs in EU',
              description: 'Free-text description of the lead you want.',
            },
          ],
          outputs: [
            { name: 'total', label: 'Total Rows', type: 'number' },
            { name: 'scored', label: 'Successfully Scored', type: 'number' },
            { name: 'failed', label: 'Failed', type: 'number' },
            { name: 'rows', label: 'Scored Leads', type: 'table' },
            {
              name: 'score_distribution',
              label: 'Score Distribution',
              type: 'json',
            },
            { name: 'model', label: 'Model', type: 'text' },
          ],
        },
      },
    },
  },
  {
    slug: 'competitor-analyzer',
    name: 'Competitor Analyzer',
    description:
      'Paste competitor URLs, get positioning, pricing, and strengths/weaknesses. Grounded in live web data via Gemini 3 URL-context and search.',
    category: 'research',
    icon: null,
    author: 'floom',
    contextDir: 'examples/competitor-analyzer',
    imageTag: 'floom-demo-competitor-analyzer:v1',
    manifest: {
      name: 'Competitor Analyzer',
      description:
        'Paste competitor URLs, get positioning, pricing, and strengths/weaknesses table.',
      runtime: 'python',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        analyze: {
          label: 'Analyze Competitors',
          inputs: [
            {
              name: 'urls',
              label: 'Competitor URLs (one per line)',
              type: 'textarea',
              required: true,
              description:
                'Competitor homepages to analyze. One URL per line. https:// is added automatically if omitted.',
              placeholder:
                'https://linear.app\nhttps://notion.so\nhttps://asana.com',
            },
            {
              name: 'your_product',
              label: 'Your product',
              type: 'textarea',
              required: true,
              description:
                'One-line description of what you sell, so the analysis is comparative.',
              placeholder:
                'e.g. We sell B2B sales automation software to EU mid-market.',
            },
          ],
          outputs: [
            { name: 'competitors', label: 'Competitor Table', type: 'table' },
            { name: 'summary', label: 'Comparative Summary', type: 'markdown' },
            { name: 'model', label: 'Model', type: 'text' },
          ],
        },
      },
    },
  },
  {
    slug: 'resume-screener',
    name: 'Resume Screener',
    description:
      'Rank candidate CVs against a job description. Upload a zip of PDFs and paste the JD, get a ranked shortlist with reasoning and must-have pass/fail per candidate.',
    category: 'hiring',
    icon: null,
    author: 'floom',
    contextDir: 'examples/resume-screener',
    imageTag: 'floom-demo-resume-screener:v1',
    manifest: {
      name: 'Resume Screener',
      description:
        'Rank candidate CVs against a job description using Gemini 3.',
      runtime: 'python',
      python_dependencies: ['pypdf>=4.2.0', 'google-genai>=0.8.0'],
      node_dependencies: {},
      secrets_needed: ['GEMINI_API_KEY'],
      manifest_version: '2.0',
      actions: {
        screen: {
          label: 'Screen Resumes',
          inputs: [
            {
              name: 'cvs_zip',
              label: 'CV Bundle (zip of PDFs)',
              type: 'file',
              required: true,
              description:
                'A .zip file containing one or more candidate CVs as PDFs. Each top-level .pdf becomes one candidate.',
            },
            {
              name: 'job_description',
              label: 'Job Description',
              type: 'textarea',
              required: true,
              description:
                'Free-text job description. The model ranks each CV against this.',
              placeholder:
                'Paste the JD. Role, responsibilities, must-haves, nice-to-haves.',
            },
            {
              name: 'must_haves',
              label: 'Must-haves (one per line)',
              type: 'textarea',
              required: false,
              description:
                'Optional hard requirements, one per line. Candidates missing one are flagged must_have_pass: false regardless of score.',
            },
          ],
          outputs: [
            { name: 'ranked', label: 'Ranked Candidates', type: 'json' },
            { name: 'summary', label: 'Summary', type: 'text' },
            { name: 'model', label: 'Model', type: 'text' },
          ],
        },
      },
    },
  },
];

function findRepoRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // From apps/server/src/services or apps/server/dist/services, walk up
  // until we find a directory that contains both `examples/lead-scorer`
  // and `package.json`.
  const candidates = [
    resolve(here, '..', '..', '..', '..'),
    resolve(here, '..', '..', '..', '..', '..'),
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'examples', 'lead-scorer', 'Dockerfile'))) {
      return c;
    }
  }
  return null;
}

async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

async function buildDemoImage(
  docker: Docker,
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
        const errEvent = (output || []).find(
          (e: { errorDetail?: unknown; error?: unknown }) =>
            e.errorDetail || e.error,
        );
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

export async function seedLaunchDemos(): Promise<{
  apps_added: number;
  apps_existing: number;
  apps_failed: number;
}> {
  if (!isEnabled()) {
    console.log('[launch-demos] FLOOM_SEED_LAUNCH_DEMOS disabled — skipping');
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.log(
      '[launch-demos] repo root not found (no examples/lead-scorer/Dockerfile nearby) — skipping',
    );
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  const docker = new Docker();
  try {
    await docker.ping();
  } catch {
    console.log(
      '[launch-demos] docker daemon not reachable — skipping (preview requires /var/run/docker.sock mount)',
    );
    return { apps_added: 0, apps_existing: 0, apps_failed: 0 };
  }

  const existsBySlug = db.prepare('SELECT id FROM apps WHERE slug = ?');
  const insertApp = db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path, category, author, icon)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  );

  let added = 0;
  let existing = 0;
  let failed = 0;

  for (const demo of DEMOS) {
    const contextPath = resolve(repoRoot, demo.contextDir);
    if (!existsSync(resolve(contextPath, 'Dockerfile'))) {
      console.log(
        `[launch-demos] ${demo.slug}: Dockerfile missing at ${contextPath} — skipping`,
      );
      failed++;
      continue;
    }

    // Build the image if it's not already on the local daemon.
    if (!(await imageExists(docker, demo.imageTag))) {
      console.log(
        `[launch-demos] ${demo.slug}: building image ${demo.imageTag} from ${contextPath}`,
      );
      try {
        await buildDemoImage(docker, contextPath, demo.imageTag);
        console.log(
          `[launch-demos] ${demo.slug}: built ${demo.imageTag}`,
        );
      } catch (err) {
        console.error(
          `[launch-demos] ${demo.slug}: build failed:`,
          (err as Error).message,
        );
        failed++;
        continue;
      }
    } else {
      console.log(
        `[launch-demos] ${demo.slug}: image ${demo.imageTag} already present`,
      );
    }

    // Insert the DB row if missing.
    const row = existsBySlug.get(demo.slug) as { id: string } | undefined;
    if (row) {
      existing++;
      continue;
    }
    const appId = newAppId();
    insertApp.run(
      appId,
      demo.slug,
      demo.name,
      demo.description,
      JSON.stringify(demo.manifest),
      demo.imageTag,
      `reused:launch-demo:${demo.slug}`,
      demo.category,
      demo.author,
      demo.icon,
    );
    added++;
    console.log(`[launch-demos] ${demo.slug}: inserted (app_id=${appId})`);
  }

  console.log(
    `[launch-demos] done: ${added} added, ${existing} existing, ${failed} failed`,
  );
  return { apps_added: added, apps_existing: existing, apps_failed: failed };
}
