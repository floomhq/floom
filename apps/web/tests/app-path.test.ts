import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAppPath(basePath?: string) {
  vi.resetModules();
  if (basePath) {
    process.env.NEXT_PUBLIC_BASE_PATH = basePath;
  } else {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  }
  return import("@/lib/app-path");
}

describe("appPath", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    vi.resetModules();
  });

  it("leaves OSS paths unprefixed", async () => {
    const { appPath } = await loadAppPath();

    expect(appPath("/workers?sel=w1")).toBe("/workers?sel=w1");
    expect(appPath("settings#slack")).toBe("/settings#slack");
  });

  it("prefixes cloud redirects with the /app base path", async () => {
    const { appPath } = await loadAppPath("/app");

    expect(appPath("/workers?sel=w1")).toBe("/app/workers?sel=w1");
    expect(appPath("settings#slack")).toBe("/app/settings#slack");
  });

  it("does not double-prefix paths that already include the base path", async () => {
    const { appPath } = await loadAppPath("/app");

    expect(appPath("/app/workers?sel=w1")).toBe("/app/workers?sel=w1");
    expect(appPath("/app")).toBe("/app");
  });
});
