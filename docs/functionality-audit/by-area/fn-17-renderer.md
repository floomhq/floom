# Backend audit: custom renderer pipeline (`apps/server/src/routes/renderer.ts`, `apps/server/src/services/renderer-bundler.ts`, `apps/server/src/lib/renderer-manifest.ts`)

**Scope:** HTTP surface for compiled creator renderers (`GET /renderer/:slug/{bundle.js,frame.html,meta}`), esbuild bundling and on-disk layout under `DATA_DIR/renderers/`, in-memory bundle index, and pure manifest parsing helpers duplicated from `@floom/renderer/contract`. Cross-file wiring (`openapi-ingest`, `hub`, `middleware/security`, `index`) is referenced only where it affects sandboxing, cache correctness, secrets, or CSP.

**Product alignment:** Per `docs/PRODUCT.md`, **`renderer-bundler.ts` plus the web `CustomRendererPanel` / `CustomRendererHost`** are explicitly **load-bearing** as the **custom renderer pipeline** — a **P0 differentiator** versus a plain API gateway. This audit does not propose removal; it assesses how safely that pillar is implemented on the server.

---

## Sandbox paths (manifest entry vs. disk vs. URL slug)

### Ingest-time entry sandbox (`renderer-bundler.ts`)

- **`resolveEntryPath(entry, manifestDir)`** rejects absolute paths, literal `..` segments, resolves with `resolve(manifestDir, entry)`, and requires the result to stay under `manifestDir` (prefix check with `manifestDir + '/'` or equality). That blocks naive directory escape for declared `renderer.entry`.
- **Residual risk:** A path that stays *inside* `manifestDir` but targets a **symlink** can still cause esbuild to read **outside** the logical tree depending on OS resolution — typical for “trusted repo on ingest” models, but not as strong as a real chroot.

### URL slug → filesystem (`getBundleResult` + routes)

- Bundle files are addressed as **`join(RENDERERS_DIR, `${slug}.js`)`** with **no validation** of `slug` beyond whatever Hono passes from `/:slug/...`.
- **Critical gap:** `path.join(RENDERERS_DIR, `${slug}.js`)` **normalizes `..`**. A slug such as **`../../../etc/passwd`** produces an absolute path **outside** `RENDERERS_DIR`. If a matching file exists, **`readFileSync`** in **`GET /:slug/bundle.js`** can serve it as `application/javascript` — **arbitrary readable `.js` / mislabeled text** exposure, not limited to intended bundles.
- **`frame.html`** embeds `encodeURIComponent(slug)` in the script URL (good for HTML/script injection) but does **not** fix filesystem traversal for `getBundleResult(slug)`.
- **Comment drift:** `renderer.ts` states the renderer is behind the **same global auth gate** as the API; **`apps/server/src/index.ts`** applies **`globalAuthMiddleware`** only to **`/api/*`**, **`/mcp/*`**, and **`/p/*`**. **`/renderer`** is mounted **without** that gate (intentionally “public”; `openCors`, no bearer requirement). The **security model relies on sandbox + CSP + no secrets in bundle**, not on `FLOOM_AUTH_TOKEN` for these GETs.

### Intended browser sandbox (documented contract)

- **Server comments** and **`CustomRendererHost.tsx`** describe **`iframe sandbox="allow-scripts"`** (no `allow-same-origin`) plus **opaque origin** behavior — parent cookies/storage/APIs are out of scope for the iframe. That behavior is enforced in the **web app**, not in the three audited server files.

---

## Bundle cache (memory + disk)

### In-memory index (`bundleIndex` in `renderer-bundler.ts`)

- **`getBundleResult`:** serves from **`Map`** first; on miss, **hydrates from disk** (`<slug>.js`, optional `.hash`, `.shape`) and repopulates the map.
- **`forgetBundle(slug)`** (used from **`DELETE /api/hub/:slug/renderer`**) drops the cache entry so a removed bundle **404s** instead of returning stale metadata.
- **`clearBundleIndexForTests`** exists for isolation.
- **Stale paths:** If the **bundle file disappears** while the map still holds a `BundleResult`, **`GET .../bundle.js`** checks **`existsSync(bundle.bundlePath)`** and returns **404** even though meta might still be cached — acceptable.
- **Cold start:** New files on disk without a prior `bundleIndex` entry are picked up on first **`getBundleResult`** via the disk fallback.

### Idempotent rebuilds

- **`bundleRenderer`** skips a full esbuild run when **`.hash` on disk matches `hashSource(source)`**, updating only the in-memory index. Sidecars **`.hash`** and **`.shape`** track version and output shape hint.

### HTTP caching (`renderer.ts`)

