// PR S19 (I-4): expose the FLOOM_API_SECRET to the authenticated front-end
// so the API access tab in Settings can show "Your token" with reveal/copy.
//
// Single-user v0 design: anyone visiting workers.floom.dev IS Federico.
// The Vercel deployment already trusts whoever reaches it. Exposing the
// secret to the browser is acceptable until multi-user lands.

import { NextResponse } from "next/server";

export async function GET() {
  const secret = process.env.FLOOM_API_SECRET || "";
  if (!secret) {
    return NextResponse.json(
      { error: "FLOOM_API_SECRET not configured on the deployment" },
      { status: 500 },
    );
  }
  return NextResponse.json({ api_secret: secret });
}
