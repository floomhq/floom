// #927 — wos_session forwarded without Secure; #941 — authenticated responses
// must never carry a cacheable policy through the proxy.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getSetCookies, withSecureFlag } from "@/lib/secure-set-cookie";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  Reflect.set(process.env, "NODE_ENV", "production");
});

afterAll(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", ORIGINAL_NODE_ENV);
  }
});

describe("#927 withSecureFlag", () => {
  it("appends Secure when missing", () => {
    expect(withSecureFlag("wos_session=abc; Path=/; HttpOnly; SameSite=lax")).toBe(
      "wos_session=abc; Path=/; HttpOnly; SameSite=lax; Secure",
    );
  });

  it("is idempotent when Secure already present (any casing)", () => {
    const c = "workeros_session=x; Path=/; Secure; HttpOnly; SameSite=lax";
    expect(withSecureFlag(c)).toBe(c);
    const lower = "a=b; path=/; secure";
    expect(withSecureFlag(lower)).toBe(lower);
  });

  it("does not treat a cookie VALUE containing 'secure' as the flag", () => {
    expect(withSecureFlag("note=insecure-data; Path=/")).toBe(
      "note=insecure-data; Path=/; Secure",
    );
  });

  it("getSetCookies returns each cookie individually", () => {
    const res = new Response(null, { status: 200 });
    res.headers.append("set-cookie", "a=1; Path=/");
    res.headers.append("set-cookie", "b=2; Path=/; Secure");
    expect(getSetCookies(res)).toEqual(["a=1; Path=/", "b=2; Path=/; Secure"]);
  });
});

describe("#927/#941 proxy route hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FLOOM_API_BASE;
  });

  function proxyReq() {
    return [
      new NextRequest("https://localhost:3000/api/proxy/me"),
      { params: Promise.resolve({ path: ["me"] }) },
    ] as const;
  }

  it("adds Secure to backend cookies missing it", async () => {
    process.env.FLOOM_API_BASE = "https://localhost:8000";
    const upstream = new Response("{}", { status: 200 });
    upstream.headers.append(
      "set-cookie",
      "wos_session=tok; Path=/; HttpOnly; SameSite=lax",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(...proxyReq());
    expect(res.headers.get("set-cookie")).toBe(
      "wos_session=tok; Path=/; HttpOnly; SameSite=lax; Secure",
    );
  });

  it("defaults cache-control to private no-store when upstream is silent", async () => {
    process.env.FLOOM_API_BASE = "https://localhost:8000";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(...proxyReq());
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("replaces a public upstream cache policy with private no-store", async () => {
    process.env.FLOOM_API_BASE = "https://localhost:8000";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "cache-control": "public, max-age=0, must-revalidate" },
      }),
    );
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(...proxyReq());
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("keeps an upstream policy that is already private/no-store", async () => {
    process.env.FLOOM_API_BASE = "https://localhost:8000";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "cache-control": "no-store" },
      }),
    );
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(...proxyReq());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("#927 auth routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("login forwards backend wos_session with Secure forced", async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), { status: 200 });
    upstream.headers.append(
      "set-cookie",
      "wos_session=tok; Path=/; HttpOnly; SameSite=lax",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const { POST } = await import("@/app/api/auth/login/route");

    const res = await POST(
      new NextRequest("https://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      }),
    );
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("logout clears wos_session with Secure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/auth/logout/route");

    const res = await POST(
      new NextRequest("https://localhost:3000/api/auth/logout", { method: "POST" }),
    );
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const wos = cookies.find((c) => c.startsWith("wos_session="));
    expect(wos).toBeDefined();
    expect(wos).toMatch(/;\s*secure/i);
  });

  it("setup forwards backend cookie with Secure forced", async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), { status: 200 });
    upstream.headers.append(
      "set-cookie",
      "wos_session=tok; Path=/; HttpOnly; SameSite=lax",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const { POST } = await import("@/app/api/auth/setup/route");

    const res = await POST(
      new NextRequest("https://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      }),
    );
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});
