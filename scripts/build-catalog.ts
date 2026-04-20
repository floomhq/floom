#!/usr/bin/env tsx
/**
 * Build a Floom app catalog from the APIs-guru OpenAPI directory.
 *
 * Fetches the APIs-guru list, filters for no-auth endpoints, resolves
 * base URLs (including Swagger 2.0 host/basePath and OpenAPI 3 server
 * variables), then verifies each candidate end-to-end by calling
 * POST /api/hub/detect on a live Floom instance. Only entries that
 * pass detect land in the output YAML.
 *
 * Usage (from monorepo root):
 *   tsx scripts/build-catalog.ts
 *   tsx scripts/build-catalog.ts --limit 200 --out catalog.yaml
 *   tsx scripts/build-catalog.ts --category financial,open_data --limit 200
 *   tsx scripts/build-catalog.ts --no-verify   # skip live detect pass
 *   tsx scripts/build-catalog.ts --detect-base https://floom.dev
 *
 * Outputs: catalog.yaml (or --out path)
 *
 * Original author: Vikas Veshishth (feat/openapi-catalog-100). Salvage
 * pass adds: template-variable resolution, strict Swagger 2.0 handling,
 * private/metadata host filter, and the live detect-verify pass that
 * turns "probably works" into "actually runs on floom.dev".
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const getArg = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag: string) => args.includes(flag);

const LIMIT = parseInt(getArg('--limit') ?? '200', 10);
const OUT_FILE = resolve(process.cwd(), getArg('--out') ?? 'catalog.yaml');
const CAT_FILTER = (getArg('--category') ?? '').split(',').filter(Boolean);
const FETCH_CONCURRENCY = 8;
const DETECT_CONCURRENCY = 6;
const DETECT_BASE = getArg('--detect-base') ?? 'https://floom.dev';
const SKIP_VERIFY = hasFlag('--no-verify');
const DETECT_TIMEOUT_MS = parseInt(getArg('--detect-timeout') ?? '8000', 10);
const TARGET = parseInt(getArg('--target') ?? String(LIMIT), 10);

// ---------- categories to include (skip cloud noise) ----------
const INCLUDE_CATS = CAT_FILTER.length > 0 ? new Set(CAT_FILTER) : new Set([
  'open_data', 'financial', 'developer_tools', 'analytics',
  'media', 'entertainment', 'location', 'messaging',
  'ecommerce', 'text', 'transport', 'tools', 'search',
  'collaboration', 'education', 'machine_learning',
]);

// ---------- provider prefixes to skip (too large / auth-heavy) ----------
// APIs-guru lists these with no `securitySchemes` even though the real
// service requires OAuth/tokens; every op would 401 at runtime. Also
// skips specs that would spawn dozens of variants (ghes versions,
// docusign, etc.) and clutter the hub.
const SKIP_PROVIDERS = [
  'amazonaws.com', 'azure.com', 'googleapis.com', 'google.com',
  'microsoft.com', 'salesforce.com', 'oracle.com', 'sap.com',
  'apisetu.gov', 'twilio.com', 'stripe.com',
  'github.com', 'gitlab.com', 'bitbucket.org',
  'docusign.com', 'docusign.net',
  'atlassian.com', 'jira.com',
  'slack.com', 'discord.com',
  'sendgrid.com', 'mailchimp.com', 'mailgun.com',
  'shopify.com', 'bigcommerce.com',
  'zoom.us', 'zendesk.com',
  'hubspot.com', 'dropbox.com', 'box.com', 'intuit.com',
];

// Cap per-provider variants — APIs-guru lists many versions of the same
// upstream (e.g. ghes-2.18, ghes-2.19, ...). Keep at most one per provider
// to stop the hub from being 80% GitHub/Adyen/etc.
const MAX_PER_PROVIDER = 1;

// Hosts that are clearly private / metadata / loopback and must never
// land in a public catalog regardless of what the spec says.
const FORBIDDEN_HOST_PATTERNS: RegExp[] = [
  /\.local$/i,
  /\.test$/i,
  /\.invalid$/i,
  /\.internal$/i,
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,                              // cloud metadata
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,           // RFC1918
  /^::1$/,
  /^fe80:/i,
];

// ---------- types ----------
interface ApisGuruVersion {
  swaggerUrl: string;
  info: {
    title?: string;
    description?: string;
    'x-apisguru-categories'?: string[];
    'x-logo'?: { url?: string };
  };
}

interface ApisGuruEntry {
  preferred: string;
  versions: Record<string, ApisGuruVersion>;
}

interface OpenApiServerVariable { default?: string; enum?: string[]; description?: string }
interface OpenApiServer { url: string; variables?: Record<string, OpenApiServerVariable> }
interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string };
  servers?: OpenApiServer[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, unknown>;
  security?: unknown[];
  components?: { securitySchemes?: Record<string, unknown> };
  securityDefinitions?: Record<string, unknown>;
}

interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  specUrl: string;
  baseUrl: string;
  category: string;
  icon?: string;
}

// ---------- helpers ----------

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function hostIsForbidden(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (!h) return true;
  return FORBIDDEN_HOST_PATTERNS.some((re) => re.test(h));
}

/**
 * Walk the spec for any declared security scheme AND for any operation
 * that lists security. Even when the global securityDefinitions block is
 * empty, individual ops can require auth — those are the specs that
 * silently fail at runtime with 401. Err on the side of skipping.
 */
