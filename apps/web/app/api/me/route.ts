import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

async function handler(req: NextRequest) {
  const headers: Record<string, string> = {};
  if (API_SECRET) headers["x-floom-secret"] = API_SECRET;

  const authorization = req.headers.get("authorization");
  if (authorization) headers.authorization = authorization;
  const cookie = req.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  const workspace = req.headers.get("x-workeros-workspace");
  if (workspace) headers["x-workeros-workspace"] = workspace;

  const upstream = await fetch(`${API_BASE}/me`, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  // #941: identity/role/scope JSON must never land in a shared cache.
  responseHeaders.set("cache-control", "private, no-store, max-age=0");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
