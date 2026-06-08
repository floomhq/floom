import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, parseCurrentUser } from "../../lib/me";

export async function GET() {
  const cookieStore = await cookies();
  const user = parseCurrentUser(cookieStore.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ user }, { status: 200 });
}
