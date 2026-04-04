import { readFile } from "fs/promises";
import { join } from "path";
import { NextRequest } from "next/server";

const DEFAULT_PLATFORM_URL = "https://dashboard.floom.dev";

export async function GET(request: NextRequest) {
  let content = await readFile(
    join(process.cwd(), "skill", "SKILL.md"),
    "utf-8"
  );

  // Replace hardcoded default with the actual serving origin so the skill
  // points to the right environment (prod vs local dev).
  const origin = new URL(request.url).origin;
  if (origin !== DEFAULT_PLATFORM_URL) {
    content = content.replaceAll(DEFAULT_PLATFORM_URL, origin);
  }

  return new Response(content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
