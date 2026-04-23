# Security Headers — single source of truth

The Floom Hono middleware at `apps/server/src/middleware/security.ts` is the
sole emitter of the following response headers:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` (routes may override to stricter, e.g. `no-referrer` for `/renderer/:slug/frame.html`) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-site` |
| `Cross-Origin-Embedder-Policy` | `credentialless` |
| `Content-Security-Policy` | see `TOP_LEVEL_CSP` in middleware (no `'unsafe-inline'` in fallback `style-src`) |

## Do NOT duplicate at the edge

Pentest finding LOW #383 observed three headers emitted twice — once by the
app middleware and once by the edge proxy (nginx). Browsers then see
`header: v1, v2` (Fetch API appends rather than overwrites on duplicate
headers). For HSTS specifically, the second copy lacked `preload`, which
disqualifies the domain from the HSTS preload list.

**If the deployment fronts Floom with nginx, Cloudflare, or any reverse
proxy, the operator MUST remove these `add_header`/page-rule emissions:**

```nginx
# REMOVE any of these that appear in sites-enabled/floom.* :
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header X-Frame-Options SAMEORIGIN always;   # pentest LOW #384
```

The app's middleware will emit the authoritative versions on every
response. If you need to override (e.g. a route-specific `Referrer-Policy:
no-referrer` for `/renderer/*`), set the header inside the route handler
*before* `next()` returns — the middleware's `!c.res.headers.get(...)` guards
leave route-set values intact.

## Why not emit at the edge?

1. Single place to review in code review.
2. The app already has per-route nuance (renderer frame CSP, frame
   referrer-policy). Splitting across nginx + app would force two code
   paths in sync.
3. Docker deploys ship without nginx in front by default; moving the
   headers into the app means `docker run` alone gives a launch-grade
   response profile.
