import { afterEach, describe, expect, it, vi } from "vitest";

describe("file upload endpoint", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_API_PROXY_BASE;
    vi.resetModules();
  });

  it("derives the XHR upload URL from the shared API proxy base", async () => {
    process.env.NEXT_PUBLIC_API_PROXY_BASE = "/app/api/proxy";

    const { uploadEndpointPath } = await import("@/components/FileInputUpload");

    expect(uploadEndpointPath()).toBe("/app/api/proxy/uploads");
  });
});
