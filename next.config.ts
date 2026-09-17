import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // ⛔ The import service builds archive paths under data/ at runtime, and the tracer
  // follows those patterns: every server trace listed 630 ledger databases, backups
  // and statement files — a standalone or hosted build would have shipped the owner's
  // money. data/ is read from the working directory at runtime, never from the bundle.
  // ⚠️ This clears the 23 route traces only: Next applies it per route entry, and
  // .next/server/instrumentation.js.nft.json still lists 1,258 files under data/
  // (measured 2026-09-17). Hosting must make statementsRoot()'s path opaque to the
  // tracer, or exclude data/ from the deployed tree, before any standalone build ships.
  outputFileTracingExcludes: {
    "**": ["./data/**/*"],
  },
  experimental: {
    serverActions: {
      // statement batches: hundreds of PDFs in one drop
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
