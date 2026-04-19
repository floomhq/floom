// Fast Apps sidecar lifecycle.
//
// At boot the Floom server forks `examples/fast-apps/server.mjs` as a child
// process on localhost:$FAST_APPS_PORT (default 4200). Once the sidecar
// answers its /health probe, we call ingestOpenApiApps on
// `examples/fast-apps/apps.yaml` so the seven utility apps land in the
// hub alongside any other proxied apps declared via FLOOM_APPS_CONFIG.
//
// Opt-out: set FLOOM_FAST_APPS=false (or 0) in the environment. Useful for
// tests that want a truly empty hub or for operators who would rather not
// run a second node process.
//
// Clean shutdown: on SIGINT/SIGTERM the parent process kills the sidecar
// so we do not leak an orphan node on :4200.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { ingestOpenApiApps } from './openapi-ingest.js';

/**
 * Slugs that should be pinned as `featured` in the store after ingest.
 *  - The seven new fast-apps (uuid, password, hash, base64, json-format,
 *    jwt-decode, word-count) are always fastest so they go first.
 *  - Three bundled seed apps (hook-stats, claude-wrapped, session-recall)
 *    are marked featured for continuity with the previous-wave demo flow;
 *    Federico wants them pinned even though their docker runtime is
 *    slower than the new fast-apps.
 */
const FEATURED_SLUGS = new Set<string>([
  'uuid',
  'password',
  'hash',
  'base64',
  'json-format',
  'jwt-decode',
  'word-count',
  'hook-stats',
  'claude-wrapped',
  'session-recall',
]);

const FAST_APPS_PORT = Number(process.env.FAST_APPS_PORT || 4200);
const FAST_APPS_HOST = process.env.FAST_APPS_HOST || '127.0.0.1';

function isEnabled(): boolean {
  const raw = process.env.FLOOM_FAST_APPS;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(raw);
}

/**
 * Find examples/fast-apps/server.mjs relative to the running compiled
 * apps/server/dist/index.js. We walk up from the current file location
 * until we find the sidecar, so the same helper works in both local dev
 * (source tree) and the Docker image (which copies `examples/fast-apps`
 * into `/app/examples/fast-apps`).
 */
function findSidecarScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    // src/services -> ../..  = apps/server, ../../.. = apps, ../../../.. = repo root
    resolve(here, '..', '..', '..', '..'),
    // dist/services -> ../..  = apps/server, ../../.. = apps, ../../../.. = repo root
    resolve(here, '..', '..', '..', '..'),
    // Docker image layout: /app/apps/server/dist/services -> /app
    resolve(here, '..', '..', '..', '..', '..'),
    // Fallback: process.cwd
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '..', '..'),
  ];
  for (const root of candidateRoots) {
    const serverScript = join(root, 'examples', 'fast-apps', 'server.mjs');
    if (existsSync(serverScript)) return serverScript;
  }
  return null;
}

/**
 * App descriptors for the seven fast apps. We materialize a temporary
 * apps.yaml at boot using the *actual* sidecar port so tests and multi-
 * instance deployments can bind to any port without touching the shipped
 * examples/fast-apps/apps.yaml file on disk.
 */
interface FastAppDescriptor {
  slug: string;
  display_name: string;
  description: string;
  category: string;
  icon: string;
  /**
   * v16 renderer cascade (Layer 2): optional stock library component
   * hint. Materialized into the runtime apps.yaml and picked up by
   * specToManifest so the web client renders a clean output card
   * instead of raw JSON. See apps/web/src/components/output/.
   */
  render?: { output_component: string; [key: string]: unknown };
  /**
   * Fix 1 (2026-04-19): per-input label overrides. Keys are input names
   * (matching the OpenAPI body schema property names), values replace
   * the auto-generated UI label. Used by uuid to rename the `version`
   * field to "UUID format" so the form label doesn't collide with the
   * app release version shown in the /p/:slug hero meta row.
   */
  input_labels?: Record<string, string>;
}

