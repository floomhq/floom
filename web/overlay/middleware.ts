import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "workeros_cloud_session";

function decodeBase64Url(value: string): string | null {
  try {
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
  const path = pathname.startsWith("/app") ? pathname.slice(4) || "/" : pathname;
  if (path === "/favicon.ico") return true;
  if (path === "/privacy" || path === "/terms") return true;
  if (path === "/approvals/review") return true;
  if (path.startsWith("/_next/")) return true;
  if (path.startsWith("/api/proxy/")) return true;
  if (path === "/api/me") return true;
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  if (isPublicPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const session = req.cookies.get(SESSION_COOKIE);
  if (!hasUsableSession(session?.value)) {
    const path = req.nextUrl.pathname.startsWith("/app")
      ? req.nextUrl.pathname.slice(4) || "/"
      : req.nextUrl.pathname;
    const next = encodeURIComponent(`/app${path === "/" ? "" : path}${req.nextUrl.search}`);
    return NextResponse.redirect(new URL(`/login?next=${next}`, req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|approvals/review).*)"],
};
