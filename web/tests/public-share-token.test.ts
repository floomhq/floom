import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("public worker share page", () => {
  it("passes the signed share token into WorkerShareCard for authenticated imports", () => {
    const page = src("app/w/[id]/page.tsx");
    expect(page).toContain("const { token } = await searchParams");
    expect(page).toContain("<WorkerShareCard worker={worker} authed={authed} token={token} />");
  });
});
