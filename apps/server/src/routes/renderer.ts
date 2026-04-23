// Renderer bundle serving route.
//
// GET /renderer/:slug/bundle.js        — the compiled ESM bundle
// GET /renderer/:slug/frame.html       — sandboxed host page for the bundle
// GET /renderer/:slug/meta             — { slug, outputShape, bytes, sourceHash, compiledAt }
//
// Security model (sec/renderer-sandbox, 2026-04-17)
// ------------------------------------------------
// The web runner embeds `frame.html` inside an `<iframe sandbox="allow-scripts">`
// (no allow-same-origin). The iframe gets an opaque origin, so:
//   - it cannot read `document.cookie` on the parent
//   - it cannot `fetch('/api/me')` or any same-origin Floom endpoint
//   - it cannot reach `localStorage` or `sessionStorage` on the parent
//   - it cannot navigate the parent (no allow-top-navigation)
// The CSP we ship on `frame.html` tightens this further:
//   - `script-src 'self'`               only the bundle from this origin
//   - `connect-src 'none'`              no fetch / WebSocket / EventSource
//   - `frame-ancestors 'self'`          only Floom itself can embed this page
//   - `default-src 'none'`              everything else denied by default
//   - `img-src data: https:`            images are useful + low-risk
//   - `style-src 'self' 'unsafe-inline'` inline style attrs for React renders
// The bundle communicates with the parent via `postMessage`. See
// apps/web/src/lib/renderer-contract.ts for the wire format.
//
// The route is mounted in index.ts alongside the other Hono routers. Bundles
// live under DATA_DIR/renderers/<slug>.js (see services/renderer-bundler.ts).
//
// Auth: `/renderer/*` is intentionally NOT behind `globalAuthMiddleware`
// (see index.ts; the middleware is scoped to `/api/*`, `/mcp/*`, `/p/*`).
// A creator who ships a renderer means it to run in an end-user's browser
// tab, and the bundle contains no secrets (see renderer-bundler.ts). The
// safety story is: (1) slug must match `RENDERER_SLUG_RE` before we touch
// the filesystem — enforced centrally in `getBundleResult` — which kills
// path-traversal at the boundary; (2) `FRAME_CSP` on `frame.html` blocks
// `connect-src` so a rogue bundle can't phone home; (3) the parent
// embeds the iframe with `sandbox="allow-scripts"` (no `allow-same-origin`)
// so the bundle sees an opaque origin.

import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { getBundleResult } from '../services/renderer-bundler.js';

export const rendererRouter = new Hono();

/** CSP applied to `frame.html`. Exported so the security test can assert
 * against the exact header value. */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data: https:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

rendererRouter.get('/:slug/meta', (c) => {
  const slug = c.req.param('slug');
  const bundle = getBundleResult(slug);
  if (!bundle) {
    return c.json(
      { error: 'not_found', code: 'renderer_not_found', details: { slug } },
      404,
    );
  }
  return c.json({
    slug: bundle.slug,
    output_shape: bundle.outputShape,
    bytes: bundle.bytes,
    source_hash: bundle.sourceHash,
    compiled_at: bundle.compiledAt,
  });
});

rendererRouter.get('/:slug/bundle.js', (c) => {
  const slug = c.req.param('slug');
  const bundle = getBundleResult(slug);
  if (!bundle) {
    return c.json(
      { error: 'not_found', code: 'renderer_not_found', details: { slug } },
      404,
    );
  }
  if (!existsSync(bundle.bundlePath)) {
    return c.json(
      { error: 'not_found', code: 'renderer_bundle_missing', details: { slug } },
      404,
    );
  }
  const body = readFileSync(bundle.bundlePath);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60, must-revalidate',
      // `X-Content-Type-Options: nosniff` is set centrally by
      // `middleware/security.ts` (pentest LOW #383 — single source of
      // truth). Don't emit it here too.
      'x-floom-renderer-hash': bundle.sourceHash,
      'x-floom-renderer-shape': bundle.outputShape,
    },
  });
});

/**
 * Minimal HTML host for a custom renderer bundle. Returned with a strict CSP
 * (see FRAME_CSP) so the bundle can't fetch Floom APIs or navigate the
 * parent. The parent runner ships data in via postMessage; see
 * apps/web/src/lib/renderer-contract.ts.
 *
 * We never template the raw slug into any attribute; it's validated upstream
 * (hub ingest enforces `/^[a-z0-9][a-z0-9-]*$/`) and URL-encoded here as a
 * second layer.
 */
rendererRouter.get('/:slug/frame.html', (c) => {
  const slug = c.req.param('slug');
  const bundle = getBundleResult(slug);
  if (!bundle) {
    return c.text('renderer_not_found', 404, {
      'content-security-policy': FRAME_CSP,
    });
  }
  const safeSlug = encodeURIComponent(slug);
  const bust = bundle.sourceHash
    ? `?v=${encodeURIComponent(bundle.sourceHash)}`
    : '';
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>renderer</title>
<style>
  html,body{margin:0;padding:0;background:transparent;font-family:system-ui,-apple-system,Inter,sans-serif;color:#111;overflow:hidden}
  #root{width:100%}
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/renderer/${safeSlug}/bundle.js${bust}"></script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': FRAME_CSP,
      // Pentest LOW #384 — `X-Frame-Options: SAMEORIGIN` previously
      // shipped here as belt-and-braces next to FRAME_CSP's
      // `frame-ancestors 'self'`. On every browser still in support
      // (Chrome 76+, Firefox 103+, Safari 17+) CSP supersedes XFO, the
      // two directives conflict in the header inspector, and the
      // pentest flagged it as confusing hygiene. We drop XFO and let
      // the CSP directive be the sole clickjacking gate. The parent
      // runner's sandbox (`allow-scripts` without `allow-same-origin`)
      // still neutralises any direct framing attempt.
      //
      // `Referrer-Policy: no-referrer` is stricter than the top-level
      // default; the middleware respects route-set values after pentest
      // LOW #383. `X-Content-Type-Options: nosniff` is emitted by the
      // middleware — we don't duplicate it.
      'referrer-policy': 'no-referrer',
    },
  });
});
