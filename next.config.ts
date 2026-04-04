import type { NextConfig } from "next";

const convexSiteUrl =
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  (process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(".cloud", ".site") ||
  "https://different-fennec-225.convex.site";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/:path*",
          has: [{ type: "host", value: "floom.dev" }],
          destination: "/marketing/:path*",
        },
        {
          source: "/:path*",
          has: [{ type: "host", value: "www.floom.dev" }],
          destination: "/marketing/:path*",
        },
      ],
      fallback: [
        {
          source: "/api/:path*",
          destination: `${convexSiteUrl}/api/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