function requiresAuth(spec: OpenApiSpec): boolean {
  const hasV2Schemes = !!spec.securityDefinitions && Object.keys(spec.securityDefinitions).length > 0;
  const hasV3Schemes = !!spec.components?.securitySchemes && Object.keys(spec.components.securitySchemes).length > 0;

  if (hasV2Schemes || hasV3Schemes) {
    const globalExplicitlyEmpty = Array.isArray(spec.security) && spec.security.length === 0;
    if (!globalExplicitlyEmpty) return true;
  }

  if (spec.paths) {
    for (const pathItem of Object.values(spec.paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const op of Object.values(pathItem as Record<string, unknown>)) {
        if (!op || typeof op !== 'object') continue;
        const security = (op as { security?: unknown[] }).security;
        if (Array.isArray(security) && security.length > 0) return true;
      }
    }
  }
  return false;
}

/**
 * Resolve a candidate base URL from a spec.
 *
 * Returns null if the URL cannot be resolved safely — unresolved template
 * variables (no default), private hosts, broken schemes all skip. We do
 * NOT fall back to the spec fetch URL origin, because APIs-guru serves
 * every spec under one host and that would point every app at the wrong
 * target.
 */
function resolveBaseUrl(spec: OpenApiSpec): string | null {
  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    const server = spec.servers[0]!;
    let url = server.url;

    const varPattern = /\{([^}]+)\}/g;
    const matches = [...url.matchAll(varPattern)];
    if (matches.length > 0) {
      for (const m of matches) {
        const varName = m[1]!;
        const def = server.variables?.[varName]?.default;
        if (!def) return null;
        url = url.replace(new RegExp(`\\{${varName}\\}`, 'g'), def);
      }
    }

    if (!/^https?:\/\//i.test(url)) return null;
    // https-only. Mixed-content blocks on floom.dev would break runs anyway.
    if (!/^https:\/\//i.test(url)) return null;
    try {
      const parsed = new URL(url);
      if (hostIsForbidden(parsed.hostname)) return null;
      return url.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  if (spec.host) {
    if (spec.host.includes('{') || spec.host.includes('}')) return null;
    // spec.host may include :port — strip it for the forbidden check.
    const hostOnly = spec.host.split(':')[0]!;
    if (hostIsForbidden(hostOnly)) return null;
    // Swagger 2.0: prefer https. If the spec doesn't list https, skip —
    // mixed-content on floom.dev would block the run.
    const schemes = Array.isArray(spec.schemes) ? spec.schemes : [];
    if (schemes.length > 0 && !schemes.includes('https')) return null;
    const scheme = 'https';
    const basePath = (spec.basePath ?? '').replace(/\/+$/, '');
    return `${scheme}://${spec.host}${basePath}`;
  }

  return null;
}

function descriptionSnippet(text: string | undefined): string {
  if (!text) return '';
  const first = text.replace(/\s+/g, ' ').split(/\.(\s|$)/)[0] ?? text;
  return first.length > 200 ? first.slice(0, 197) + '...' : first;
}

async function fetchSpec(url: string, timeoutMs = 10_000): Promise<OpenApiSpec | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json, text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text) as OpenApiSpec;
  } catch {
    return null;
  }
}

async function runConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency: number,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

interface DetectResult {
  ok: boolean;
  operationCount: number;
  error?: string;
}

