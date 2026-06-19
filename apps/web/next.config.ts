import type { NextConfig } from "next";

// R13 HIGH-9: localhost:3000 was missing 5 security headers the API
// already sets. CSP is intentionally NOT the API's `default-src 'none'`
// policy — that would break a Next.js app shell. Started from a pragmatic
// baseline and loosened only the directives Next's runtime needs:
//   - 'unsafe-inline' on style-src + script-src for Next inline bootstrap
//   - https: on script/style/connect/img/font for CDN-hosted assets if any
//   - blob: on worker-src + img-src for streaming + uploaded preview blobs
//   - blob: on frame-src for authenticated PDF previews fetched through the
//     app proxy and rendered from object URLs
//   - blob: on media-src for authenticated video previews
// Verify with: `curl -I https://localhost:3000/` and a browser console
// CSP-violation check after deploy.
//
// #926 — CSP moved to middleware.ts. The policy needs a per-request nonce on
// script-src (no more 'unsafe-inline'), and a nonce can only be minted at
// request time. Keeping a second static CSP here would race the middleware
// header, so this file ships only the nonce-free security headers.
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
    "library",
    "contexts",
    "approvals",
    "connections",
    "integrations",
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
  // /workers/<id>/edit is gone; redirect bookmarks to the split-pane detail.
  async redirects() {
    return [
      ...cloudApexRedirects(),
      {
        source: "/workers/:id/edit",
        destination: "/workers?sel=:id&tab=Config",
        permanent: true,
      },
      // /brain renamed to /library (2026-06-16); the app/brain/page.tsx also
      // calls redirect("/library") as a belt-and-suspenders fallback for client
      // navigations (e.g. deep-links, internal hrefs that haven't been updated).
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
      // /integrations is the new user-facing name for /connections; redirect
      // inbound links and bookmarks to the canonical route (2026-06-17).
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
    ];
  },
  // Branded claim short-link: /c/:token is served by the FastAPI app (the
  // /c/{token} route lives on localhost:8000, NOT here). Proxy it so the
  // branded localhost:3000/c/:token also resolves. The upstream then 302s to
  // /settings?whatsapp_claim= | ?slack_claim= on this web app (auth-gated, which
  // is correct — only the short-link hop is public, via middleware below).
  async rewrites() {
    const apiBase = (
      process.env.FLOOM_API_BASE || "https://localhost:8000"
    ).replace(/\/$/, "");
    return [
      {
        source: "/c/:token",
        destination: `${apiBase}/c/:token`,
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
