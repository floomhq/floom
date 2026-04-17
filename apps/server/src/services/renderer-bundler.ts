// Custom renderer bundler.
//
// When an apps.yaml entry declares `renderer: { kind: component, entry: ./renderer.tsx }`,
// this service compiles the creator's TSX file into a standalone ESM bundle
// at ingest time. The bundle is written to DATA_DIR/renderers/<slug>.js and
// served by the GET /renderer/:slug/bundle.js route.
//
// Security model (sec/renderer-sandbox, 2026-04-17):
// The bundle runs inside a sandboxed iframe (/renderer/:slug/frame.html) with
// a strict CSP (script-src 'self', connect-src 'none', no allow-same-origin).
// The iframe receives run data via postMessage from the parent window. Because
// each bundle runs in its own document context with an opaque origin, react
// and react-dom are bundled INTO the creator's bundle (no longer external) so
// the iframe is fully self-contained. The bundler wraps the creator's default
// export with a tiny message-listener + mount stub so creators keep shipping
// plain React components — the runtime wiring is invisible to them.
//
// Key decisions:
// - esbuild in bundle mode with `format: esm` + `platform: browser`
// - react + react-dom/client bundled into each renderer (each iframe is its
//   own React root; dual-React is fine since they're in separate documents)
// - subresource integrity via SHA-256 hash of the source
// - size cap (512 KB) so a rogue renderer can't blow up the container
// - idempotent: re-bundling a hash we've seen before is a no-op

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DATA_DIR } from '../db.js';
import type { BundleResult, OutputShape } from '@floom/renderer/contract';

/**
 * esbuild needs to resolve `react` and `react-dom/client` from the creator's
 * (potentially scratch) manifest dir. The creator's tsx file lives under the
 * user's apps.yaml dir which likely has no `node_modules`. We point esbuild
 * at the @floom/renderer package's own `node_modules` (which has react as a
 * direct dep) via `nodePaths`. This lets the bundler work for any creator
 * dir without requiring the creator to install React themselves.
 *
 * Resolved lazily (via the `getReactNodePaths()` helper) so tests that point
 * DATA_DIR at a tmpdir still find react via the monorepo tree.
 */
function getReactNodePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up to the monorepo root and try a few candidate locations where
  // react may live in a pnpm layout. First match wins; all missing ones
  // are silently dropped.
  const candidates = [
    // apps/server/src → apps/server → apps → monorepo root
    resolve(here, '..', '..', '..', '..', 'packages', 'renderer', 'node_modules'),
    // dist layout: apps/server/dist → apps/server → apps → monorepo root
    resolve(here, '..', '..', '..', 'packages', 'renderer', 'node_modules'),
    // Fallback to the monorepo root node_modules (works in flat installs)
    resolve(here, '..', '..', '..', '..', 'node_modules'),
    resolve(here, '..', '..', '..', 'node_modules'),
  ];
  return candidates.filter((p) => existsSync(p));
}

/**
 * Where bundled renderers live on disk. Lives under DATA_DIR so it persists
 * across container restarts without hitting the DB.
 */
export const RENDERERS_DIR = join(DATA_DIR, 'renderers');

/**
 * Size cap (bytes) per bundled renderer. Enforced post-build.
 * Bumped from 256 KB to 512 KB in sec/renderer-sandbox because react +
 * react-dom/client are now bundled in (they used to be external and loaded
 * from the parent window; the iframe sandbox means each bundle ships its
 * own copy, adding ~140 KB minified).
 */
export const MAX_BUNDLE_BYTES = 512 * 1024;

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
 * Build the wrapper TSX that esbuild compiles alongside the creator's entry.
 *
 * The wrapper:
 *   - imports React + react-dom/client (bundled into the output)
 *   - imports the creator's default export
 *   - listens for `{type: 'init', output, status, app_slug}` postMessages
 *     from the parent, then renders the component into `#root`
 *   - posts `{type: 'rendered', height}` back, and watches for resize via a
 *     ResizeObserver so the parent can grow the iframe
 *   - intercepts link clicks and forwards `{type: 'link_click', href}` to the
 *     parent instead of navigating (the iframe has no origin anyway, so most
 *     navigations would fail; this makes clicks useful)
 *
 * The wrapper is intentionally tiny so that (a) it doesn't dominate the bundle
 * size cap and (b) the surface area creators see stays the same: default
 * export + React component, props = `{ data, status, app }`.
 */
