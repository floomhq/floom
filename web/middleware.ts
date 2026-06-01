import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "workeros_cloud_session";

function isPublicPath(pathname: string): boolean {
  // Next.js with basePath strips it before passing to middleware in matcher,
  // but path here can be either /workers OR /app/workers depending on the
  // routing context. Handle both.
  const path = pathname.startsWith("/app") ? pathname.slice(4) || "/" : pathname;
  if (path === "/favicon.ico") return true;
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
  if (!session?.value) {
    const path = req.nextUrl.pathname.startsWith("/app")
      ? req.nextUrl.pathname.slice(4) || "/"
      : req.nextUrl.pathname;
    const next = encodeURIComponent(`/app${path === "/" ? "" : path}${req.nextUrl.search}`);
    return NextResponse.redirect(new URL(`/login?next=${next}`, req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
