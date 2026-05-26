import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  env: {
    // Expose the API secret to the browser for same-app route calls.
    // This is a single-user self-hosted tool; the secret gates external
    // callers from using the app as a Composio oracle, not the user.
    NEXT_PUBLIC_WORKEROS_API_SECRET: process.env.WORKEROS_API_SECRET || process.env.FLOOM_API_SECRET || "",
  },
};

export default nextConfig;
