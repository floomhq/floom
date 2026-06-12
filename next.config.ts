import type { NextConfig } from "next";

const APP_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://workers.floom.dev").replace(/\/+$/, "");

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

function appDestination(path: string): string {
  return `${APP_BASE_URL}${path}`;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      { source: "/app", destination: appDestination("/"), permanent: false },
      ...APP_ROUTES.flatMap((route) => [
        { source: `/${route}`, destination: appDestination(`/${route}`), permanent: false },
        { source: `/${route}/:path*`, destination: appDestination(`/${route}/:path*`), permanent: false },
        { source: `/app/${route}`, destination: appDestination(`/${route}`), permanent: false },
        { source: `/app/${route}/:path*`, destination: appDestination(`/${route}/:path*`), permanent: false },
      ]),
    ];
  },
  async rewrites() {
    return [
      // Rewrite bare /product, /docs, /about → /v3/* (no collision with existing routes)
      { source: "/product", destination: "/v3/product" },
      { source: "/docs", destination: "/v3/docs" },
      { source: "/about", destination: "/v3/about" },
      // NOTE: /templates is NOT rewritten — app/(marketing)/templates already owns that route
      { source: "/s/:path*", destination: appDestination("/s/:path*") },
    ];
  },
};

export default nextConfig;
