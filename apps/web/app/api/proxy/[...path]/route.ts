import { NextRequest, NextResponse } from "next/server";

const API_BASE =
  process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const upstreamPath = "/" + path.join("/");

  // Preserve query string
  const search = req.nextUrl.search;
  const upstreamUrl = `${API_BASE}${upstreamPath}${search}`;

  // Forward relevant request headers, injecting the secret
  const forwardHeaders: Record<string, string> = {
    "x-floom-secret": API_SECRET,
  };
  const contentType = req.headers.get("content-type");
  if (contentType) forwardHeaders["content-type"] = contentType;

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.arrayBuffer()
      : undefined;

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers: forwardHeaders,
    body: body ? body : undefined,
  });

  // Stream response back — preserves binary content (artifacts, etc.)
  const responseHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) responseHeaders.set("content-type", ct);
  const cd = upstream.headers.get("content-disposition");
  if (cd) responseHeaders.set("content-disposition", cd);
  const cl = upstream.headers.get("content-length");
  if (cl) responseHeaders.set("content-length", cl);

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
