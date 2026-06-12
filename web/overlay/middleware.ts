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

  if (isPublicPath(req.nextUrl.pathname)) {
    return respond();
  }
  const session = req.cookies.get(SESSION_COOKIE);
  const verified = await verifySession(session?.value);
  if (!verified) {
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
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico|approvals/review).*)"],
};
