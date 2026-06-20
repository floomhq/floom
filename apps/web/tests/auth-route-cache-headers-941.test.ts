// #941 — authenticated JSON endpoints must never be shared-cacheable.
// Regression: every identity-bearing route sets private/no-store explicitly
// (Vercel applied `public, max-age=0, must-revalidate` when nothing was set).
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NO_STORE = "private, no-store, max-age=0";

function jsonUpstream(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#941 cache headers on authenticated JSON routes", () => {
  it("/api/me responds private no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonUpstream({ username: "u", role: "owner", scopes: ["*"] }),
    );
    const { GET } = await import("@/app/api/me/route");
    const res = await GET(new NextRequest("https://workers.floom.dev/api/me"));
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("/api/auth/login responds private no-store (multi-member path)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonUpstream());
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      }),
    );
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("/api/auth/logout responds private no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonUpstream());
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/logout", { method: "POST" }),
    );
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("/api/auth/setup GET + POST respond private no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonUpstream({ setup_required: false }));
    const { GET, POST } = await import("@/app/api/auth/setup/route");
    const g = await GET(new NextRequest("https://workers.floom.dev/api/auth/setup"));
    expect(g.headers.get("cache-control")).toBe(NO_STORE);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonUpstream());
    const p = await POST(
      new NextRequest("https://workers.floom.dev/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      }),
    );
    expect(p.headers.get("cache-control")).toBe(NO_STORE);
  });
});
