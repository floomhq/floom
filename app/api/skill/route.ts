import { readFile } from "fs/promises";
import { join } from "path";

export async function GET() {
  const content = await readFile(
    join(process.cwd(), "skill", "SKILL.md"),
    "utf-8"
  );
  return new Response(content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
