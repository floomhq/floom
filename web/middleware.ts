// Cloud auth gate + security headers.
//
// #935: the session cookie is now verified against the Supabase JWKS
//   (lib/verify-session.ts) instead of being trusted after a base64 decode.
//   A forged/tampered cookie no longer bypasses the login redirect.
// #926: per-request nonce CSP — script-src has no 'unsafe-inline' and no
//   broad https:. Next.js stamps the nonce onto its inline/framework scripts
//   during SSR. (The engine's synced next.config.ts stops shipping its static
//   CSP after the matching engine change lands; until that bump both headers
//   are sent and browsers enforce the intersection, which this policy
//   satisfies for nonce-stamped scripts.)
// #945: authenticated page shells answer with private/no-store so no shared
//   cache can store them.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/verify-session";

const SESSION_COOKIE = "workeros_cloud_session";
const APP_BASE_PATH = "/app";

function stripAppBase(pathname: string): string {
  if (pathname === APP_BASE_PATH) return "/";
  if (pathname.startsWith(`${APP_BASE_PATH}/`)) {
    return pathname.slice(APP_BASE_PATH.length) || "/";
  }
  return pathname;
}

function withAppBase(pathname: string): string {
  return `${APP_BASE_PATH}${pathname === "/" ? "" : pathname}`;
}

function isPublicPath(pathname: string): boolean {
  // Next.js with basePath strips it before passing to middleware in matcher,
  // but path here can be either /workers OR /app/workers depending on the
  // routing context. Handle both.
  const path = stripAppBase(pathname);
  if (path === "/favicon.ico") return true;
  if (path === "/login") return true;
  if (path.startsWith("/invite/")) return true;
  if (path === "/connections/callback") return true;
  if (path === "/privacy" || path === "/terms") return true;
  if (path === "/approvals/review") return true;
  if (path.startsWith("/s/")) return true;
  if (path.startsWith("/_next/")) return true;
  if (path.startsWith("/api/auth/")) return true;
  if (path.startsWith("/api/proxy/")) return true;
  if (path === "/api/me") return true;
  if (path.startsWith("/invites/")) return true;
  return false;
}

// #926 — kept in sync with the engine's middleware.ts policy. style-src keeps
// 'unsafe-inline' (explicitly acceptable per the audit); CSP_EXTRA_CONNECT_SRC
// is the seam for cross-origin browser APIs if ever needed.
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

// #947 — CSRF defence-in-depth, mirrored from the engine middleware. The cloud
// /api/proxy forwards the victim's Supabase Bearer token to the backend, so a
// cross-site mutation with their cookie is exactly as dangerous here. Validate
// Origin against the app's own host on every mutating method. The proxy is
// browser-only, so a legit mutation always carries Origin.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (h) hosts.add(h.split(",")[0].trim().toLowerCase());
  };
  add(req.nextUrl.host);
  add(req.headers.get("host"));
  add(req.headers.get("x-forwarded-host"));
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

function isCsrfSafe(req: NextRequest): boolean {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return true;
  const allowed = allowedHosts(req);
  const originHost = hostOf(req.headers.get("origin"));
  return originHost ? allowed.has(originHost) : false;
}

// Round-09 P0 #5 — App Router RSC/Flight prefetch + Next data requests must NOT
// receive a 307 HTML login redirect on failed auth. The client router expects an
// RSC (text/x-component) payload; a 307->/login HTML response is treated as a
// failed prefetch, throws React #418 (hydration mismatch), and HANGS soft <Link>
// navigation (only hard reloads render). Detect these by BOTH the semantic `rsc`
// header AND the `_rsc` cache-busting query param (Next can strip internal Flight
// headers/query from the NextRequest before user middleware sees them, so use
// both), plus router-prefetch/state-tree headers and Pages data
// (`x-nextjs-data` / `/_next/data/`). Verdict + verification: Codex vs
// next@16.2.6 source (`RSC_HEADER='rsc'`, Flight MPA-fallback logic).
function isRscOrDataRequest(req: NextRequest): boolean {
  const path = stripAppBase(req.nextUrl.pathname);
  return (
    req.headers.get("rsc") === "1" ||
    req.headers.has("next-router-prefetch") ||
    req.headers.has("next-router-state-tree") ||
    req.nextUrl.searchParams.has("_rsc") ||
    req.headers.has("x-nextjs-data") ||
    path.startsWith("/_next/data/")
  );
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const respond = (opts?: { noStore?: boolean }) => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    if (opts?.noStore) {
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
    }
    return response;
  };

  // #947: block cross-site mutations on the proxy before the public-path early
  // return (the cloud treats /api/proxy/* as public — backend verifies the
  // Bearer token — so CSRF is the relevant control here).
  if (
    stripAppBase(req.nextUrl.pathname).startsWith("/api/proxy/") &&
    !isCsrfSafe(req)
  ) {
    const response = NextResponse.json(
      { detail: "Cross-origin request blocked." },
      { status: 403 },
    );
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  }

  if (isPublicPath(req.nextUrl.pathname)) {
    return respond();
  }
  const session = req.cookies.get(SESSION_COOKIE);
  const verified = await verifySession(session?.value);
  if (!verified) {
    // Round-09 #5: never send a 307 HTML login redirect for an RSC/Flight or
    // Next data fetch — return a bodiless 401 (no-store) so the App Router
    // falls back to a hard MPA navigation instead of hanging the soft nav. The
    // page render + /api/proxy backend still enforce auth, so no protected RSC
    // payload leaks (a forged/missing cookie can never produce backend data).
    if (isRscOrDataRequest(req)) {
      const response = new NextResponse(null, { status: 401 });
      response.headers.set("Content-Security-Policy", csp);
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      return response;
    }
    const path = stripAppBase(req.nextUrl.pathname);
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${withAppBase(path)}${req.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  // #945: authenticated app shells are never shared-cacheable.
  return respond({ noStore: true });
}

export const config = {
  // #305: do NOT exclude approvals/review from the matcher — it bypassed the
  // middleware entirely, so the public approval review page got none of the
  // per-request nonce CSP / X-Frame-Options / noindex / no-store headers.
  // isPublicPath() already returns true for /approvals/review, so running the
  // middleware adds the headers WITHOUT auth-gating the public page.
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
