// Custom renderer bundler.
//
// When an apps.yaml entry declares `renderer: { kind: component, entry: ./renderer.tsx }`,
// this service compiles the creator's TSX file into a standalone ESM bundle
// at ingest time. The bundle is written to DATA_DIR/renderers/<slug>.js and
// served by the GET /renderer/:slug/bundle.js route.
//
// Key decisions:
// - esbuild in bundle mode with `format: esm` + `platform: browser`
// - react/react-dom marked as externals so the host page owns the React
//   instance (keeps the bundle tiny and avoids dual-React bugs)
// - subresource integrity via SHA-256 hash of the source
// - strict size cap (256 KB) so a rogue renderer can't blow up the container
// - idempotent: re-bundling a hash we've seen before is a no-op

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { DATA_DIR } from '../db.js';
import type { BundleResult, OutputShape } from '@floom/renderer/contract';

/**
 * Where bundled renderers live on disk. Lives under DATA_DIR so it persists
 * across container restarts without hitting the DB.
 */
export const RENDERERS_DIR = join(DATA_DIR, 'renderers');

/** Size cap (bytes) per bundled renderer. Enforced post-build. */
export const MAX_BUNDLE_BYTES = 256 * 1024;

/**
 * In-memory index of slug → BundleResult. Populated at ingest time and read
 * by the /renderer/:slug/bundle.js route. Kept in memory (not SQLite) because:
 *   (a) it's a cache of disk state, not a source of truth
 *   (b) the db.ts schema is owned by W2.1 this sprint and we must not touch it
 *   (c) the route can re-read from disk if the memory cache is cold
 */
const bundleIndex = new Map<string, BundleResult>();

