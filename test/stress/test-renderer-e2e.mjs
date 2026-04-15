#!/usr/bin/env node
// Renderer end-to-end tests.
//
// 1. Ingest the flyfast example apps.yaml (with the renderer field) via
//    ingestOpenApiApps and assert that the custom renderer bundle is
//    created on disk + indexed in memory.
// 2. Hit the rendererRouter (Hono app fragment) via app.fetch() and assert:
//    - GET /renderer/flyfast/meta returns 200 with the right shape
//    - GET /renderer/flyfast/bundle.js returns 200 with the right headers
//    - GET /renderer/nonexistent/bundle.js returns 404
// 3. ErrorBoundary fallback: rendering a crashing component through
//    RendererShell falls back to the default for the shape.
//
// Heavy-lift: starts from a throwaway DATA_DIR so no real DB is touched.

import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'floom-renderer-e2e-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';

const { ingestOpenApiApps } = await import(
  '../../apps/server/src/services/openapi-ingest.ts'
);
const {
  getBundleResult,
  clearBundleIndexForTests,
  RENDERERS_DIR,
} = await import('../../apps/server/src/services/renderer-bundler.ts');
const { rendererRouter } = await import('../../apps/server/src/routes/renderer.ts');
// hono lives under apps/server/node_modules; use a relative path so Node
// resolves it from the server dir regardless of the test file location.
const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');

// For the ErrorBoundary test we need React + server renderer.
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { RendererShell } = await import(
  '../../packages/renderer/src/RendererShell.tsx'
);

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

console.log('renderer E2E tests');

// ---- 1. Ingest + bundle via fixture apps.yaml ----
// Copy the flyfast example into a temp manifest dir so we can point
// ingestOpenApiApps at an apps.yaml that references ./renderer.tsx
// (relative to the manifest file).
const here = dirname(fileURLToPath(import.meta.url));
const srcExample = join(here, '..', '..', 'examples', 'flyfast');
const destExample = join(tmp, 'flyfast');
cpSync(srcExample, destExample, { recursive: true });

// The ingest also fetches the OpenAPI spec, and our fixture uses a relative
// file reference `./openapi.yaml`. The real ingest only handles http URLs,
// so rewrite the apps.yaml to omit openapi_spec_url and accept the empty
// spec fallback (the ingest path still runs for the renderer field).
const fixtureYaml = `apps:
  - slug: flyfast
    type: proxied
    display_name: FlyFast
    description: Test flight search
    renderer:
      kind: component
      entry: ./renderer.tsx
      output_shape: table
`;
const fixturePath = join(destExample, 'apps.yaml');
writeFileSync(fixturePath, fixtureYaml);

clearBundleIndexForTests();
const ingestResult = await ingestOpenApiApps(fixturePath);
log('ingest: runs without throwing', typeof ingestResult === 'object');
log('ingest: apps_ingested >= 1', ingestResult.apps_ingested >= 1);

// Give the fire-and-forget bundle a moment to settle. bundleRendererFromManifest
// returns a promise but ingest does `void` it — wait briefly for the esbuild
// compilation to finish.
await new Promise((r) => setTimeout(r, 800));

const bundle = getBundleResult('flyfast');
log('bundler: flyfast bundle indexed', !!bundle);
if (bundle) {
  log('bundler: flyfast bundle file exists', existsSync(bundle.bundlePath));
  log('bundler: output_shape = table', bundle.outputShape === 'table');
  log('bundler: bytes > 0', bundle.bytes > 0);
}

// ---- 2. Serve via rendererRouter ----
const app = new Hono();
app.route('/renderer', rendererRouter);

const metaRes = await app.fetch(new Request('http://localhost/renderer/flyfast/meta'));
log('GET /renderer/flyfast/meta: 200', metaRes.status === 200);
if (metaRes.status === 200) {
  const body = await metaRes.json();
  log('GET /renderer/flyfast/meta: slug', body.slug === 'flyfast');
  log('GET /renderer/flyfast/meta: output_shape', body.output_shape === 'table');
  log('GET /renderer/flyfast/meta: bytes > 0', body.bytes > 0);
  log('GET /renderer/flyfast/meta: source_hash present', body.source_hash?.length === 16);
}

const bundleRes = await app.fetch(
  new Request('http://localhost/renderer/flyfast/bundle.js'),
);
log('GET /renderer/flyfast/bundle.js: 200', bundleRes.status === 200);
if (bundleRes.status === 200) {
  log(
    'GET /renderer/flyfast/bundle.js: content-type javascript',
    bundleRes.headers.get('content-type')?.includes('javascript'),
  );
  log(
    'GET /renderer/flyfast/bundle.js: x-floom-renderer-hash header',
    !!bundleRes.headers.get('x-floom-renderer-hash'),
  );
  log(
    'GET /renderer/flyfast/bundle.js: x-floom-renderer-shape=table',
    bundleRes.headers.get('x-floom-renderer-shape') === 'table',
  );
  const text = await bundleRes.text();
  log('GET /renderer/flyfast/bundle.js: body contains banner', text.includes('Floom custom renderer bundle'));
  log('GET /renderer/flyfast/bundle.js: body references flyfast-results', text.includes('flyfast-results'));
}

