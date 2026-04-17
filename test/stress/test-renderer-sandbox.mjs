#!/usr/bin/env node
// Renderer sandbox security tests.
//
// Verifies the sec/renderer-sandbox-2026-04-17 hardening:
//   1. GET /renderer/:slug/frame.html returns HTML with a strict CSP header
//      (default-src 'none', connect-src 'none', frame-ancestors 'self', etc.)
//   2. The frame.html body references the bundle with the correct hash-
//      busted URL and does NOT inline any script.
//   3. GET /renderer/:slug/bundle.js sends X-Content-Type-Options: nosniff
//      (blocks JSON-as-script sniffing attacks).
//   4. The compiled bundle wraps the creator's default export with the
//      postMessage ready/init/rendered protocol, so the bundle cannot
//      execute arbitrary startup code without the parent's handshake.
//   5. The renderer-contract.ts helpers (isRendererIncoming, isSafeLinkHref,
//      clampIframeHeight) reject malformed / dangerous inputs.
//
// A full browser-level proof that `fetch('/api/me')` is blocked by the CSP
// requires a real Chromium. That check is documented in the manual verify
// steps of docs/SELF_HOST.md and the workplan; this test asserts the server
// emits the headers that make the browser enforce the sandbox.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-renderer-sandbox-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';

