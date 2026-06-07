import { NextRequest, NextResponse } from "next/server";

// PR S19 (I-1, I-6): draft-and-create makes up to 3 OpenAI calls with
// YAML retry. On hard prompts that's 30-60s. Default 10s Vercel timeout
// was returning empty 504 -> the UI showed an empty error toast.
export const maxDuration = 60;

const API_BASE =
  process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

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

  // Preserve query string
  const search = req.nextUrl.search;
  const upstreamUrl = `${API_BASE}${upstreamPath}${search}`;
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

  const fetchOptions: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardHeaders,
    body: body ? body : undefined,
    redirect: isConnectionCallback ? "manual" : "follow",
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
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) responseHeaders.set("cache-control", cacheControl);
  const location = upstream.headers.get("location");
  if (location) responseHeaders.set("location", location);
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) responseHeaders.set("set-cookie", setCookie);

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
