import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dashboard is served under /app/* on workeros.floom.dev (the marketing
  // project rewrites /app/(.*) to this deployment). basePath ensures
  // assets, links, and routing all live under /app, so Next.js's
  // generated /_next/* paths are served at /app/_next/* and match the
  // rewrite.
  basePath: "/app",
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
