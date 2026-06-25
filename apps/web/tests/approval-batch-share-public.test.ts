import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("public approval batch share route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FLOOM_API_BASE;
    delete process.env.FLOOM_API_SECRET;
  });

  it("proxies decisions from /s without requiring the dashboard proxy", async () => {
    process.env.FLOOM_API_BASE = "https://workers-api.floom.dev";
    process.env.FLOOM_API_SECRET = "fake-test-secret-not-real";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "rejected", run_id: "run_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/s/[token]/items/[approvalId]/decision/route");

    const res = await POST(
      new NextRequest("https://floom.dev/s/fls_test/items/apr_1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected", reason: "No" }),
      }),
      { params: Promise.resolve({ token: "fls_test", approvalId: "apr_1" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workers-api.floom.dev/approvals/public-batch/fls_test/items/apr_1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "rejected", reason: "No" }),
      }),
    );
    // #1966 hardening: the public route must NOT forward the privileged secret upstream.
    const calledHeaders = (fetchMock.mock.calls[0][1] as { headers: Headers }).headers;
    expect(calledHeaders.get("x-floom-secret")).toBeNull();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "rejected", run_id: "run_1" });
  });

  it("fails public decisions closed when FLOOM_API_BASE is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { POST } = await import("@/app/s/[token]/items/[approvalId]/decision/route");

    const res = await POST(
      new NextRequest("https://floom.dev/s/fls_test/items/apr_1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      }),
      { params: Promise.resolve({ token: "fls_test", approvalId: "apr_1" }) },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      detail: "FLOOM_API_BASE is required for public approval decisions.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not forward FLOOM_API_SECRET from public share downloads", async () => {
    process.env.FLOOM_API_BASE = "https://workers-api.floom.dev/";
    process.env.FLOOM_API_SECRET = "fake-test-secret-not-real";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("download-body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { GET } = await import("@/app/s/[token]/download/route");

    const res = await GET(
      new NextRequest("https://floom.dev/s/fls_test/download"),
      { params: Promise.resolve({ token: "fls_test" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workers-api.floom.dev/s/fls_test/download",
      expect.objectContaining({ cache: "no-store" }),
    );
    const init = fetchMock.mock.calls[0][1] as { headers?: HeadersInit };
    expect(new Headers(init.headers).get("x-floom-secret")).toBeNull();
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("download-body");
  });

  it("fails public share downloads closed when FLOOM_API_BASE is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { GET } = await import("@/app/s/[token]/download/route");

    const res = await GET(
      new NextRequest("https://floom.dev/s/fls_test/download"),
      { params: Promise.resolve({ token: "fls_test" }) },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      detail: "FLOOM_API_BASE is required for public share downloads.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps minted /s links top-level when the hosted app uses basePath /app", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf-8");
    expect(config).toContain('source: "/s/:path*"');
    expect(config).toContain("destination: `${APP_BASE_PATH}/s/:path*`");
    expect(config).toContain("basePath: false");
  });

  it("does not call API_BASE directly from the logged-out share card", () => {
    const card = readFileSync(join(process.cwd(), "app/s/[token]/StandaloneShareCard.tsx"), "utf-8");
    expect(card).toContain("`/s/${encodeURIComponent(token)}/items/${encodeURIComponent(approvalId)}/decision`");
    expect(card).not.toContain("approvals/public-batch");
  });
});