const missingRes = await app.fetch(
  new Request('http://localhost/renderer/ghost/bundle.js'),
);
log('GET /renderer/ghost/bundle.js: 404', missingRes.status === 404);

// ---- 3. ErrorBoundary + RendererShell state machine ----
// renderToStaticMarkup does NOT invoke React error boundaries (they are a
// client-only feature). So we test the boundary behavior by directly
// exercising the class's lifecycle hooks, which is what React would do
// during reconciliation. We also test the happy path via SSR and the
// state-machine gates via SSR (both of which don't involve throwing).

const { RendererErrorBoundary } = await import(
  '../../packages/renderer/src/RendererShell.tsx'
);

// getDerivedStateFromError should set error on the state.
const derived = RendererErrorBoundary.getDerivedStateFromError(new Error('boom'));
log(
  'ErrorBoundary: getDerivedStateFromError captures error',
  derived.error instanceof Error && derived.error.message === 'boom',
);

// Construct an instance and assert the render path falls back correctly.
// Silence the console.error noise that componentDidCatch produces.
const origConsoleError = console.error;
console.error = () => {};

// Instance with an error state + a table fallback shape → renders the default
// table with the passed-through data.
const boundary = new RendererErrorBoundary({
  fallbackShape: 'table',
  fallbackProps: {
    state: 'output-available',
    data: [
      { origin: 'BER', destination: 'LIS', price_eur: 120 },
      { origin: 'BER', destination: 'LIS', price_eur: 150 },
    ],
  },
  children: React.createElement('span', null, 'should not render'),
});
boundary.state = { error: new Error('custom renderer crashed') };
// Simulate componentDidCatch side-effect (just logs).
boundary.componentDidCatch(new Error('boom'), { componentStack: '' });
const fallbackEl = boundary.render();
const fallbackHtml = renderToStaticMarkup(fallbackEl);
log(
  'ErrorBoundary: fallback renders default table with data',
  fallbackHtml.includes('<table') && fallbackHtml.includes('120'),
);

// Without a fallbackShape, the boundary renders the error output card.
const boundary2 = new RendererErrorBoundary({
  fallbackProps: { state: 'output-error' },
  children: React.createElement('span', null, 'x'),
});
boundary2.state = { error: new Error('oops') };
const errEl = boundary2.render();
const errHtml = renderToStaticMarkup(errEl);
log(
  'ErrorBoundary: fallback with no shape renders ErrorOutput',
  errHtml.includes('oops') && errHtml.includes('renderer_crashed'),
);

console.error = origConsoleError;

// Happy path: non-crashing custom renderer renders instead of default.
function NiceRenderer({ data }) {
  return React.createElement('p', { className: 'nice' }, `${data.length} rows`);
}
const crashData = [
  { origin: 'BER', destination: 'LIS', price_eur: 120 },
  { origin: 'BER', destination: 'LIS', price_eur: 150 },
];
const shellHtml2 = renderToStaticMarkup(
  React.createElement(RendererShell, {
    state: 'output-available',
    shape: 'table',
    data: crashData,
    CustomRenderer: NiceRenderer,
  }),
);
log('RendererShell: happy path uses custom renderer', shellHtml2.includes('class="nice"'));
log('RendererShell: happy path echoes data', shellHtml2.includes('2 rows'));

// input-available state: always renders default loading regardless of custom
const shellHtml3 = renderToStaticMarkup(
  React.createElement(RendererShell, {
    state: 'input-available',
    shape: 'table',
    CustomRenderer: NiceRenderer,
  }),
);
log(
  'RendererShell: input-available uses default loading state',
  shellHtml3.includes('loading'),
);

// output-error state: always renders default ErrorOutput, ignores custom
const shellHtml4 = renderToStaticMarkup(
  React.createElement(RendererShell, {
    state: 'output-error',
    shape: 'table',
    error: { message: 'API down', code: 'upstream_error' },
    CustomRenderer: NiceRenderer,
  }),
);
log(
  'RendererShell: output-error uses default ErrorOutput, ignores custom',
  shellHtml4.includes('API down') && shellHtml4.includes('upstream_error'),
);

// output-available with no custom → default for shape
const shellHtml5 = renderToStaticMarkup(
  React.createElement(RendererShell, {
    state: 'output-available',
    shape: 'table',
    data: crashData,
  }),
);
log(
  'RendererShell: output-available no custom → default table',
  shellHtml5.includes('<table') && shellHtml5.includes('120'),
);

// Cleanup
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
