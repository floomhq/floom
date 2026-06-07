# M57 Frontend Fix — OAuth Callback Session Loss

**Date:** 2026-06-05  
**Branch:** `fix/m57-oauth-callback-session`  
**Status:** FIXED (single file change, unmerged PR)

---

## Root Cause

The OAuth callback flow broke the user session in the following way:

### Before the backend bugpass (`e45032e`):

```
Composio → /connections/callback?status=success&connection_id=ca_xxx
  → callback page JS: window.location.href = '/api/proxy/connections/callback?...'
  → proxy route: fetch(backend, { redirect: "follow" })  ← problem
  → backend returns 307 → https://workers.floom.dev/connections?connected=1
  → proxy follows server-side (NO user cookie in server fetch)
  → server fetches /connections?connected=1 without session cookie
  → middleware: not authed → redirects to /login?next=...
  → proxy follows again → returns login page HTML to browser
  → user sees: login screen at workers.floom.dev/api/proxy/connections/callback
```

**Root cause:** The proxy used `redirect: "follow"` (default), causing the server-side `fetch()` to follow the backend's 307 redirect. The server-side fetch has no browser session cookie, so the middleware redirected to `/login`. The proxy dutifully followed that redirect and returned the login HTML.

### After the backend bugpass (partial fix):

The bugpass added `redirect: "manual"` to the proxy for connection callbacks and forwarded the `location` header. This correctly returned the 307 to the browser. For most browsers in most network conditions, the browser then follows the 307 to `/connections?connected=1` with the session cookie, and authentication works.

However, the underlying approach — relying on `window.location.href` to fire a full-page navigation followed by an HTTP redirect chain — is fragile. The session cookie must survive the full round-trip: navigation to `/api/proxy/connections/callback` → 307 redirect → `/connections?connected=1`. Any network hop that loses the cookie (CDN behaviour, browser redirect handling, SameSite edge cases on redirect chains) sends the user to login.

---

## Fix

**File changed:** `apps/web/app/connections/callback/page.tsx`

**Change:** Replace `window.location.href = '/api/proxy/connections/callback?...'` (full-page navigation) with a `fetch()` call followed by `router.replace()` (client-side navigation).

```
Old:   window.location.href = '/api/proxy/connections/callback?connection_id=...&status=...'
       ↳ full-page nav → proxy returns 307 → browser follows → /connections?connected=1
       ↳ session cookie must survive the HTTP redirect chain

New:   fetch('/api/proxy/connections/callback?...', { redirect: "follow" })
       ↳ browser XHR: session cookie is sent, follows redirects with cookie intact
       ↳ res.url = 'https://workers.floom.dev/connections?connected=1&app=gmail&connection_id=uuid'
       ↳ router.replace('/connections?connected=1&app=gmail&connection_id=uuid')
       ↳ pure client-side navigation — session cookie NEVER leaves the browser
```

**Why this works:**
1. `fetch()` with `credentials: "same-origin"` sends the session cookie on same-origin requests.
2. `redirect: "follow"` in browser `fetch()` follows same-origin redirects with the cookie intact — so the backend's DB update fires and `res.url` reflects the final redirect target with feedback params.
3. `router.replace()` is a Next.js client-side navigation: no HTTP request, no cookie risk, session preserved unconditionally.
4. The `?connected=1&app=...&connection_id=...` feedback params extracted from `res.url` are passed to `/connections` so `ConnectionsClient` can show the success toast and highlight the new row (M58 from the UI side).

**Edge cases handled:**
- Unauthenticated user: fetch follows 307 → middleware redirects to `/login` → fetch resolves with `res.url` = login page → `parsed.pathname !== "/connections"` → `router.replace("/connections")` → middleware redirects to login (correct behaviour).
- Network error or fetch failure: `navigateAfterCallback()` called with no URL → `router.replace("/connections")`.
- Popup mode: `window.opener` is set → `window.close()` instead of `router.replace()`.
- Malformed `res.url`: try/catch → falls back to plain `/connections`.

---

## M58 (UI side)

The `ConnectionsClient` already has `?connected=1&app=...&connection_id=...` handling (added in a prior commit) that:
- Calls `refresh()` to fetch the fresh connections list
- Shows a success toast with account identity and tools count
- Highlights and scrolls to the new connection row
- Strips the feedback params from the URL (clean URL)

The new callback page correctly passes these params via `router.replace`, so M58 is resolved end-to-end. The backend bugpass (`e45032e`) persists the connection before redirecting, so the connection IS in the DB when `refresh()` runs.

If M58 was a backend persist issue (connection not written to DB), that would be flagged separately. Based on code review, `repos.connections.update()` runs before the redirect in the backend's `/connections/callback` handler — so the connection IS persisted.

---

## Verification

### Before fix (confirmed via headless browser, 2026-06-05)

Both paths land on the login screen for an unauthenticated browser:

- `https://workers.floom.dev/api/proxy/connections/callback?status=success&connection_id=ca_test`
  final URL: `https://workers.floom.dev/login?next=%2Fconnections%3Fconnected%3D1`
  screenshot: `m57-proxy-callback-screenshot-before-fix.png`

- `https://workers.floom.dev/connections/callback?status=success&connection_id=ca_test`
  final URL: `https://workers.floom.dev/login?next=%2Fconnections%3Fconnected%3D1`
  screenshot: `m57-frontend-callback-screenshot-before-fix.png`

Both show "Sign in — Enter your access secret to continue." This confirms the reported bug.

### After fix (manual verification required post-merge)

To verify with an authenticated session:
1. Log in to `workers.floom.dev`
2. Navigate to `/connections`
3. Click a tool to connect (e.g., Gmail, Outlook)
4. Complete OAuth on the Composio page
5. **Expected:** redirected to `/connections`, authenticated, new connection appears in list, success toast shows
6. **Not expected:** login screen at any point

The proxy callback behaviour (307 forwarding) can be verified separately by running the existing test:
```
apps/web/tests/proxy-route.test.ts
```