export function getBundleResult(slug: string): BundleResult | undefined {
  const cached = bundleIndex.get(slug);
  if (cached) return cached;
  // Fallback: rebuild index from disk on demand.
  const candidate = join(RENDERERS_DIR, `${slug}.js`);
  if (existsSync(candidate)) {
    try {
      const stat = statSync(candidate);
      const sourceHashFile = `${candidate}.hash`;
      const hash = existsSync(sourceHashFile)
        ? readFileSync(sourceHashFile, 'utf-8').trim()
        : '';
      const shapeFile = `${candidate}.shape`;
      const shape = (existsSync(shapeFile)
        ? (readFileSync(shapeFile, 'utf-8').trim() as OutputShape)
        : 'text') as OutputShape;
      const result: BundleResult = {
        slug,
        bundlePath: candidate,
        bytes: stat.size,
        outputShape: shape,
        compiledAt: stat.mtime.toISOString(),
        sourceHash: hash,
      };
      bundleIndex.set(slug, result);
      return result;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function listBundles(): BundleResult[] {
  return Array.from(bundleIndex.values());
}

/** Test hook: forget the in-memory index. Tests should not rely on the filesystem state between runs. */
export function clearBundleIndexForTests(): void {
  bundleIndex.clear();
}

/**
 * Drop a single slug from the in-memory bundle index. Used by DELETE
 * /api/hub/:slug/renderer so a subsequent GET /renderer/:slug/bundle.js
 * correctly 404s instead of serving a stale cached BundleResult. The
 * on-disk files are the source of truth; this only invalidates the cache.
 */
export function forgetBundle(slug: string): void {
  bundleIndex.delete(slug);
}

/**
 * Hash the raw source bytes to enable idempotent re-builds.
 */
export function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function ensureRenderersDir(dir: string = RENDERERS_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Validate that `entry` exists + is inside `manifestDir`. Throws if either
 * check fails. Returns the resolved absolute path.
 */
export function resolveEntryPath(entry: string, manifestDir: string): string {
  if (isAbsolute(entry)) {
    throw new Error(`renderer.entry must be relative to the manifest, got absolute path: ${entry}`);
  }
  if (entry.includes('..')) {
    throw new Error(`renderer.entry must not contain ".." segments, got: ${entry}`);
  }
  const absolute = resolve(manifestDir, entry);
  // Confirm the resolved path is a descendant of manifestDir (defense in
  // depth against symlinks or ..-escaped relative paths slipping past the
  // string check).
  const relative = absolute.startsWith(manifestDir + '/') || absolute === manifestDir;
  if (!relative) {
    throw new Error(
      `renderer.entry resolves outside the manifest directory: ${absolute} not under ${manifestDir}`,
    );
  }
  if (!existsSync(absolute)) {
    throw new Error(`renderer.entry does not exist on disk: ${absolute}`);
  }
  return absolute;
}

export interface BundleOptions {
  slug: string;
  /** Absolute path to the creator's TSX file. Resolve via resolveEntryPath first. */
  entryPath: string;
  /** Optional shape pin for the fallback. */
  outputShape?: OutputShape;
  /** Override the default renderers dir (useful for tests). */
  outputDir?: string;
}

/**
 * Compile a creator's renderer.tsx into a standalone ESM bundle.
 *
 * The bundle:
 *   - has `react`, `react-dom`, `@floom/renderer` marked as externals so the
 *     host page owns the React instance
 *   - is written to <RENDERERS_DIR>/<slug>.js
 *   - ships a sidecar `.hash` and `.shape` for the /renderer route to serve
 *     `X-Floom-Renderer-Hash` and `X-Floom-Renderer-Shape` headers
 *   - is capped at MAX_BUNDLE_BYTES
 */
export async function bundleRenderer(opts: BundleOptions): Promise<BundleResult> {
  const source = readFileSync(opts.entryPath, 'utf-8');
  const sourceHash = hashSource(source);
  const outputDir = opts.outputDir || RENDERERS_DIR;
  ensureRenderersDir(outputDir);
  const bundlePath = join(outputDir, `${opts.slug}.js`);
  const shapeFile = `${bundlePath}.shape`;
  const hashFile = `${bundlePath}.hash`;

  // Idempotent skip: same hash on disk? Just update in-memory index.
  if (existsSync(bundlePath) && existsSync(hashFile)) {
    const existingHash = readFileSync(hashFile, 'utf-8').trim();
    if (existingHash === sourceHash) {
      const stat = statSync(bundlePath);
      const result: BundleResult = {
        slug: opts.slug,
        bundlePath,
        bytes: stat.size,
        outputShape: opts.outputShape || 'text',
        compiledAt: stat.mtime.toISOString(),
        sourceHash,
      };
      bundleIndex.set(opts.slug, result);
      return result;
    }
  }

  // Full rebuild.
  const result = await build({
    entryPoints: [opts.entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'react',
    external: ['react', 'react-dom', 'react-dom/client', '@floom/renderer'],
    write: false,
    minify: true,
    sourcemap: false,
    treeShaking: true,
    logLevel: 'silent',
    banner: {
      js: `// Floom custom renderer bundle · slug=${opts.slug} · hash=${sourceHash}`,
    },
  });

  const out = result.outputFiles?.[0];
  if (!out) {
    throw new Error(`bundleRenderer(${opts.slug}): esbuild produced no output`);
  }
  if (out.contents.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(
      `bundleRenderer(${opts.slug}): bundle size ${out.contents.byteLength} exceeds cap ${MAX_BUNDLE_BYTES}. Trim the renderer or split heavy deps out.`,
    );
  }

  writeFileSync(bundlePath, out.contents);
  writeFileSync(hashFile, sourceHash);
  writeFileSync(shapeFile, opts.outputShape || 'text');

  const bundleResult: BundleResult = {
    slug: opts.slug,
    bundlePath,
    bytes: out.contents.byteLength,
    outputShape: opts.outputShape || 'text',
    compiledAt: new Date().toISOString(),
    sourceHash,
  };
  bundleIndex.set(opts.slug, bundleResult);
  return bundleResult;
}

/**
 * High-level helper: bundle a creator's renderer from a manifest directory.
 *
 * Called from openapi-ingest whenever an app has `renderer.kind = component`.
 * Wraps bundleRenderer + resolveEntryPath. Returns null and logs on any error
 * (never throws — ingest should keep going even if one renderer fails).
 */
export async function bundleRendererFromManifest(
  slug: string,
  manifestDir: string,
  entry: string,
  outputShape?: OutputShape,
): Promise<BundleResult | null> {
  ensureRenderersDir();
  try {
    const entryPath = resolveEntryPath(entry, manifestDir);
    const result = await bundleRenderer({ slug, entryPath, outputShape });
    // eslint-disable-next-line no-console
    console.log(
      `[renderer-bundler] ${slug}: compiled ${entry} → ${result.bundlePath} (${result.bytes} bytes, shape=${result.outputShape})`,
    );
    return result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[renderer-bundler] ${slug}: failed to bundle ${entry}: ${(err as Error).message}`,
    );
    return null;
  }
}
