import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Single source of truth for environment: load the repo-root .env (the same
// file the ingestion worker uses) before anything reads process.env. The web
// app runs from web/, so ../.env points at the repo root.
loadEnv({ path: resolve(process.cwd(), "../.env") });

const nextConfig: NextConfig = {
  // The shared data layer lives in ../src, so the file-tracing root is the repo
  // root (not web/). Also silences Next's multi-lockfile root inference warning.
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  experimental: {
    // The web app reuses the worker's data-access layer in ../src (outside web/).
    externalDir: true,
  },
  // Used by the shared db layer + auth; keep them as runtime Node deps, don't bundle.
  serverExternalPackages: ["pg", "pino", "better-auth"],
  // Use webpack (this config function) instead of the default Turbopack, so we
  // can map the worker's NodeNext ".js" import specifiers to their ".ts" sources.
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
