import type { NextConfig } from "next";

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
    ];
  },
};

export default nextConfig;
