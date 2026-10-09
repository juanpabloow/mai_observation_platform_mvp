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
  // PUBLIC booking surfaces only (audited: no other security headers are set anywhere
  // — no CSP, no middleware headers). Deliberately NOT a global CSP: Next's inline
  // runtime and the Turnstile iframe (challenges.cloudflare.com) need a nonce-based
  // policy designed and tested on its own. Permissions-Policy only switches off
  // capabilities the booking flow never uses; Turnstile needs none of them.
  // The /api/booking handlers set nosniff + Referrer-Policy + no-store THEMSELVES
  // (web/lib/publicBookingApi.ts), so here they only get Permissions-Policy — no
  // header is ever sent twice.
  async headers() {
    const permissions = {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    };
    return [
      {
        source: "/book/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          permissions,
        ],
      },
      { source: "/api/booking/:path*", headers: [permissions] },
    ];
  },
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