- **`bundle.js`:** `Cache-Control: public, max-age=60, must-revalidate` plus **`x-floom-renderer-hash`** / **`x-floom-renderer-shape`** for clients that care about identity.
- **`frame.html`:** `no-cache` (appropriate given embedded slug + cache-busting query from hash).

---

## Secret leakage in bundles

### What the server puts into the artifact

- **esbuild `define`:** only **`process.env.NODE_ENV` → `"production"`** — no operator env wholesale injection.
- **Banner:** comment line with **slug + source hash** (non-secret metadata).
- **Wrapper (`buildWrapperSource`):** imports creator entry by **absolute path string** in generated source; output is **minified JS** for the browser — paths are not a runtime “leak” to the end user beyond reflecting build layout in rare edge cases.
- **Creator TSX:** anything the author **imports or hardcodes** (API keys, tokens) **will ship to every browser** that loads the bundle. That is inherent to “client renderer”; mitigations are **education**, **review**, and **linting**, not server stripping.

### What the bundle must not rely on

- **`connect-src 'none'`** on **`frame.html`** (see below) blocks **network exfiltration from the iframe document** to same-origin or third-party HTTP — secrets baked into JS are still **visible in DevTools** but harder to **phone home** from that context without a bypass (e.g. `postMessage` to parent — **parent must validate**; see `renderer-contract` on the web side, out of scope here).

---

## CSP interaction

### `FRAME_CSP` (`renderer.ts`, exported for tests)

- Tight document policy for the iframe HTML: **`default-src 'none'`**, **`script-src 'self'`** (module script loads **`/renderer/<slug>/bundle.js`** same origin), **`connect-src 'none'`**, **`frame-ancestors 'self'`**, **`base-uri 'none'`**, **`form-action 'none'`**, limited **`img-src` / `font-src`**, **`style-src 'self' 'unsafe-inline'`** for React inline styles.
- **404** responses for missing renderer still attach **`FRAME_CSP`** on the text body where applicable — consistent lockdown.

### Global middleware (`middleware/security.ts`)

- **`TOP_LEVEL_CSP`** applies to HTML responses **except** paths under **`/renderer/`**, where routes **own** CSP. **`securityHeaders`** does **not** overwrite an existing **`Content-Security-Policy`** header.
- **`/renderer/*`** therefore keeps **`FRAME_CSP`** for **`frame.html`** without being replaced by the looser app shell policy. **`bundle.js`** is not HTML; CSP there is largely moot, and the exempt prefix avoids awkward double policies.

### Parent page vs. iframe

- **`TOP_LEVEL_CSP`** includes **`frame-src 'self'`**, allowing the app to embed **`/renderer/:slug/frame.html`**. **`frame-ancestors 'none'`** on the top-level policy concerns the **shell** document, while **`FRAME_CSP`** uses **`frame-ancestors 'self'`** so **only Floom** may frame the renderer page — layered embedding rules.

---

## `lib/renderer-manifest.ts` (parse-only)

- **`parseRendererManifest`** validates **`kind`**, **`entry`** (relative, no `..`, non-empty for `component`), and **`output_shape`** against an allowlist. **Filesystem is untouched** — traversal defenses for **`entry`** are completed in **`resolveEntryPath`** at bundle time.
- **Maintenance risk:** file is a **manual mirror** of `packages/renderer/src/contract/index.ts`; schema drift would diverge behavior between **Vite/tsx** consumers and **compiled server** unless both are updated together.

---

## Summary table

| Area | Assessment |
|------|------------|
| **Ingest entry path** | Strong relative-path + containment checks in **`resolveEntryPath`**; symlink caveats remain. |
| **URL `slug` → disk** | **Unsafe:** missing slug allowlist allows **`..` normalization** outside **`RENDERERS_DIR`** on **`GET .../bundle.js`** (and meta/frame paths that call **`getBundleResult`**). **Recommend:** enforce the same **`/^[a-z0-9][a-z0-9-]*$/`** (or stricter) as hub-created app slugs **before** `join`, or resolve realpath and require prefix under **`RENDERERS_DIR`**. |
| **Bundle cache** | Coherent disk + memory model; **`forgetBundle`** on delete; disk fallback on cold cache; **`existsSync`** guards missing files after cache hit. |
| **Secrets in bundle** | No server env injection into bundle beyond **`NODE_ENV`**; creator-supplied secrets in source remain a **client-exposure** problem. |
| **CSP** | **`FRAME_CSP`** is strict and preserved by **`CSP_EXEMPT_PREFIXES`**; aligns with **`allow-scripts`** sandbox story on the client. |
| **Docs / comments** | **`renderer.ts`** auth note conflicts with **`index.ts`** routing; treat **`index.ts`** as ground truth. |
