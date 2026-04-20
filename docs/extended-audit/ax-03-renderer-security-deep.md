# ax-03 — Renderer & static delivery security (fn-17 depth++)

Scope: `GET /renderer/:slug/{bundle.js,frame.html,meta}`, SPA static middleware in `apps/server/src/index.ts`, `securityHeaders` (`middleware/security.ts`), OG/static exclusions. Deliverable is pen-test style notes + prioritized findings. Cross-link `docs/PRODUCT.md` (renderer as first-class surface).

## Threat model (short)

- **R1 Path traversal / arbitrary file read** via URL-encoded paths or `..` segments.
- **R2 MIME sniff / XSS** if HTML/JS served with wrong `Content-Type` or without `nosniff`.
- **R3 CSP bypass** — parent page vs iframe; weak `script-src` on host.
- **R4 Cache poisoning** — CDN/browser caching HTML or JSON as script.
- **R5 Secret leakage in bundle** — creator mistake; out of scope for server hardening beyond caps/docs.

## Renderer routes (`routes/renderer.ts`)

| Asset | Path handling | CSP | MIME | Cache | Notes |
|-------|---------------|-----|------|-------|-------|
| `bundle.js` | `getBundleResult(slug)` → disk `join(RENDERERS_DIR, \`${slug}.js\`)` (`renderer-bundler.ts` ~117–121) | From `securityHeaders`: CSP skipped for `/renderer/` only when **own** CSP set — **bundle is JSON error or JS**; JS responses typically do not execute CSP in browsers | `application/javascript; charset=utf-8` + `nosniff` (~87–94) | `public, max-age=60, must-revalidate` | **Finding:** slug not validated with same regex as hub before `join`. `join(DATA_DIR/renderers, slug + '.js')` **normalizes `..`** — a slug like `../foo` can resolve **outside** `RENDERERS_DIR`. **P0/P1:** reject slugs not matching `/^[a-z0-9][a-z0-9-]*$/` at route boundary (mirror hub ingest). |
| `frame.html` | Same `getBundleResult`; HTML built server-side; `safeSlug = encodeURIComponent(slug)` in script `src` (~118–136) | `FRAME_CSP` (~41–51): `default-src 'none'`, `script-src 'self'`, `connect-src 'none'`, `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'` | `text/html; charset=utf-8` + `nosniff` + `X-Frame-Options: SAMEORIGIN` + `Referrer-Policy: no-referrer` (~138–149) | `no-cache` | Sandboxed iframe is parent’s responsibility (`allow-scripts` without `allow-same-origin` — see file header ~8–22). Strong CSP is defense in depth. |
| `meta` | JSON only (~53–68) | n/a | `application/json` (Hono default) | default | Low risk; same slug validation gap as bundle for **404 vs path leak** timing — minor. |

**Documentation bug:** comments at `renderer.ts` ~28–31 state bundles are behind `globalAuthMiddleware`; `index.ts` applies global auth only to `/api/*`, `/mcp/*`, `/p/*`. **`/renderer/*` is not bearer-gated** by `FLOOM_AUTH_TOKEN`. Align docs or add explicit optional gate policy.

## Top-level SPA static (`index.ts` ~804–905)

- Builds `candidate = join(webDist, pathname.replace(/^\//, ''))` (~843).
- **Finding:** request paths like `/assets/../../<sibling-of-webDist>` normalize via `join` and can escape `webDist` if the normalized path exists and is a file. **P1:** resolve realpath and assert `candidate.startsWith(webDistResolved + sep)` (or use `fs.open` with `path.relative` check) before `readFileSync`.
- **MIME map** (~846–868): reasonable coverage; unknown ext → `application/octet-stream`.
- **Cache:** HTML `no-cache`; assets `max-age=3600` — acceptable for hashed Vite assets.
- **CSP:** `securityHeaders` applies `TOP_LEVEL_CSP` to HTML responses except `/renderer/` prefix (`security.ts` ~69–74, ~103–105). Good separation.

## Global headers (`middleware/security.ts`)

- HSTS, `nosniff`, `Referrer-Policy` on all responses (~92–99).
- CSP for HTML; API/MCP JSON noted as low browser impact (~47–49) — still set if no prior CSP.

## Client contract

- `apps/web/src/lib/renderer-contract.ts` — postMessage schema; parent must validate messages to avoid XSS in parent DOM (out of server file scope; mention in regression checklist `ax-14`).

## Priority actions

| ID | Severity | Action |
|----|----------|--------|
| S1 | P0/P1 | Validate renderer `slug` param against hub slug regex before any filesystem `join`; reject `%2e%2e` variants (decode then validate). |
| S2 | P1 | Harden SPA static `join(webDist, …)` with resolved-path prefix check. |
| S3 | P2 | Fix `renderer.ts` auth comment vs `index.ts` behavior; document self-host choice: public renderer vs bearer + iframe cookie strategy. |
| S4 | P2 | Consider `Content-Disposition: attachment` for non-executable sensitive extensions under static — low priority. |

## Regression probes (manual)

1. `GET /renderer/%2e%2e%2f%2e%2e/bundle.js` → should **404**, not read arbitrary files.
2. `GET /assets/../../../etc/passwd` (or equivalent outside `webDist`) → **404** or safe failure.
3. Response headers on `/renderer/x/frame.html` include `FRAME_CSP` and duplicate CSP not overwritten by `securityHeaders`.
