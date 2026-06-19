// #926 — nonce-based CSP replaces 'unsafe-inline' script-src.
// #945 — protected page shells must carry private/no-store cache headers and
//        must not opt into static/ISR rendering.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp } from "@/middleware";

// Fake fixture value, not a real credential. gitleaks:allow
const SECRET = "fake-test-secret-not-real";

async function validCookie(): Promise<string> {
  const { deriveSessionToken, SESSION_COOKIE } = await import("@/lib/web-session");
  const token = await deriveSessionToken();
  return `${SESSION_COOKIE}=${token}`;
}

function req(p: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`https://localhost:3000${p}`, { headers });
}

function directive(csp: string, name: string): string {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `) || s === name);
  return d ?? "";
}

describe("#926 buildCsp", () => {
  it("script-src carries a nonce + strict-dynamic, never unsafe-inline or broad https:", () => {
    const csp = buildCsp("abc123");
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toMatch(/\shttps:(\s|$)/);
  });

  it("connect-src is same-origin with no broad https:", () => {
    const connect = directive(buildCsp("n"), "connect-src");
    expect(connect).toBe("connect-src 'self'");
  });

  it("CSP_EXTRA_CONNECT_SRC extends connect-src for self-hosted cross-origin APIs", () => {
    process.env.CSP_EXTRA_CONNECT_SRC = "https://api.workeros.example.com";
    try {
      const connect = directive(buildCsp("n"), "connect-src");
      expect(connect).toBe("connect-src 'self' https://api.workeros.example.com");
    } finally {
      delete process.env.CSP_EXTRA_CONNECT_SRC;
    }
  });

  it("style-src keeps unsafe-inline (explicitly acceptable per audit) and keeps frame-ancestors none", () => {
    const csp = buildCsp("n");
    expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
  });
});

describe("#926/#945 middleware headers", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
  });

  it("authed app pages get nonce CSP + private no-store", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/connections/secrets", await validCookie()));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("every sensitive shell flagged by the audit is covered", async () => {
    const { middleware } = await import("@/middleware");
    const cookie = await validCookie();
    for (const p of ["/contexts", "/connections/secrets", "/brain", "/members", "/"]) {
      const res = await middleware(req(p, cookie));
      expect(res.headers.get("cache-control"), p).toBe("private, no-store, max-age=0");
    }
  });

  it("public login page gets CSP but is not forced no-store", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/login"));
    expect(res.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("share pages keep noindex + no-store", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/s/some-token"));
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("nonces are unique per request", async () => {
    const { middleware } = await import("@/middleware");
    const a = await middleware(req("/login"));
    const b = await middleware(req("/login"));
    const nonce = (r: Response) =>
      r.headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)![1];
    expect(nonce(a)).not.toBe(nonce(b));
  });
});

describe("#945 no page opts back into static/ISR rendering", () => {
  function pageFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...pageFiles(full));
      else if (/^(page|layout)\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("no app page/layout exports `revalidate` (ISR) — shells must stay dynamic", () => {
    const appDir = path.resolve(__dirname, "../app");
    const offenders = pageFiles(appDir).filter((f) =>
      /export const revalidate\s*=/.test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("root layout forces dynamic rendering (required by the CSP nonce)", () => {
    const layout = readFileSync(path.resolve(__dirname, "../app/layout.tsx"), "utf-8");
    expect(layout).toContain('export const dynamic = "force-dynamic"');
  });
});
