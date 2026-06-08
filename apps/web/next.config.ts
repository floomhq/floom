import type { NextConfig } from "next";

// R13 HIGH-9: workers.floom.dev was missing 5 security headers the API
// already sets. CSP is intentionally NOT the API's `default-src 'none'`
// policy — that would break a Next.js app shell. Started from a pragmatic
// baseline and loosened only the directives Next's runtime needs:
//   - 'unsafe-inline' on style-src + script-src for Next inline bootstrap
//   - https: on script/style/connect/img/font for CDN-hosted assets if any
//   - blob: on worker-src + img-src for streaming + uploaded preview blobs
//   - blob: on frame-src for authenticated PDF previews fetched through the
//     app proxy and rendered from object URLs
//   - blob: on media-src for authenticated video previews
// Verify with: `curl -I https://workers.floom.dev/` and a browser console
// CSP-violation check after deploy.
//
// R17 FIX 2 (LOW) — `script-src 'unsafe-inline'` is a known defense-in-depth
// weakness. It is DELIBERATELY LEFT for now, not an oversight:
// Next.js 16 app-router emits inline bootstrap/flight scripts that only get a
// CSP nonce when the header is produced per-request from `middleware.ts`. This
// app ships no middleware and relies on static/ISR rendering; adding a nonce
// middleware forces every route to dynamic rendering and risks hydration
// regressions — too much risk for a LOW finding on a single-tenant OS.
// TODO(cloud-ga): before the multi-tenant Cloud serves untrusted-tenant
// content, replace 'unsafe-inline' on script-src with a per-request nonce
// (middleware.ts + nonce threaded to next/script + headers), or 'strict-dynamic'
// with hashes, and verify hydration + streaming still work. style-src keeps
// 'unsafe-inline' (style injection is far lower risk; Next/Tailwind need it).
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
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

const APP_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
type RedirectRule = Awaited<ReturnType<NonNullable<NextConfig["redirects"]>>>[number];

function cloudApexRedirects(): RedirectRule[] {
  if (!APP_BASE_PATH) return [];

  const appPathRules = [
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
    "install",
    "invite",
  ];

  return appPathRules.flatMap((path) => [
    {
      source: `/${path}`,
      destination: `${APP_BASE_PATH}/${path}`,
      permanent: false as const,
      basePath: false as const,
    },
    {
      source: `/${path}/:path*`,
      destination: `${APP_BASE_PATH}/${path}/:path*`,
      permanent: false as const,
      basePath: false as const,
    },
  ]);
}

const nextConfig: NextConfig = {
  // basePath seam: unset for the single-tenant OSS build (served at "/").
  // The Downstream host serves the dashboard under "/app" and sets
  // NEXT_PUBLIC_BASE_PATH="/app" so this file is consumed unmodified (no fork).
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  turbopack: {
    root: __dirname,
  },
  // S42: /workers/<id>/edit is gone; redirect bookmarks to the unified detail
  // page with edit mode toggled on via ?edit=1.
  async redirects() {
    return [
      ...cloudApexRedirects(),
      {
        source: "/workers/:id/edit",
        destination: "/workers/:id?edit=1",
        permanent: true,
      },
    ];
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