export function buildWrapperSource(entryPath: string, slug: string): string {
  // JSON.stringify to produce a safely-quoted import specifier. The creator
  // path has already been validated by resolveEntryPath so it can't escape
  // the manifest dir; we still JSON.stringify here for defense in depth
  // against unusual characters in file names.
  const importSpec = JSON.stringify(entryPath);
  const slugLit = JSON.stringify(slug);
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Creator from ${importSpec};

const SLUG = ${slugLit};
let root = null;
let lastHeight = -1;

function postHeight() {
  try {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height) || 0;
    if (h !== lastHeight) {
      lastHeight = h;
      parent.postMessage({ type: 'rendered', slug: SLUG, height: h }, '*');
    }
  } catch (_) {}
}

function mount(payload) {
  const el = document.getElementById('root');
  if (!el) return;
  if (!root) root = createRoot(el);
  const { output, status, app_slug } = payload || {};
  root.render(
    React.createElement(Creator, {
      data: output,
      status: status || 'success',
      state: 'output-available',
      app: { slug: app_slug || SLUG },
    }),
  );
  // Defer so React commits before we measure.
  requestAnimationFrame(postHeight);
}

window.addEventListener('message', (ev) => {
  const d = ev && ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'init') mount(d);
});

// Any link click inside the iframe: forward to parent instead of navigating.
// Sandboxed iframe without allow-top-navigation can't navigate the top frame
// anyway, but this gives the parent a single validated hook to open URLs.
document.addEventListener('click', (ev) => {
  let t = ev.target;
  while (t && t !== document.body) {
    if (t.tagName === 'A' && t.href) {
      ev.preventDefault();
      parent.postMessage({ type: 'link_click', slug: SLUG, href: t.href }, '*');
      return;
    }
    t = t.parentNode;
  }
});

// Track size changes from async data / images loading after mount.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(postHeight).observe(document.documentElement);
}

// Signal to the parent we're ready to receive init.
parent.postMessage({ type: 'ready', slug: SLUG }, '*');
`;
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
  // The creator writes `export default function Renderer(props) { ... }`.
  // We wrap it with a stdin entry that bundles react + react-dom/client and
  // hooks up postMessage-driven mounting inside the sandboxed iframe. The
  // creator's file is imported via a JS-resolvable absolute path so esbuild
  // walks into it for types-erased output.
  const creatorImport = opts.entryPath.replace(/\\/g, '/');
  const wrapperSource = buildWrapperSource(creatorImport, opts.slug);
  const result = await build({
    stdin: {
      contents: wrapperSource,
      resolveDir: opts.entryPath.substring(
        0,
        opts.entryPath.length - basename(opts.entryPath).length,
      ),
      loader: 'tsx',
      sourcefile: `__floom_sandbox_${opts.slug}.tsx`,
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'react',
    // Point esbuild at the monorepo's @floom/renderer node_modules so
    // `react` + `react-dom/client` resolve even when the creator's manifest
    // directory has no node_modules of its own.
    nodePaths: getReactNodePaths(),
    // `@floom/renderer` stays external because it only exports types the
    // creator references (`import type { RenderProps }`); esbuild erases it.
    external: ['@floom/renderer'],
    write: false,
    minify: true,
    sourcemap: false,
    treeShaking: true,
    logLevel: 'silent',
    banner: {
      js: `// Floom custom renderer bundle · slug=${opts.slug} · hash=${sourceHash}`,
    },
    define: {
      'process.env.NODE_ENV': '"production"',
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
