import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    serverActions: {
      // statement batches: hundreds of PDFs in one drop
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