async function detectProbe(specUrl: string): Promise<DetectResult> {
  try {
    const res = await fetch(`${DETECT_BASE}/api/hub/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openapi_url: specUrl }),
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, operationCount: 0, error: `http_${res.status}` };
    const body = await res.json() as { actions?: unknown[]; error?: string };
    const count = Array.isArray(body.actions) ? body.actions.length : 0;
    if (count < 1) return { ok: false, operationCount: 0, error: 'no_actions' };
    return { ok: true, operationCount: count };
  } catch (err) {
    return { ok: false, operationCount: 0, error: (err as Error).name || 'fetch_failed' };
  }
}

// ---------- main ----------

console.log(`\nFloom Catalog Builder — fetching APIs-guru list...\n`);

const listRes = await fetch('https://api.apis.guru/v2/list.json');
const list = await listRes.json() as Record<string, ApisGuruEntry>;

const candidates: Array<{ provider: string; version: ApisGuruVersion; specUrl: string }> = [];

for (const [provider, entry] of Object.entries(list)) {
  if (SKIP_PROVIDERS.some(p => provider.startsWith(p))) continue;

  const preferred = entry.preferred;
  const version = entry.versions[preferred] ?? Object.values(entry.versions)[0];
  if (!version) continue;

  const cats = version.info['x-apisguru-categories'] ?? [];
  if (cats.length === 0) continue;
  if (!cats.some(c => INCLUDE_CATS.has(c))) continue;

  if (!version.swaggerUrl) continue;
  candidates.push({ provider, version, specUrl: version.swaggerUrl });
}

console.log(`${candidates.length} candidates after category filter`);
console.log(`Phase 1: fetching + statically validating specs (concurrency=${FETCH_CONCURRENCY})\n`);

interface StaticCandidate extends CatalogEntry { provider: string }

const staticFailures = { fetch: 0, auth: 0, baseUrl: 0, paths: 0 };
const staticPool: StaticCandidate[] = [];
let checked = 0;

const STATIC_TARGET = Math.max(LIMIT * 3, 200);

for (let i = 0; i < candidates.length && staticPool.length < STATIC_TARGET; i += FETCH_CONCURRENCY * 4) {
  const batch = candidates.slice(i, i + FETCH_CONCURRENCY * 4);

  await runConcurrent(batch, async ({ provider, version, specUrl }) => {
    if (staticPool.length >= STATIC_TARGET) return null;

    const spec = await fetchSpec(specUrl);
    checked++;

    if (!spec) {
      staticFailures.fetch++;
      process.stdout.write('x');
      return null;
    }

    if (requiresAuth(spec)) {
      staticFailures.auth++;
      process.stdout.write('·');
      return null;
    }

    const baseUrl = resolveBaseUrl(spec);
    if (!baseUrl) {
      staticFailures.baseUrl++;
      process.stdout.write('?');
      return null;
    }

    if (!spec.paths || Object.keys(spec.paths).length === 0) {
      staticFailures.paths++;
      process.stdout.write('-');
      return null;
    }

    const cats = version.info['x-apisguru-categories'] ?? [];
    const cat = cats.find(c => INCLUDE_CATS.has(c)) ?? cats[0] ?? 'tools';
    const rawTitle = version.info.title ?? provider;
    const slug = slugify(rawTitle);
    const description = descriptionSnippet(version.info.description ?? version.info.title);

    staticPool.push({
      provider,
      slug,
      name: rawTitle,
      description: description || `${rawTitle} API`,
      specUrl,
      baseUrl,
      category: cat,
      icon: version.info['x-logo']?.url,
    });
    process.stdout.write('✓');
    return null;
  }, FETCH_CONCURRENCY);

  if (checked % 50 === 0 || staticPool.length >= STATIC_TARGET) {
    process.stdout.write(` [${staticPool.length} static-pass, ${checked} checked]\n`);
  }
}

console.log(`\n\nPhase 1 complete:`);
console.log(`  Static-pass pool: ${staticPool.length}`);
console.log(`  Fetch failures:   ${staticFailures.fetch}`);
console.log(`  Auth required:    ${staticFailures.auth}`);
console.log(`  No base_url:      ${staticFailures.baseUrl}`);
console.log(`  No paths:         ${staticFailures.paths}`);

// De-duplicate by provider root (collapse ghes-2.18, ghes-2.19, ... to
// the same bucket) and by slug (different providers sometimes pick the
// same display name). Caps variants via MAX_PER_PROVIDER.
function providerRoot(p: string): string {
  // Strip version/variant suffixes after a colon or forward slash.
  return p.split(':')[0]!.split('/')[0]!;
}

const providerCounts = new Map<string, number>();
const seenSlugs = new Set<string>();
const preDetect: StaticCandidate[] = [];
for (const e of staticPool) {
  const root = providerRoot(e.provider);
  const count = providerCounts.get(root) ?? 0;
  if (count >= MAX_PER_PROVIDER) continue;

  let slug = e.slug;
  let n = 1;
  while (seenSlugs.has(slug)) {
    slug = `${e.slug}-${++n}`;
    if (n > 99) break;
  }
  if (seenSlugs.has(slug)) continue;
  seenSlugs.add(slug);
  providerCounts.set(root, count + 1);
  preDetect.push({ ...e, slug });
}

const catalog: CatalogEntry[] = [];

if (SKIP_VERIFY) {
  console.log(`\n--no-verify: skipping detect pass, emitting static-pass entries\n`);
  for (const e of preDetect.slice(0, LIMIT)) {
    const { provider: _p, ...entry } = e;
    void _p;
    catalog.push(entry);
  }
} else {
  console.log(`\nPhase 2: live detect-verify against ${DETECT_BASE}/api/hub/detect`);
  console.log(`  concurrency=${DETECT_CONCURRENCY}, timeout=${DETECT_TIMEOUT_MS}ms per probe`);
  console.log(`  probing ${preDetect.length} candidates, target ${TARGET} live apps\n`);

  const detectStats = { ok: 0, http: 0, timeout: 0, noActions: 0, other: 0 };
  let probed = 0;

  await runConcurrent(preDetect, async (entry) => {
    if (catalog.length >= LIMIT) return null;

    const t0 = Date.now();
    const result = await detectProbe(entry.specUrl);
    const dt = Date.now() - t0;
    probed++;

    if (result.ok) {
      detectStats.ok++;
      const { provider: _p, ...rest } = entry;
      void _p;
      if (catalog.length < LIMIT) {
        catalog.push(rest);
        process.stdout.write('✓');
      }
    } else {
      if (result.error?.startsWith('http_')) detectStats.http++;
      else if (result.error === 'TimeoutError' || result.error === 'AbortError') detectStats.timeout++;
      else if (result.error === 'no_actions') detectStats.noActions++;
      else detectStats.other++;
      process.stdout.write(dt >= DETECT_TIMEOUT_MS - 100 ? 'T' : '.');
    }

    if (probed % 25 === 0) {
      process.stdout.write(` [${catalog.length} live, ${probed}/${preDetect.length} probed]\n`);
    }
    return null;
  }, DETECT_CONCURRENCY);

  console.log(`\n\nPhase 2 complete:`);
  console.log(`  Live detect passes:   ${detectStats.ok}`);
  console.log(`  Detect HTTP errors:   ${detectStats.http}`);
  console.log(`  Detect timeouts:      ${detectStats.timeout}`);
  console.log(`  Detect 0 actions:     ${detectStats.noActions}`);
  console.log(`  Detect other errors:  ${detectStats.other}`);
}

console.log(`\nFinal catalog size: ${catalog.length}\n`);

// ---------- write YAML ----------
const lines: string[] = [];
lines.push('# Floom public app catalog — built from APIs-guru.');
lines.push('# Generated by scripts/build-catalog.ts. Every entry below passed');
lines.push('# POST /api/hub/detect on a live Floom instance (unless --no-verify).');
lines.push('# Regenerate with: pnpm exec tsx scripts/build-catalog.ts');
lines.push('');
lines.push('apps:');

for (const e of catalog) {
  const safe = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

  lines.push('');
  lines.push(`  - slug: ${e.slug}`);
  lines.push(`    type: proxied`);
  lines.push(`    display_name: ${safe(e.name)}`);
  lines.push(`    description: ${safe(e.description)}`);
  lines.push(`    openapi_spec_url: ${safe(e.specUrl)}`);
  lines.push(`    base_url: ${safe(e.baseUrl)}`);
  lines.push(`    auth: none`);
  lines.push(`    category: ${safe(e.category)}`);
  lines.push(`    visibility: public`);
  if (e.icon) lines.push(`    icon: ${safe(e.icon)}`);
}

writeFileSync(OUT_FILE, lines.join('\n') + '\n');
console.log(`Written ${catalog.length} apps to ${OUT_FILE}`);
console.log(`\nTo load: FLOOM_APPS_CONFIG=${OUT_FILE} pnpm --filter @floom/server dev\n`);
