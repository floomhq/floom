import { NextRequest, NextResponse } from "next/server";
import { forwardSecureSetCookies } from "@/lib/secure-set-cookie";

// PR S19 (I-1, I-6): draft-and-create makes up to 3 OpenAI calls with
// YAML retry. On hard prompts that's 30-60s. Default 10s Vercel timeout
// was returning empty 504 -> the UI showed an empty error toast.
export const maxDuration = 60;

const API_SECRET = process.env.FLOOM_API_SECRET || "";

function getApiBase(): string | null {
  const apiBase = process.env.FLOOM_API_BASE?.trim();
  return apiBase ? apiBase : null;
}

// #1044 — the upstream API can return a 3xx with an attacker-influenced
// `Location`. Forwarding it verbatim is an open redirect. Allow only:
//   - relative / same-app-origin locations (forwarded unchanged), and
//   - backend-origin locations (rewritten to a path relative to the app, so the
//     browser stays on the app origin — the intended shape for OAuth callbacks).
// Anything else (external host, protocol-relative //evil.com, scheme downgrade)
// is dropped so the redirect is neutralized.
function safeProxyLocation(
  location: string,
  requestUrl: string,
  apiBase: string | null,
): string | null {
  if (!location) return null;
  let appOrigin: string;
  try {
    appOrigin = new URL(requestUrl).origin;
  } catch {
    return null;
  }
  // Resolving against the app origin: a genuinely relative location resolves to
  // the app origin; a protocol-relative or absolute one resolves to its own host.
  let resolved: URL;
  try {
    resolved = new URL(location, appOrigin);
  } catch {
    return null;
  }
  if (resolved.origin === appOrigin) return location;
  let apiOrigin: string | null = null;
  if (apiBase) {
    try {
      apiOrigin = new URL(apiBase).origin;
    } catch {
      apiOrigin = null;
    }
  }
  if (apiOrigin && resolved.origin === apiOrigin) {
    return resolved.pathname + resolved.search + resolved.hash;
  }
  return null;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  // Preserve the raw encoded pathname. `params.path` can differ between local
  // Next and Vercel for filenames that intentionally contain percent-encoded
  // text (for example a stored literal `%20`), while nextUrl.pathname keeps the
  // request path shape the browser sent.
  const proxyMarker = "/api/proxy";
  const markerIndex = req.nextUrl.pathname.indexOf(proxyMarker);
  const upstreamPath =
    markerIndex >= 0
      ? req.nextUrl.pathname.slice(markerIndex + proxyMarker.length) || "/"
      : "/" + path.map(encodeURIComponent).join("/");

  const apiBase = getApiBase();
  if (!apiBase) {
    return new NextResponse(
      JSON.stringify({
        detail: "FLOOM_API_BASE is required for /api/proxy. Set it to the API origin for this deployment.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // Preserve query string
  const search = req.nextUrl.search;
  const upstreamUrl = `${apiBase}${upstreamPath}${search}`;
  const isConnectionCallback = upstreamPath === "/connections/callback";

  // Forward relevant request headers, injecting the secret
  const forwardHeaders: Record<string, string> = {
    "x-floom-secret": API_SECRET,
  };
  const activeWorkspace = req.headers.get("x-workeros-workspace");
  if (activeWorkspace) forwardHeaders["x-workeros-workspace"] = activeWorkspace;
  // Multi-member: forward the backend session cookie so per-user identity reaches the API
  const backendSession = req.cookies.get("wos_session")?.value;
  if (backendSession) {
    forwardHeaders["cookie"] = `wos_session=${backendSession}`;
  }
  const contentType = req.headers.get("content-type");
  if (contentType) forwardHeaders["content-type"] = contentType;
  const lastEventId = req.headers.get("last-event-id");
  if (lastEventId) forwardHeaders["last-event-id"] = lastEventId;
  const accept = req.headers.get("accept");
  if (accept) forwardHeaders["accept"] = accept;

  // Stream multipart uploads (no buffering in the Next function): the generic
  // /uploads route, X4 approval-scoped screenshot upload endpoints, and Brain
  // file uploads.
  const isUpload =
    upstreamPath === "/uploads" ||
    (/^\/approvals\/(public\/)?[^/]+\/uploads$/.test(upstreamPath.split("?")[0])) ||
    (upstreamPath.startsWith("/contexts/") && upstreamPath.endsWith("/upload"));
  let body: BodyInit | null | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = isUpload ? req.body : await req.arrayBuffer();
  }

  // #1182: always use redirect:"manual" so we inspect every Location header
  // before following it.  With redirect:"follow" the runtime silently follows
  // 3xx responses server-side and the final URL is never checked — an attacker-
  // controlled backend redirect to an internal host becomes an SSRF.
  // safeProxyLocation() (defined above) already strips or rewrites any Location
  // that doesn't resolve to the app or api origin, so this is the correct place
  // to enforce the policy for ALL requests (not just OAuth callbacks).
  const fetchOptions: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardHeaders,
    body: body ? body : undefined,
    redirect: "manual",
  };
  if (isUpload && body) {
    fetchOptions.duplex = "half";
  }

  // #586: wrap the upstream fetch so a refused connection (backend not running,
  // wrong port, network error) returns a 502 JSON response instead of letting
  // the unhandled fetch rejection bubble up as a Next.js 500 page. A 502 lets
  // client-side error handlers show a meaningful message rather than a blank
  // crash screen.
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, fetchOptions);
  } catch {
    return new NextResponse(
      JSON.stringify({ detail: "Could not reach the API server. Is the backend running?" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // Stream response back; preserves binary content (artifacts, etc.)
  const responseHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) responseHeaders.set("content-type", ct);
  const cd = upstream.headers.get("content-disposition");
  if (cd) responseHeaders.set("content-disposition", cd);
  const cl = upstream.headers.get("content-length");
  if (cl) responseHeaders.set("content-length", cl);
  // #941: every proxied response is authenticated user data — never let a
  // shared/intermediary cache store it. Upstream may tighten, never loosen.
  const cacheControl = upstream.headers.get("cache-control");
  responseHeaders.set(
    "cache-control",
    cacheControl && /no-store|private/i.test(cacheControl)
      ? cacheControl
      : "private, no-store, max-age=0",
  );
  const location = upstream.headers.get("location");
  if (location) {
    const safeLocation = safeProxyLocation(location, req.url, apiBase);
    if (safeLocation) responseHeaders.set("location", safeLocation);
  }
  // #927: force Secure on any backend cookie we hand to the browser
  forwardSecureSetCookies(upstream, responseHeaders);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, context: RouteContext) {
  return handler(req, context);
}

export async function POST(req: NextRequest, context: RouteContext) {
  return handler(req, context);
}

export async function PUT(req: NextRequest, context: RouteContext) {
  return handler(req, context);
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return handler(req, context);
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return handler(req, context);
}
