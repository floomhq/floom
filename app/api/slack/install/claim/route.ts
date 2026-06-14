import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const upstream = await apiFetch("/slack/install/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { detail: text || "Slack claim failed" };
  }

  return NextResponse.json(payload, { status: upstream.status });
}
