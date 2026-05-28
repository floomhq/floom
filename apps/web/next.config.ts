import type { NextConfig } from "next";

// R13 HIGH-9: workers.floom.dev was missing 5 security headers the API
// already sets. CSP is intentionally NOT the API's `default-src 'none'`
// policy — that would break a Next.js app shell. Started from a pragmatic
// baseline and loosened only the directives Next's runtime needs:
//   - 'unsafe-inline' on style-src + script-src for Next inline bootstrap
//   - https: on script/style/connect/img/font for CDN-hosted assets if any
//   - blob: on worker-src + img-src for streaming + uploaded preview blobs
// Verify with: `curl -I https://workers.floom.dev/` and a browser console
// CSP-violation check after deploy.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' 'unsafe-inline' https:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
