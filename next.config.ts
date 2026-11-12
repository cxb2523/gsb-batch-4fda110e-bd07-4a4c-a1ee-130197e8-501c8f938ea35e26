import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from "next/constants";

import { config, validateConfig } from "./config";

const baseConfig: NextConfig = {
  logging: {
    // Dev logs every Server Function's arguments, and connection actions
    // receive API keys. Never print them.
    serverFunctions: false,
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Pinned to this folder so Turbopack never resolves or watches outside it.
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

/**
 * Validates OpenDashboards' configuration before Next.js uses this one. A throw here
 * stops `next dev`, `next build` and `next start` before anything is served
 * (a throw in instrumentation.ts only fails each request). Settings files are
 * checked in every phase; secrets only where a server starts.
 */
export default function nextConfig(phase: string): NextConfig {
  validateConfig({ withSecrets: phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_SERVER });
  // Behind the gateway, Server Actions arrive with the public host as their Origin.
  const { publicHost } = config().auth;
  if (!publicHost) return baseConfig;
  return { ...baseConfig, experimental: { ...baseConfig.experimental, serverActions: { allowedOrigins: [publicHost] } } };
}
