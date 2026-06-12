import type { NextConfig } from "next";

const CLOUD_DASHBOARD_URL = (
  process.env.CLOUD_DASHBOARD_URL || "https://web-iota-five-12.vercel.app"
).replace(/\/+$/, "");

const APP_ROUTES = [
  "overview",
  "workers",
  "runs",
  "assistant",
  "brain",
  "contexts",
  "approvals",
  "connections",
  "secrets",
  "settings",
  "members",
  "cli-auth",
] as const;

function cloudAppDestination(path: string): string {
  return `${CLOUD_DASHBOARD_URL}/app${path === "/" ? "" : path}`;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    return [
      // Rewrite bare /product, /docs, /about → /v3/* (no collision with existing routes)
      { source: "/product", destination: "/v3/product" },
      { source: "/docs", destination: "/v3/docs" },
      { source: "/about", destination: "/v3/about" },
      // NOTE: /templates is NOT rewritten — app/(marketing)/templates already owns that route
      { source: "/app", destination: cloudAppDestination("/") },
      { source: "/app/:path*", destination: cloudAppDestination("/:path*") },
      ...APP_ROUTES.flatMap((route) => [
        { source: `/${route}`, destination: cloudAppDestination(`/${route}`) },
        { source: `/${route}/:path*`, destination: cloudAppDestination(`/${route}/:path*`) },
      ]),
      { source: "/s/:path*", destination: cloudAppDestination("/s/:path*") },
    ];
  },
};

export default nextConfig;
