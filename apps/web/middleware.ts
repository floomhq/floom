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

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/web-session";

// Pages reachable WITHOUT a session cookie. Exact path or prefix match.
const PUBLIC_PAGE_PREFIXES = [
  "/login",
  "/connections/callback", // OAuth provider return path; finishes via tokenless callback id
  "/approvals/review", // external signed-link approval review
  "/w/", // public worker share (token-gated, server-rendered)
  "/s/", // public standalone share (token-gated, server-rendered)
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const withNoindex = (response: NextResponse) => {
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
    return withNoindex(NextResponse.next());
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await verifySessionToken(token) ||
    // Multi-member: a wos_session backend cookie is also valid — the backend validates it
    Boolean(req.cookies.get("wos_session")?.value);

  // ----- /api/proxy/* : the dangerous surface -----
  if (pathname.startsWith("/api/proxy")) {
    if (isPublicProxy(pathname)) {
      // Public, token-gated upstream endpoint (signed-link approvals). Allow.
      return withNoindex(NextResponse.next());
    }
    if (authed) {
      return withNoindex(NextResponse.next());
    }
    return NextResponse.json(
      { detail: "Authentication required." },
      { status: 401 },
    );
  }

  // ----- App pages -----
  if (isPublicPage(pathname)) {
    return withNoindex(NextResponse.next());
  }
  if (authed) {
    return withNoindex(NextResponse.next());
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
