import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("build identity routes", () => {
  it("exposes landing build identity from deploy env", () => {
    const route = read("app/version/route.ts");

    expect(route).toContain('service: "cloud-landing"');
    expect(route).toContain("NEXT_PUBLIC_BUILD_SHA");
    expect(route).toContain("VERCEL_GIT_COMMIT_SHA");
    expect(route).toContain("build_ref");
    expect(route).toContain("build_time");
  });

  it("exposes dashboard build identity through the cloud overlay", () => {
    const route = read("web/overlay/app/version/route.ts");
    const sync = read("web/scripts/sync-engine-web.mjs");

    expect(route).toContain('service: "cloud-dashboard"');
    expect(route).toContain("NEXT_PUBLIC_BUILD_SHA");
    expect(route).toContain("VERCEL_GIT_COMMIT_SHA");
    expect(sync).toContain('"app/version/route.ts"');
  });
});
