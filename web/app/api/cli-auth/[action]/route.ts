import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

// Cloud CLI auth approve/deny. Runs server-side so we can read the HttpOnly
// workeros_cloud_session cookie and forward it to the backend /auth/cli-approve
// or /auth/cli-deny endpoint. Replaces the OSS approach of pasting a shared
// FLOOM_SECRET into the page localStorage.

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

const SESSION_COOKIE = "workeros_cloud_session";

const ALLOWED_ACTIONS = new Set(["approve", "deny"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string }> }
) {
  const { action } = await params;
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({ detail: "Unknown action" }, { status: 404 });
  }

  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ detail: "Not signed in" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const upstreamUrl = `${API_BASE}/auth/cli-${action}`;
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Forward the session cookie so the backend's _session_user() can read it.
      cookie: `${SESSION_COOKIE}=${session}`,
    },
    body: JSON.stringify(body ?? {}),
  });

  const responseText = await upstream.text();
  const responseHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) responseHeaders.set("content-type", ct);
  return new NextResponse(responseText, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
