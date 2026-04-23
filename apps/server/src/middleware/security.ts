// Security headers middleware (P1 hardening, GitHub #126).
//
// Applies a strict-but-shippable Content-Security-Policy, plus HSTS,
// Referrer-Policy, X-Content-Type-Options, Permissions-Policy, and the
// Cross-Origin-* isolation family, to every response.
//
// Scope decisions:
//   - `default-src 'self'` locks everything to same-origin by default.
//   - `script-src 'self'` — no inline scripts. The web bundle is shipped
//     as external ES modules from /assets/*.js so this is clean. The
//     only potential inline was the font-swap `onload=` handler in
//     index.html, which we removed in the same PR.
//     `application/ld+json` is a data block, not executable, so it's
//     exempt from script-src.
//   - `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`.
//     We split into the two sub-directives:
//     * `style-src-elem 'self' https://fonts.googleapis.com 'unsafe-inline'`
//       — stylesheets must come from same-origin or Google Fonts, and we
//       also allow runtime `<style>` tags. 18 React components across the
//       app render JSX `<style>{`@media ...`}</style>` tags to carry their
//       responsive behaviour (AppGrid, AppPermalinkPage, PricingPage,
//       AboutPage, LandingV17Page, HeroAppTiles, LayersGrid, ProofRow,
//       etc.). Before 2026-04-24 we had `'unsafe-inline'` stripped from
//       this directive (pentest MED #380), which silently killed EVERY
//       one of those `@media` rules — mobile `/apps` stacked 4 tiles in a
//       73.5px-wide column, `/p/:slug` mobile grid was broken, etc. The
//       responsive regression is far worse than the pentest finding it
//       was meant to close, so we've reinstated `'unsafe-inline'` here
//       and filed a follow-up (tracked in docs/ops/security-headers.md)
//       to migrate those inline `<style>` blocks into static CSS modules.
//       Once that migration lands, we can re-remove `'unsafe-inline'` from
//       `style-src-elem`.
//     * `style-src-attr 'unsafe-inline'` — allows `style="..."` attributes
//       only. 1,100+ React components use `style={{...}}` props across
//       the codebase; nonce/hash per-render is infeasible at SPA scale.
//   - `img-src 'self' data: https:` — OG images, external icon CDNs
//     (SimpleIcons, svgl, favicons), and data: for inline SVG sprites.
//   - `connect-src 'self' https://api.github.com` — same-origin API
//     calls plus the GitHub star-count fetch in components/home/BuiltBy.tsx.
//     Sentry is only wired on the server; the browser bundle does not
//     ship its own DSN. If we add a browser-side Sentry later, we'll
//     need to allowlist `https://*.ingest.sentry.io` here.
//   - `font-src 'self' https://fonts.gstatic.com` — Google Fonts is
//     loaded via `fonts.googleapis.com` (stylesheet, matched by
//     style-src-elem) which in turn references `fonts.gstatic.com` for
//     the woff2 files. Both need to be allowed.
//   - `frame-src 'self'` — the custom-renderer iframe lives same-origin
//     at /renderer/:slug/frame.html. No third-party frames.
//   - `frame-ancestors 'none'` — clickjacking defense. Replaces the
//     older `X-Frame-Options: SAMEORIGIN` nginx header; CSP's
//     frame-ancestors supersedes XFO on modern browsers.
//   - `base-uri 'self'` — prevents `<base href=...>` injection from
//     rewriting relative URLs.
//   - `form-action 'self'` — forms can only submit to same origin.
//   - `object-src 'none'` — blocks <object>/<embed>/<applet> entirely.
//
// Cross-origin isolation family (pentest MED #379):
//   - `Permissions-Policy` — disables powerful features we don't use
//     (camera, microphone, geolocation) plus `interest-cohort` (FLoC
//     opt-out).
//   - `Cross-Origin-Opener-Policy: same-origin` — blocks Spectre-style
//     cross-origin window handle leaks. Google OAuth popup flow still
//     works because the popup is same-origin (we open
//     `/auth/sign-in/social` on our own domain and Better Auth handles
//     the redirect server-side); the COOP check happens between the
//     opener and the opened window, not between the popup and Google.
//   - `Cross-Origin-Resource-Policy: same-site` — our own assets are
//     protected from cross-origin `<img src>` / `<script src>` embeds
//     from unrelated domains. `same-site` (not `same-origin`) is chosen
//     so preview.floom.dev, app.floom.dev, and floom.dev can still
//     cross-reference each other's assets on the .floom.dev tree.
//   - `Cross-Origin-Embedder-Policy: credentialless` — enables
//     cross-origin isolation without requiring every embedded image to
//     carry `Cross-Origin-Resource-Policy: cross-origin`. We
//     intentionally do NOT use `require-corp` because it would break
//     third-party images that don't set CORP headers (SimpleIcons,
//     favicons, user-supplied avatars).
//
// Exempt routes:
//   - `/renderer/:slug/frame.html` ships its own stricter CSP (see
//     routes/renderer.ts FRAME_CSP) plus a stricter `Referrer-Policy:
//     no-referrer`. We don't overwrite either.
//   - `/api/*` and `/mcp/*` return JSON/SSE which browsers don't
//     interpret as HTML, so CSP is effectively a no-op there. We still
//     set the other headers (HSTS, nosniff) on every response.
//
// Single source of truth (pentest LOW #383):
//   This middleware is the only place Floom emits HSTS / nosniff /
//   Referrer-Policy. If the deployment fronts the app with a reverse
//   proxy (nginx, Cloudflare) that also injects these headers, strip
//   them from the proxy config — otherwise the browser receives two
//   comma-joined values, the second HSTS tail ("…") is missing
//   `preload`, and we fail the HSTS preload list check. See
//   `docs/ops/security-headers.md` for the nginx snippet to remove.

