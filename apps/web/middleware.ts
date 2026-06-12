// P0 SECURITY GATE.
//
// Before this middleware existed, the same-origin proxy at /api/proxy/* injected
// the server-side FLOOM_API_SECRET and forwarded EVERY request (GET + mutations)
// to workers-api.floom.dev with no client authentication. Any anonymous internet
// visitor could read owner data (connections, secret inventory, approval drafts)
// AND mutate it (create/delete/run workers, approve approvals).
//
// This gate requires a valid session cookie (see lib/web-session.ts) for:
//   - all /api/proxy/* calls (missing/invalid cookie -> 401 JSON), and
//   - all app pages (missing/invalid cookie -> redirect to /login).
//
// It PRESERVES the genuinely-public surfaces (no login needed):
//   - /login + /api/auth/* (the login flow itself)
//   - /approvals/review : signed-link approval page for EXTERNAL approvers
//   - /api/proxy/approvals/public/* : the token-gated public approval endpoints
//     that the /approvals/review page calls from the browser
//   - /w/* : public worker share page (its data is fetched server-side via a
//     signed HMAC token, so it needs no proxy exception — only page access)
//   - /s/* : public standalone share pages for workers and Brain content
//   - Next.js internals + static assets
//
// It is ALSO the CSP source (#926): a per-request nonce replaces the old
// 'unsafe-inline' script-src from next.config.ts. Next.js reads the nonce out
// of the request's Content-Security-Policy header during SSR and stamps it on
// every framework/inline script, so pages must render dynamically (the root
// layout exports `dynamic = "force-dynamic"` — see #945, which independently
// requires that protected shells are not statically pre-rendered).

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/web-session";

// Pages reachable WITHOUT a session cookie. Exact path or prefix match.
const PUBLIC_PAGE_PREFIXES = [
  "/login",
  "/connections/callback", // OAuth provider return path; finishes via tokenless callback id
  "/approvals/review", // external signed-link approval review
  "/w/", // public worker share (token-gated, server-rendered)
  "/s/", // public standalone share (token-gated, server-rendered)
  "/c/", // branded claim short-link; rewritten to the API /c/{token} route,
  //       which 302s to the (auth-gated) /settings?…_claim= URL. The short-link
  //       hop itself carries no session, so it must stay public here.
];

// /api/proxy sub-paths that map to PUBLIC upstream endpoints and must stay
// reachable without a Workeros session (OAuth callbacks and signed approvals).
const PUBLIC_PROXY_PATHS = ["/api/proxy/connections/callback"];
const PUBLIC_PROXY_PREFIXES = ["/api/proxy/approvals/public/"];