const { bundleRenderer } = await import(
  '../../apps/server/src/services/renderer-bundler.ts'
);
const { rendererRouter, FRAME_CSP } = await import(
  '../../apps/server/src/routes/renderer.ts'
);
const {
  isRendererIncoming,
  isSafeLinkHref,
  clampIframeHeight,
} = await import('../../apps/web/src/lib/renderer-contract.ts');
const { Hono } = await import(
  '../../apps/server/node_modules/hono/dist/index.js'
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

console.log('renderer sandbox tests');

// ---- 1. Bundle a trivial renderer so /renderer/:slug/* resolves ----
const creatorDir = mkdtempSync(join(tmpdir(), 'floom-sandbox-creator-'));
const creatorPath = join(creatorDir, 'renderer.tsx');
writeFileSync(
  creatorPath,
  `import React from 'react';
export default function R({ data }) {
  return <div className="sandbox-ok">{JSON.stringify(data)}</div>;
}
`,
);
await bundleRenderer({ slug: 'sbx', entryPath: creatorPath, outputShape: 'object' });

// ---- 2. CSP header on frame.html ----
const app = new Hono();
app.route('/renderer', rendererRouter);

const frameRes = await app.fetch(
  new Request('http://localhost/renderer/sbx/frame.html'),
);
log('GET /renderer/sbx/frame.html: 200', frameRes.status === 200);
const cspHeader = frameRes.headers.get('content-security-policy') || '';
log('frame.html: CSP header present', cspHeader.length > 0);
log(
  'frame.html: CSP contains default-src \'none\'',
  cspHeader.includes("default-src 'none'"),
);
log(
  'frame.html: CSP contains script-src \'self\'',
  cspHeader.includes("script-src 'self'"),
);
log(
  'frame.html: CSP blocks all network via connect-src \'none\'',
  cspHeader.includes("connect-src 'none'"),
);
log(
  'frame.html: CSP restricts embedding via frame-ancestors \'self\'',
  cspHeader.includes("frame-ancestors 'self'"),
);
log(
  'frame.html: CSP blocks form submissions via form-action \'none\'',
  cspHeader.includes("form-action 'none'"),
);
log(
  'frame.html: CSP blocks base-uri injection',
  cspHeader.includes("base-uri 'none'"),
);
log('frame.html: CSP matches FRAME_CSP constant', cspHeader === FRAME_CSP);
log(
  'frame.html: X-Content-Type-Options nosniff',
  frameRes.headers.get('x-content-type-options') === 'nosniff',
);
log(
  'frame.html: Referrer-Policy no-referrer',
  frameRes.headers.get('referrer-policy') === 'no-referrer',
);

// ---- 3. frame.html body has no inline script, loads bundle via <script src> ----
const frameBody = await frameRes.text();
log(
  'frame.html: loads bundle via <script type="module" src="...">',
  /<script\s+type="module"\s+src="\/renderer\/sbx\/bundle\.js/.test(frameBody),
);
log(
  'frame.html: has #root mount point',
  frameBody.includes('id="root"'),
);
// There must be no inline <script>...</script> content, only external srcs.
// The regex permits `<script ...src="..."></script>` but fails on
// `<script>...code...</script>`. Under `script-src 'self'` without nonce,
// inline scripts would be blocked — we keep the body inline-script-free so
// this stays future-proof.
const inlineScriptMatch = /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(
  frameBody,
);
log('frame.html: no inline <script> blocks', !inlineScriptMatch);

// 404 path still ships CSP so a misconfigured embed can't be leveraged.
const missing404 = await app.fetch(
  new Request('http://localhost/renderer/ghost/frame.html'),
);
log('frame.html missing slug → 404', missing404.status === 404);
log(
  'frame.html 404 still sends CSP',
  (missing404.headers.get('content-security-policy') || '').length > 0,
);

// ---- 4. Bundle response hardening ----
const bundleRes = await app.fetch(
  new Request('http://localhost/renderer/sbx/bundle.js'),
);
log('GET /renderer/sbx/bundle.js: 200', bundleRes.status === 200);
log(
  'bundle.js: X-Content-Type-Options nosniff',
  bundleRes.headers.get('x-content-type-options') === 'nosniff',
);
log(
  'bundle.js: content-type application/javascript',
  (bundleRes.headers.get('content-type') || '').includes('javascript'),
);

// ---- 5. Bundle contains the postMessage wrapper (not raw creator code) ----
const bundleText = await bundleRes.text();
log(
  'bundle.js: wrapper posts {type: "ready"} to parent',
  bundleText.includes('ready'),
);
log(
  'bundle.js: wrapper handles {type: "init"} from parent',
  bundleText.includes('init'),
);
log(
  'bundle.js: wrapper contains postMessage',
  bundleText.includes('postMessage'),
);
log(
  'bundle.js: wrapper mounts via createRoot',
  /createRoot|create_root/i.test(bundleText),
);
log(
  'bundle.js: creator code still reachable (className preserved)',
  bundleText.includes('sandbox-ok'),
);

// ---- 6. renderer-contract helpers ----
log(
  'isRendererIncoming: accepts well-formed ready',
  isRendererIncoming({ type: 'ready', slug: 'x' }),
);
log(
  'isRendererIncoming: accepts well-formed rendered',
  isRendererIncoming({ type: 'rendered', slug: 'x', height: 123 }),
);
log(
  'isRendererIncoming: rejects rendered with string height',
  !isRendererIncoming({ type: 'rendered', slug: 'x', height: '123' }),
);
log(
  'isRendererIncoming: rejects rendered with NaN height',
  !isRendererIncoming({ type: 'rendered', slug: 'x', height: Number.NaN }),
);
log(
  'isRendererIncoming: rejects rendered with negative height',
  !isRendererIncoming({ type: 'rendered', slug: 'x', height: -1 }),
);
log(
  'isRendererIncoming: rejects rendered with insane height (> 1M)',
  !isRendererIncoming({ type: 'rendered', slug: 'x', height: 2_000_000 }),
);
log(
  'isRendererIncoming: accepts link_click',
  isRendererIncoming({ type: 'link_click', slug: 'x', href: 'https://a.com' }),
);
log(
  'isRendererIncoming: rejects unknown type',
  !isRendererIncoming({ type: 'init', slug: 'x' }),
);
log('isRendererIncoming: rejects null', !isRendererIncoming(null));
log('isRendererIncoming: rejects string', !isRendererIncoming('ready'));
log('isRendererIncoming: rejects {}', !isRendererIncoming({}));

log('isSafeLinkHref: accepts https', isSafeLinkHref('https://a.com'));
log('isSafeLinkHref: accepts http', isSafeLinkHref('http://a.com'));
log('isSafeLinkHref: accepts mailto', isSafeLinkHref('mailto:a@b.com'));
log(
  'isSafeLinkHref: rejects javascript: URL',
  !isSafeLinkHref('javascript:alert(1)'),
);
log(
  'isSafeLinkHref: rejects data: URL',
  !isSafeLinkHref('data:text/html,<script>alert(1)</script>'),
);
log('isSafeLinkHref: rejects file: URL', !isSafeLinkHref('file:///etc/passwd'));
log(
  'isSafeLinkHref: rejects garbled input',
  !isSafeLinkHref('not a url'),
);

log('clampIframeHeight: clamps negative → 0', clampIframeHeight(-5) === 0);
log('clampIframeHeight: clamps NaN → 0', clampIframeHeight(Number.NaN) === 0);
log(
  'clampIframeHeight: clamps 10^9 → 10000',
  clampIframeHeight(1_000_000_000) === 10_000,
);
log('clampIframeHeight: preserves 500', clampIframeHeight(500) === 500);

// Cleanup
rmSync(tmp, { recursive: true, force: true });
rmSync(creatorDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
