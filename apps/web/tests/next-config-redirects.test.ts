import { afterEach, describe, expect, it, vi } from "vitest";

async function loadRedirects(basePath?: string) {
  vi.resetModules();
  if (basePath) {
    process.env.NEXT_PUBLIC_BASE_PATH = basePath;
  } else {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  }
  const config = (await import("../next.config")).default;
  return config.redirects ? config.redirects() : [];
}

describe("next.config redirects", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    vi.resetModules();
  });

  it("keeps the OSS build free of Cloud apex redirects", async () => {
    const redirects = await loadRedirects();

    // R9: /brain renamed to /library — two permanent redirects added to OSS
    // so bookmarks and old deep-links still resolve.
    expect(redirects).toEqual([
      {
        source: "/workers/:id/edit",
        destination: "/workers?sel=:id&tab=Config",
        permanent: true,
      },
      {
        source: "/brain",
        destination: "/library",
        permanent: true,
      },
      {
        source: "/brain/:path*",
        destination: "/library/:path*",
        permanent: true,
      },
      {
        source: "/integrations",
        destination: "/connections",
        permanent: false,
      },
      {
        source: "/integrations/:path*",
        destination: "/connections/:path*",
        permanent: false,
      },
    ]);
  });

  it("maps bare dashboard paths into the Cloud /app basePath", async () => {
    const redirects = await loadRedirects("/app");

    expect(redirects).toContainEqual({
      source: "/connections",
      destination: "/app/connections",
      permanent: false,
      basePath: false,
    });
    expect(redirects).toContainEqual({
      source: "/connections/:path*",
      destination: "/app/connections/:path*",
      permanent: false,
      basePath: false,
    });
    // /integrations is the user-facing rename of /connections; the bare apex
    // path must map into the Cloud /app basePath too, then /app/integrations
    // redirects to /app/connections (the canonical route stays /connections).
    expect(redirects).toContainEqual({
      source: "/integrations",
      destination: "/app/integrations",
      permanent: false,
      basePath: false,
    });
    expect(redirects).toContainEqual({
      source: "/assistant",
      destination: "/app/assistant",
      permanent: false,
      basePath: false,
    });
    expect(redirects).toContainEqual({
      source: "/workers/:path*",
      destination: "/app/workers/:path*",
      permanent: false,
      basePath: false,
    });
  });
});