const FAST_APP_DESCRIPTORS: FastAppDescriptor[] = [
  {
    slug: 'uuid',
    display_name: 'UUID Generator',
    description:
      'Generate one or more UUID v4 or v7 strings. Pure random v4, or time-ordered v7 for sortable ids.',
    category: 'developer-tools',
    icon: 'uuid',
    render: {
      output_component: 'TextBig',
      value_field: 'uuids',
      copyable: true,
    },
    // Rename the `version` enum selector so the form field label doesn't
    // collide with the app release version ("v0.1.0") in the hero meta row.
    // The body key stays `version` (OpenAPI schema).
    input_labels: {
      version: 'UUID format',
    },
  },
  {
    slug: 'password',
    display_name: 'Password Generator',
    description:
      'Cryptographically secure password generator. Rejection-sampled crypto.randomBytes, no modulo bias, configurable alphabet.',
    category: 'developer-tools',
    icon: 'password',
  },
  {
    slug: 'hash',
    display_name: 'Hash',
    description:
      'Compute md5, sha1, sha256, or sha512 digests of UTF-8 text. Returns the hex digest and byte length.',
    category: 'developer-tools',
    icon: 'hash',
  },
  {
    slug: 'base64',
    display_name: 'Base64',
    description:
      'Encode text to base64 or decode base64 back to text. Supports the URL-safe alphabet for tokens and JWTs.',
    category: 'developer-tools',
    icon: 'base64',
  },
  {
    slug: 'json-format',
    display_name: 'JSON Formatter',
    description:
      'Parse and pretty-print JSON with configurable indent and optional sorted keys. Returns both formatted and minified forms.',
    category: 'developer-tools',
    icon: 'json-format',
    render: {
      output_component: 'CodeBlock',
      code_field: 'formatted',
      language: 'json',
    },
  },
  {
    slug: 'jwt-decode',
    display_name: 'JWT Decoder',
    description:
      'Decode a JWT header and payload without verifying the signature. Shows algorithm, expiry, and claims for debugging.',
    category: 'developer-tools',
    icon: 'jwt-decode',
  },
  {
    slug: 'word-count',
    display_name: 'Word Count',
    description:
      'Count words, characters, lines, sentences, and paragraphs. Estimates reading time at 220 words per minute.',
    category: 'writing',
    icon: 'word-count',
  },
];

/**
 * Write an apps.yaml to a unique temp dir using the actual sidecar port
 * and return its path. We avoid YAML escapes by keeping descriptions on a
 * single line and JSON-stringifying them so colons and quotes do not
 * confuse the parser.
 */
