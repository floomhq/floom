import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

// PR S19 (I-1, I-6): draft-and-create makes up to 3 OpenAI calls with
// YAML retry. On hard prompts that's 30-60s. Default 10s Vercel timeout
// was returning empty 504 -> the UI showed an empty error toast.
export const maxDuration = 60;

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

const SESSION_COOKIE = "workeros_cloud_session";
const PROXY_PREFIX = "/api/proxy";

function normalizeCookieValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decodeBase64Url(value: string): string {
  value = normalizeCookieValue(value);
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

async function getAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(raw)) as { access_token?: string };
    return payload.access_token ?? null;
  } catch {
    return null;
  }
}

function safeProxyLocation(location: string | null, req: NextRequest): string | null {
  if (!location) return null;
  let parsed: URL;
  let apiBase: URL;
  try {
    apiBase = new URL(API_BASE);
    parsed = new URL(location, apiBase);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.origin === req.nextUrl.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  if (parsed.origin !== apiBase.origin) {
    return null;
  }

  let upstreamPath = parsed.pathname;
  if (upstreamPath === "/api") {
    upstreamPath = "/";
  } else if (upstreamPath.startsWith("/api/")) {
    upstreamPath = upstreamPath.slice(4);
  }
  return `${PROXY_PREFIX}${upstreamPath}${parsed.search}${parsed.hash}`;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  // workeros-cloud: backend mounts the auth router at the root (/auth/*),
  // NOT under /api/. We expose those through the same proxy so the frontend
  // never has to know the absolute backend host. /auth/logout (the only
  // current consumer) reads the session cookie directly on the backend, so
  // we skip the JWT-required guard for those paths.
  const isAuthPath = path[0] === "auth";
  const isSignedApprovalPath = path[0] === "approvals" && path[1] === "public";
  // Preserve the raw encoded pathname for file routes. `params.path` can
  // normalize already-encoded filenames differently between local Next and
  // Vercel, which breaks files that intentionally contain `%20`.
  const proxyMarker = "/api/proxy";
  const markerIndex = req.nextUrl.pathname.indexOf(proxyMarker);
  const rawProxyPath =
    markerIndex >= 0
      ? req.nextUrl.pathname.slice(markerIndex + proxyMarker.length) || "/"
      : "/" + path.map(encodeURIComponent).join("/");
  const upstreamPath = isAuthPath ? rawProxyPath : `/api${rawProxyPath}`;

  // workeros-cloud auth swap: replace shared-secret x-floom-secret with
  // a Supabase JWT extracted from the workeros_cloud_session cookie that
  // the backend's /auth/callback sets on .floom.dev (HttpOnly, Secure).
  // If the cookie is missing, return 401 so the frontend can route to
  // /login (the marketing project handles that).
  const accessToken = await getAccessToken();
  if (!isAuthPath && !isSignedApprovalPath && !accessToken) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  // Preserve query string
  const search = req.nextUrl.search;
  const upstreamUrl = `${API_BASE}${upstreamPath}${search}`;

  // Forward relevant request headers, injecting the JWT as Bearer when
  // available. For auth-path requests we also forward the raw Cookie header
  // so the backend can read its own workeros_cloud_session cookie.
  const forwardHeaders: Record<string, string> = {};
  if (accessToken) {
    forwardHeaders.Authorization = `Bearer ${accessToken}`;
  }
  if (isAuthPath) {
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) forwardHeaders.cookie = cookieHeader;
  }
  // Forward the active-workspace selection on EVERY request (not just auth
  // paths) as the x-workeros-workspace header the backend already honors.
  // Without this, workspace-scoped data paths (/workers, /runs, /connections,
  // /contexts, /system/overview, ...) never saw the cookie and silently fell
  // back to the user's default workspace — i.e. the workspace switcher did
  // nothing in the deployed dashboard. Backend validates ownership, so this
  // cannot be used to scope into another user's workspace.
  const activeWorkspace =
    req.headers.get("x-workeros-workspace")?.trim() ||
    req.nextUrl.searchParams.get("workspace_id")?.trim() ||
    req.cookies.get("workeros_active_workspace")?.value;
  if (activeWorkspace) forwardHeaders["x-workeros-workspace"] = activeWorkspace;
  const contentType = req.headers.get("content-type");
  if (contentType) forwardHeaders["content-type"] = contentType;
  const lastEventId = req.headers.get("last-event-id");
  if (lastEventId) forwardHeaders["last-event-id"] = lastEventId;
  const accept = req.headers.get("accept");
  if (accept) forwardHeaders["accept"] = accept;

  const isUpload = upstreamPath === "/api/uploads";
  let body: BodyInit | null | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = isUpload ? req.body : await req.arrayBuffer();
  }

  const fetchOptions: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardHeaders,
    body: body ? body : undefined,
    // Do NOT follow redirects server-side. The OAuth flow (/auth/login -> Supabase
    // -> Google) is a chain of 3xx redirects that the BROWSER must navigate so the
    // user lands on accounts.google.com. With the default "follow", fetch chases
    // the whole chain here and returns Google's sign-in HTML with status 200, which
    // the browser then renders AT this proxy path — Google's relative links (e.g.
    // /v3/signin/identifier) resolve against our host and 404. "manual" passes the
    // 307 + Location straight back so the browser does the navigation.
    redirect: "manual",
  };
  if (isUpload && body) {
    fetchOptions.duplex = "half";
  }

  const upstream = await fetch(upstreamUrl, fetchOptions);

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
  const safeLocation = safeProxyLocation(location, req);
  if (safeLocation) responseHeaders.set("location", safeLocation);
  // Forward Set-Cookie so backend-initiated cookie writes (e.g. /auth/logout
  // clearing workeros_cloud_session on .floom.dev) actually reach the browser.
  // Vercel's route runtime does not consistently expose the Node/undici
  // getSetCookie() extension on Headers, so guard it. Without this guard,
  // successful upstream API calls crashed here and returned a proxy 500.
  const getSetCookie = (upstream.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const cookie of getSetCookie.call(upstream.headers)) {
      responseHeaders.append("set-cookie", cookie);
    }
  } else {
    const cookie = upstream.headers.get("set-cookie");
    if (cookie) responseHeaders.append("set-cookie", cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