import type { MiddlewareHandler } from 'hono';

/** Content-Security-Policy applied to every HTML response except
 * `/renderer/:slug/frame.html` (that route sets its own stricter CSP). */
export const TOP_LEVEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Style policies: we allow inline <style> tags until the JSX-<style>
  // responsive blocks (18 files) are migrated to static CSS modules.
  // See docs/ops/security-headers.md for the tracking item and the
  // block comment above for the full rationale.
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "style-src-elem 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://api.github.com",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Permissions-Policy header value. Disables powerful features Floom
 * doesn't use, plus FLoC (`interest-cohort`). */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), interest-cohort=()';

/** Paths that own their own CSP and must not be overwritten here. */
const CSP_EXEMPT_PREFIXES = ['/renderer/'];

function ownsCsp(pathname: string): boolean {
  return CSP_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Apply security headers to every response:
 *   - Content-Security-Policy (for HTML responses; not the renderer frame)
 *   - Strict-Transport-Security
 *   - Referrer-Policy
 *   - X-Content-Type-Options
 *   - Permissions-Policy (pentest MED #379)
 *   - Cross-Origin-Opener-Policy (pentest MED #379)
 *   - Cross-Origin-Resource-Policy (pentest MED #379)
 *   - Cross-Origin-Embedder-Policy (pentest MED #379)
 *
 * Hono's middleware runs after `next()`, so by the time we set headers the
 * response object is already populated. We never clobber a downstream
 * `Content-Security-Policy` that a route set itself.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  const pathname = new URL(c.req.url).pathname;

  // Pentest LOW #383 — this middleware is the single source of truth for
  // HSTS / nosniff / Referrer-Policy. A route that wants a stricter value
  // (e.g. the renderer frame.html setting `Referrer-Policy: no-referrer`)
  // is respected: we only fill in defaults when nothing has been set. If
  // an upstream reverse proxy (nginx) also injects these headers, remove
  // the proxy emission — otherwise Fetch API's `append`-behaving proxy
  // produces literal `foo, foo` duplicates. The app is authoritative.
  //
  // Browsers ignore HSTS on non-HTTPS responses so setting it in dev is
  // harmless.
  if (!c.res.headers.get('Strict-Transport-Security')) {
    c.res.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload',
    );
  }
  if (!c.res.headers.get('X-Content-Type-Options')) {
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  }
  if (!c.res.headers.get('Referrer-Policy')) {
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }

  // Pentest MED #379 — cross-origin isolation family + permissions gate.
  // Safe to apply to every response (JSON/HTML/SSE). Routes that need
  // different values (e.g. OAuth popups needing COOP=unsafe-none) can
  // override by setting the header before `next()` returns; we only set
  // when no downstream value is present.
  if (!c.res.headers.get('Permissions-Policy')) {
    c.res.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  }
  if (!c.res.headers.get('Cross-Origin-Opener-Policy')) {
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  }
  if (!c.res.headers.get('Cross-Origin-Resource-Policy')) {
    c.res.headers.set('Cross-Origin-Resource-Policy', 'same-site');
  }
  if (!c.res.headers.get('Cross-Origin-Embedder-Policy')) {
    // `credentialless` — NOT `require-corp`. require-corp would reject
    // cross-origin images (SimpleIcons, favicons, user avatars) that
    // don't ship a CORP header of their own.
    c.res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  }

  // Pentest LOW #384 — frame-ancestors in CSP supersedes X-Frame-Options
  // on every browser still in support (Chrome 76+, Firefox 103+, Safari
  // 17+). Middleware does not emit XFO; routes that need legacy framing
  // behaviour can opt in explicitly, but new code should rely on the CSP
  // `frame-ancestors` directive instead.

  // CSP: skip routes that set their own (renderer frame) and skip when a
  // route already set a CSP header explicitly.
  if (!ownsCsp(pathname) && !c.res.headers.get('Content-Security-Policy')) {
    c.res.headers.set('Content-Security-Policy', TOP_LEVEL_CSP);
  }
};
