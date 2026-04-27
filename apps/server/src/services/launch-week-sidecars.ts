// Launch Week sidecar lifecycle.
//
// These are pure Node proxied-mode examples used as public launch proof
// objects. At boot, Floom forks their HTTP servers, writes a runtime apps.yaml
// with the actual local ports, and ingests them as active proxied apps.
//
// Opt-in: FLOOM_LAUNCH_WEEK_APPS=true.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from '../adapters/index.js';
import { ingestOpenApiApps } from './openapi-ingest.js';

const HOST = process.env.FLOOM_LAUNCH_WEEK_HOST || '127.0.0.1';

interface LaunchWeekApp {
  slug: string;
  display_name: string;
  description: string;
  category: string;
  openapiPath: string;
  featured?: boolean;
}

interface LaunchWeekSidecar {
  name: string;
  script: string;
  port: number;
  healthPath: string;
  apps: LaunchWeekApp[];
}

const SIDECARS: LaunchWeekSidecar[] = [
  {
    name: 'launch-scorecards',
    script: 'examples/launch-scorecards/server.mjs',
    port: Number(process.env.LAUNCH_SCORECARDS_PORT || 4120),
    healthPath: '/health',
    apps: [
      {
        slug: 'linkedin-roaster',
        display_name: 'LinkedIn Roaster',
        description:
          'Paste a LinkedIn profile URL and get sharper positioning, headline, About rewrite, and post ideas.',
        category: 'marketing',
        openapiPath: '/linkedin-roaster/openapi.json',
        featured: true,
      },
      {
        slug: 'yc-pitch-deck-critic',
        display_name: 'YC Pitch Deck Critic',
        description:
          'Upload a pitch deck outline or text export and get YC-style objections, rewrites, and next steps.',
        category: 'fundraising',
        openapiPath: '/yc-pitch-deck-critic/openapi.json',
        featured: true,
      },
    ],
  },
  {
    name: 'hook-stats',
    script: 'examples/hook-stats/server.mjs',
    port: Number(process.env.HOOK_STATS_PORT || 4110),
    healthPath: '/health',
    apps: [
      {
        slug: 'hook-stats',
        display_name: 'Hook Stats',
        description:
          'Upload a Claude Code bash-commands.log and get top commands, git stats, and per-day activity.',
        category: 'productivity',
        openapiPath: '/openapi.json',
        featured: true,
      },
    ],
  },
  {
    name: 'claude-wrapped',
    script: 'examples/claude-wrapped/server.mjs',
    port: Number(process.env.CLAUDE_WRAPPED_PORT || 4111),
    healthPath: '/health',
    apps: [
      {
        slug: 'claude-wrapped',
        display_name: 'Claude Wrapped',
        description:
          'Spotify Wrapped for Claude Code. Upload exported session files and visualize AI coding stats.',
        category: 'productivity',
        openapiPath: '/openapi.json',
        featured: true,
      },
    ],
  },
  {
    name: 'session-recall',
    script: 'examples/session-recall/server.mjs',
    port: Number(process.env.SESSION_RECALL_PORT || 4112),
    healthPath: '/health',
    apps: [
      {
        slug: 'session-recall',
        display_name: 'Session Recall',
        description:
          'Upload a Claude Code session file and search, recall, or generate a retry-loop report.',
        category: 'productivity',
        openapiPath: '/openapi.json',
        featured: true,
      },
    ],
  },
  {
    name: 'floom-this',
    script: 'examples/floom-this/server.mjs',
    port: Number(process.env.FLOOM_THIS_PORT || 4122),
    healthPath: '/health',
    apps: [
      {
        slug: 'floom-this',
        display_name: 'Floom This',
        description:
          'Paste a GitHub repo URL and get the Floom app shape: inputs, outputs, build plan, and next step.',
        category: 'developer-tools',
        openapiPath: '/floom-this/openapi.json',
        featured: true,
      },
    ],
  },
];

const children = new Map<string, ChildProcess>();

function isEnabled(): boolean {
  const raw = process.env.FLOOM_LAUNCH_WEEK_APPS;
  if (raw === undefined || raw === '') return false;
  return /^(1|true|yes|on)$/i.test(raw);
}

function findRepoRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', '..'),
    resolve(here, '..', '..', '..', '..', '..'),
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '..', '..'),
  ];
  for (const root of candidates) {
    if (existsSync(join(root, 'package.json')) && existsSync(join(root, 'examples'))) {
      return root;
    }
  }
  return null;
}

async function waitForHealthy(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function writeRuntimeAppsYaml(sidecars: LaunchWeekSidecar[]): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'floom-launch-week-yaml-'));
  const path = join(tmpDir, 'apps.yaml');
  const lines: string[] = ['apps:'];
  for (const sidecar of sidecars) {
    for (const app of sidecar.apps) {
      lines.push(`  - slug: ${app.slug}`);
      lines.push('    type: proxied');
      lines.push(`    openapi_spec_url: http://${HOST}:${sidecar.port}${app.openapiPath}`);
      lines.push(`    display_name: ${JSON.stringify(app.display_name)}`);
      lines.push(`    description: ${JSON.stringify(app.description)}`);
      lines.push(`    category: ${app.category}`);
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

async function markFeatured(slugs: string[]): Promise<number> {
  let touched = 0;
  for (const slug of slugs) {
    const updated = await adapters.storage.updateApp(slug, { featured: 1 });
    if (updated) touched++;
  }
  return touched;
}

export interface LaunchWeekBootResult {
  enabled: boolean;
  started: number;
  ingested: number;
  failed: number;
  skipped: string[];
  reason?: string;
}

export async function startLaunchWeekApps(): Promise<LaunchWeekBootResult> {
  if (!isEnabled()) {
    return { enabled: false, started: 0, ingested: 0, failed: 0, skipped: [], reason: 'disabled' };
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.warn('[launch-week] repo root not found; skipping');
    return { enabled: true, started: 0, ingested: 0, failed: 0, skipped: [], reason: 'repo_root_not_found' };
  }

  const ready: LaunchWeekSidecar[] = [];
  const skipped: string[] = [];

  for (const sidecar of SIDECARS) {
    if (children.has(sidecar.name)) {
      ready.push(sidecar);
      continue;
    }

    const scriptPath = join(repoRoot, sidecar.script);
    if (!existsSync(scriptPath)) {
      skipped.push(sidecar.name);
      continue;
    }

    console.log(`[launch-week] forking ${sidecar.name}: ${scriptPath}`);
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        PORT: String(sidecar.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[launch-week:${sidecar.name}] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[launch-week:${sidecar.name}:err] ${chunk}`);
    });
    child.on('exit', (code, signal) => {
      console.warn(`[launch-week] ${sidecar.name} exited code=${code} signal=${signal}`);
      children.delete(sidecar.name);
    });

    children.set(sidecar.name, child);

    const healthy = await waitForHealthy(`http://${HOST}:${sidecar.port}${sidecar.healthPath}`);
    if (!healthy) {
      skipped.push(`${sidecar.name}:not_healthy`);
      continue;
    }

    ready.push(sidecar);
  }

  if (children.size > 0) {
    const shutdown = () => stopLaunchWeekApps();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('exit', shutdown);
  }

  if (ready.length === 0) {
    return { enabled: true, started: 0, ingested: 0, failed: 0, skipped, reason: 'no_ready_sidecars' };
  }

  const runtimeYaml = writeRuntimeAppsYaml(ready);
  console.log(`[launch-week] wrote runtime apps.yaml at ${runtimeYaml}`);
  try {
    const result = await ingestOpenApiApps(runtimeYaml);
    const featured = ready.flatMap((s) => s.apps.filter((a) => a.featured).map((a) => a.slug));
    const pinned = await markFeatured(featured);
    console.log(
      `[launch-week] ingested ${result.apps_ingested} apps (${result.apps_failed} failed), marked ${pinned} featured`,
    );
    return {
      enabled: true,
      started: ready.length,
      ingested: result.apps_ingested,
      failed: result.apps_failed,
      skipped,
    };
  } catch (err) {
    console.error('[launch-week] ingest failed:', err);
    return {
      enabled: true,
      started: ready.length,
      ingested: 0,
      failed: 0,
      skipped,
      reason: (err as Error).message,
    };
  }
}

export function stopLaunchWeekApps(): void {
  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  children.clear();
}
