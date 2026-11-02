import type { NextConfig } from "next";

// The build's identity, baked into both the client bundle and the
// /api/version endpoint so an open tab can tell it is running an old bundle.
// Local builds and dev servers get a per-start id.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  `local-${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default nextConfig;