function writeRuntimeAppsYaml(host: string, port: number): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'floom-fast-apps-yaml-'));
  const path = join(tmpDir, 'apps.yaml');
  const lines: string[] = ['apps:'];
  for (const d of FAST_APP_DESCRIPTORS) {
    lines.push(`  - slug: ${d.slug}`);
    lines.push('    type: proxied');
    lines.push(`    openapi_spec_url: http://${host}:${port}/openapi/${d.slug}.json`);
    lines.push(`    display_name: ${JSON.stringify(d.display_name)}`);
    lines.push(`    description: ${JSON.stringify(d.description)}`);
    lines.push(`    category: ${d.category}`);
    lines.push(`    icon: ${d.icon}`);
    if (d.render) {
      // v16 renderer cascade hint. Emit as a nested YAML block; each
      // value is JSON-stringified so booleans, numbers, and strings with
      // special characters survive the parser without escaping gymnastics.
      lines.push('    render:');
      for (const [key, value] of Object.entries(d.render)) {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      }
    }
    if (d.input_labels) {
      // Fix 1 (2026-04-19): per-input label overrides. Same JSON-stringify
      // trick as render/ to survive the YAML parser.
      lines.push('    input_labels:');
      for (const [key, value] of Object.entries(d.input_labels)) {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
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

let sidecarProcess: ChildProcess | null = null;

export interface FastAppsBootResult {
  enabled: boolean;
  started: boolean;
  ingested: number;
  failed: number;
  reason?: string;
}

/**
 * Start the fast-apps sidecar and ingest its apps.yaml. Idempotent: calling
 * twice in the same process is a no-op after the first run.
 */
export async function startFastApps(): Promise<FastAppsBootResult> {
  if (!isEnabled()) {
    return { enabled: false, started: false, ingested: 0, failed: 0, reason: 'disabled' };
  }
  if (sidecarProcess) {
    return { enabled: true, started: true, ingested: 0, failed: 0, reason: 'already_running' };
  }

  const serverScript = findSidecarScript();
  if (!serverScript) {
    console.warn('[fast-apps] examples/fast-apps/server.mjs not found in any candidate path; skipping');
    return {
      enabled: true,
      started: false,
      ingested: 0,
      failed: 0,
      reason: 'sidecar_script_not_found',
    };
  }

  console.log(`[fast-apps] forking sidecar: ${serverScript}`);
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      FAST_APPS_PORT: String(FAST_APPS_PORT),
      FAST_APPS_HOST,
      FAST_APPS_PUBLIC_BASE: `http://${FAST_APPS_HOST}:${FAST_APPS_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[fast-apps] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[fast-apps:err] ${chunk}`);
  });
  child.on('exit', (code, signal) => {
    console.warn(`[fast-apps] sidecar exited code=${code} signal=${signal}`);
    sidecarProcess = null;
  });

  sidecarProcess = child;

  // Kill sidecar on parent shutdown so we do not orphan node on :4200.
  const shutdown = () => {
    if (sidecarProcess && !sidecarProcess.killed) {
      sidecarProcess.kill('SIGTERM');
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', shutdown);

  const healthy = await waitForHealthy(`http://${FAST_APPS_HOST}:${FAST_APPS_PORT}/health`);
  if (!healthy) {
    console.warn('[fast-apps] sidecar never became healthy; skipping ingest');
    return {
      enabled: true,
      started: false,
      ingested: 0,
      failed: 0,
      reason: 'sidecar_not_healthy',
    };
  }

  // Materialize a runtime apps.yaml using the actual sidecar port so
  // multi-instance and test setups can bind to any port. Lives in a
  // mkdtempSync dir; cleaned up by the OS on reboot.
  const runtimeYaml = writeRuntimeAppsYaml(FAST_APPS_HOST, FAST_APPS_PORT);
  console.log(`[fast-apps] wrote runtime apps.yaml at ${runtimeYaml}`);

  try {
    const result = await ingestOpenApiApps(runtimeYaml);
    console.log(
      `[fast-apps] ingested ${result.apps_ingested} apps (${result.apps_failed} failed)`,
    );
    // Pin the fast apps + previously-featured demo apps to the top of the
    // store. Idempotent: re-running updates featured=1 on the same slugs.
    // Apps that are not present in the DB are silently skipped because the
    // WHERE clause filters by slug.
    const markFeatured = db.prepare(
      `UPDATE apps SET featured = 1, updated_at = datetime('now') WHERE slug = ?`,
    );
    const featuredTxn = db.transaction((slugs: string[]) => {
      let touched = 0;
      for (const slug of slugs) {
        const r = markFeatured.run(slug);
        if (r.changes > 0) touched++;
      }
      return touched;
    });
    const pinned = featuredTxn(Array.from(FEATURED_SLUGS));
    console.log(`[fast-apps] marked ${pinned} apps featured`);
    return {
      enabled: true,
      started: true,
      ingested: result.apps_ingested,
      failed: result.apps_failed,
    };
  } catch (err) {
    console.error('[fast-apps] ingest failed:', err);
    return {
      enabled: true,
      started: true,
      ingested: 0,
      failed: 0,
      reason: (err as Error).message,
    };
  }
}

/**
 * Stop the sidecar. Exposed for tests that need a clean shutdown.
 */
export function stopFastApps(): void {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill('SIGTERM');
    sidecarProcess = null;
  }
}
