import { NextResponse, type NextRequest } from "next/server";

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

function normalizeCookieValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decodeBase64Url(value: string): string | null {
  try {
    value = normalizeCookieValue(value);
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(normalized);
  } catch {
    return null;
  }
}

function hasUsableSession(raw: string | undefined): boolean {
  if (!raw) return false;
  const decoded = decodeBase64Url(raw);
  if (!decoded) return false;
  try {
    const payload = JSON.parse(decoded) as {
      access_token?: unknown;
      expires_at?: unknown;
      user_id?: unknown;
    };
    if (typeof payload.access_token !== "string" || !payload.access_token) return false;
    if (typeof payload.user_id !== "string" || !payload.user_id) return false;
    const expiresAt = Number(payload.expires_at);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > Math.floor(Date.now() / 1000) + 30;
  } catch {
    return false;
  }
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

export function middleware(req: NextRequest): NextResponse {
  if (isPublicPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const session = req.cookies.get(SESSION_COOKIE);
  const usableSession = hasUsableSession(session?.value);
  if (!usableSession) {
    const path = stripAppBase(req.nextUrl.pathname);
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${withAppBase(path)}${req.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico|approvals/review).*)"],
};