function isPublicPage(pathname: string): boolean {
  if (pathname === "/login") return true;
  return PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

function isPublicProxy(pathname: string): boolean {
  if (PUBLIC_PROXY_PATHS.includes(pathname)) return true;
  return PUBLIC_PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// #947 — CSRF defence-in-depth. The /api/proxy/* surface injects the server
// secret and forwards mutations to the backend; SameSite=lax is the only thing
// stopping a cross-site POST today. Validate Origin (falling back to Referer)
// against the app's own host on every state-changing method.
//
// The proxy is browser-only: server components call the backend directly via
// lib/server-api, and CLI/MCP clients hit the API with x-floom-secret, never
// this route. So a browser fetch always carries Origin on a mutating request —
// its absence is anomalous and rejected.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  // The request's own host, plus the forwarded host (the public domain when a
  // platform rewrite/proxy fronts the function, e.g. the Cloud /app rewrite).
  const add = (h: string | null | undefined) => {
    if (h) hosts.add(h.split(",")[0].trim().toLowerCase());
  };
  add(req.nextUrl.host);
  add(req.headers.get("host"));
  add(req.headers.get("x-forwarded-host"));
  // Optional explicit allowlist for extra legitimate origins (comma-separated
  // host[:port] or full origins).
  for (const entry of (process.env.CSRF_TRUSTED_ORIGINS || "").split(",")) {
    const v = entry.trim();
    if (!v) continue;
    try {
      hosts.add(new URL(v.includes("://") ? v : `https://${v}`).host.toLowerCase());
    } catch {
      /* ignore malformed entry */
    }
  }
  return hosts;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when a mutating proxy request is same-origin (or absent of risk). */
function isCsrfSafe(req: NextRequest): boolean {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return true;
  const allowed = allowedHosts(req);
  const originHost = hostOf(req.headers.get("origin"));
  if (originHost) return allowed.has(originHost);
  // No Origin (some browsers omit it on same-origin in older versions): fall
  // back to Referer's host. If neither is present on a mutating request, reject.
  const refererHost = hostOf(req.headers.get("referer"));
  if (refererHost) return allowed.has(refererHost);
  return false;
}

// #926 — per-request nonce CSP. script-src drops 'unsafe-inline' and the broad
// https: allowance; 'strict-dynamic' lets nonce'd Next bootstrap scripts load
// their chunk graph. connect-src is same-origin (client API calls go through
// /api/proxy); CSP_EXTRA_CONNECT_SRC is the documented seam for self-hosted
// instances that talk to a cross-origin API from the browser. style-src keeps
// 'unsafe-inline' (Next/Tailwind inline styles; explicitly acceptable per the
// audit). img/font keep https: for remote logos/fonts — they cannot execute.
export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const extraConnect = (process.env.CSP_EXTRA_CONNECT_SRC || "").trim();
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self'${extraConnect ? ` ${extraConnect}` : ""}`,
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Per-request CSP nonce, threaded to Next via the request headers so SSR
  // stamps it onto inline/framework scripts (#926).
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const pageResponse = (opts?: { noStore?: boolean }) => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    // #945: protected/authenticated page shells must never be shared-cacheable.
    if (opts?.noStore) {
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
    }
    // Public, token-gated share surfaces must never be indexed: the standalone
    // share pages (/s/*) and the standalone approval review page
    // (/approvals/review). /w/* sets noindex via its page metadata.
    const isNoindexPath =
      pathname === "/s" ||
      pathname.startsWith("/s/") ||
      pathname === "/approvals/review" ||
      pathname.startsWith("/approvals/review");
    if (isNoindexPath) {
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  };

  // Auth endpoints are always reachable (you log in/out through them).
  if (pathname.startsWith("/api/auth/")) {
    return pageResponse();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await verifySessionToken(token) ||
    // Multi-member: a wos_session backend cookie is also valid — the backend validates it
    Boolean(req.cookies.get("wos_session")?.value);

  // ----- /api/proxy/* : the dangerous surface -----
  if (pathname.startsWith("/api/proxy")) {
    // #947: reject cross-site mutations before anything else. Applies even to
    // the public token-gated endpoints — they're called from same-origin pages,
    // so a legitimate request always passes; a cross-site forgery never does.
    if (!isCsrfSafe(req)) {
      return NextResponse.json(
        { detail: "Cross-origin request blocked." },
        { status: 403 },
      );
    }
    if (isPublicProxy(pathname)) {
      // Public, token-gated upstream endpoint (signed-link approvals). Allow.
      return pageResponse();
    }
    if (authed) {
      return pageResponse();
    }
    return NextResponse.json(
      { detail: "Authentication required." },
      { status: 401 },
    );
  }

  // ----- App pages -----
  if (isPublicPage(pathname)) {
    return pageResponse();
  }
  if (authed) {
    // Authenticated app shell: no shared cache may store it (#945).
    return pageResponse({ noStore: true });
  }

  // Not authed, non-public page -> send to login, preserving intended path.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const next = pathname + (req.nextUrl.search || "");
  if (next && next !== "/") {
    loginUrl.searchParams.set("next", next);
  }
  return NextResponse.redirect(loginUrl);
}

// Run on everything EXCEPT Next internals and common static assets. The matcher
// keeps the middleware off the static pipeline (favicon, _next, images, fonts),
// which both avoids redirect loops on assets and keeps it fast.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|css|js|map)$).*)",
  ],
};
