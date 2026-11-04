import type { NextConfig } from "next";

// The build's identity, baked into both the client bundle and the
// /api/version endpoint so an open tab can tell it is running an old bundle.
// Local builds and dev servers get a per-start id.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  `local-${Date.now().toString(36)}`;

// Security headers on every route. No full Content-Security-Policy yet, only
// frame-ancestors: a full policy needs the Convex
// URLs in connect-src and a nonce or hash for Next's inline scripts.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
